import { useCallback, useMemo, useRef } from 'react';
import { deleteField, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import toast from 'react-hot-toast';
import { db } from '../firebase';
import type { Order, OrderStatus } from '../types';
import { useAuth } from '../context/AuthContext';
import { STATUS_LABEL } from '../lib/orderStatus';
import { orderCode } from '../lib/ids';
import { formatMoney } from '../lib/money';
import { friendlyError, reportError } from '../utils/errorHandling';
import { undoToast } from '../lib/undoToast';

/** A second tap on the same ticket within this window is treated as an accidental double tap. */
const DOUBLE_TAP_MS = 700;
/**
 * Staff actions on orders. Status changes and cash payments are written directly to
 * Firestore (security rules allow exactly these fields); cancellations and refunds go
 * through the server so card payments are refunded.
 *
 * Built for a busy line: every tap can be undone for a few seconds, and an accidental
 * double tap does not push a ticket two steps forward.
 */
export function useOrderActions() {
  const { userProfile } = useAuth();
  const staffName = (userProfile?.name || userProfile?.email || 'Staff').slice(0, 100);
  const lastTap = useRef(new Map<string, number>());

  /** True when this order was acted on a moment ago (ignore the repeat). */
  const isRepeatTap = (orderId: string) => {
    const now = Date.now();
    const previous = lastTap.current.get(orderId) || 0;
    if (now - previous < DOUBLE_TAP_MS) return true;
    lastTap.current.set(orderId, now);
    if (lastTap.current.size > 200) lastTap.current.clear();
    return false;
  };

  const writeStatus = useCallback(async (order: Order, status: OrderStatus) => {
    await updateDoc(doc(db, 'orders', order.id), { status, updatedAt: serverTimestamp() });
  }, []);

  const setStatus = useCallback(
    async (order: Order, status: OrderStatus) => {
      if (isRepeatTap(order.id)) return;
      const previous = order.status;
      // Shown right away (not after the write is confirmed) so it also works on a weak
      // connection, where the change is applied locally and synced when possible.
      undoToast(`status-${order.id}`, `#${orderCode(order)} → ${STATUS_LABEL[status]}`, () => {
        writeStatus(order, previous)
          .then(() => toast.success(`#${orderCode(order)} back to ${STATUS_LABEL[previous]}`, { id: `status-${order.id}` }))
          .catch((err) => reportError(err, 'order-status-undo', { message: friendlyError(err, 'Could not undo the change.') }));
      });
      try {
        await writeStatus(order, status);
      } catch (err) {
        toast.dismiss(`status-${order.id}`);
        reportError(err, 'order-status', { message: friendlyError(err, 'Could not update the order.') });
      }
    },
    [writeStatus],
  );

  const markCashPaid = useCallback(
    async (order: Order, complete = false) => {
      if (isRepeatTap(order.id)) return;
      const previous = order.status;
      try {
        await updateDoc(doc(db, 'orders', order.id), {
          paymentStatus: 'paid',
          paidAt: serverTimestamp(),
          paymentCollectedBy: staffName,
          ...(complete ? { status: 'completed' } : {}),
          updatedAt: serverTimestamp(),
        });
        undoToast(`cash-${order.id}`, `${formatMoney(order.total)} cash recorded for #${orderCode(order)}`, () => {
          updateDoc(doc(db, 'orders', order.id), {
            paymentStatus: 'pending',
            paidAt: deleteField(),
            paymentCollectedBy: deleteField(),
            ...(complete ? { status: previous } : {}),
            updatedAt: serverTimestamp(),
          })
            .then(() => toast.success(`Cash payment removed for #${orderCode(order)}`, { id: `cash-${order.id}` }))
            .catch((err) => reportError(err, 'cash-undo', { message: friendlyError(err, 'Could not undo the payment.') }));
        });
      } catch (err) {
        reportError(err, 'cash-paid', { message: friendlyError(err, 'Could not record the payment.') });
      }
    },
    [staffName],
  );

  const undoCashPaid = useCallback(async (order: Order) => {
    try {
      await updateDoc(doc(db, 'orders', order.id), {
        paymentStatus: 'pending',
        paidAt: deleteField(),
        paymentCollectedBy: deleteField(),
        updatedAt: serverTimestamp(),
      });
      toast.success(`Cash payment removed for #${orderCode(order)}`);
    } catch (err) {
      reportError(err, 'cash-undo', { message: friendlyError(err, 'Could not update the payment.') });
    }
  }, []);

  return useMemo(() => ({ setStatus, markCashPaid, undoCashPaid, staffName }), [setStatus, markCashPaid, undoCashPaid, staffName]);
}
