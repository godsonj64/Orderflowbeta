import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Banknote, CheckCircle2, CreditCard, Download, FileText, MapPin, Phone, Truck, UtensilsCrossed } from 'lucide-react';
import type { Order, RestaurantProfile } from '../types';
import { receiptFilename } from '../lib/analytics';
import { formatDateTime } from '../lib/dates';
import { orderCode } from '../lib/ids';
import { formatMoney } from '../lib/money';
import { STATUS_LABEL, isCashDue, netAmount, paymentMethodOf, paymentSummary } from '../lib/orderStatus';
import { downloadOrderReceiptPdf, type ReceiptVariant } from '../lib/pdf';
import { Sheet } from './ui';

interface ReceiptModalProps {
  order: Order | null;
  profile?: RestaurantProfile | null;
  onClose: () => void;
  /** Default receipt format to display when the modal opens. */
  defaultVariant?: ReceiptVariant;
  /** When true (for staff/drivers/kitchen), shows format tabs to switch between Customer Receipt, Driver Slip, and Kitchen Ticket. */
  allowVariantSwitch?: boolean;
  surface?: 'store' | 'admin';
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({
  order,
  profile,
  onClose,
  defaultVariant = 'customer',
  allowVariantSwitch = false,
  surface = 'store',
}) => {
  const [variant, setVariant] = useState<ReceiptVariant>(defaultVariant);

  React.useEffect(() => {
    setVariant(defaultVariant);
  }, [defaultVariant, order?.id]);

  if (!order) return null;

  const code = orderCode(order);
  const storeName = profile?.name?.trim() || 'Restaurant';
  const pay = paymentSummary(order);
  const cashDue = isCashDue(order);
  const isDelivery = order.type === 'delivery';
  const createdStr = formatDateTime(order.createdAt) || 'Just now';

  const computedSubtotal =
    order.subtotal !== undefined
      ? order.subtotal
      : (order.items || []).reduce((sum, i) => sum + i.price * i.quantity, 0);

  const handleDownloadPdf = (targetVariant: ReceiptVariant = variant) => {
    try {
      downloadOrderReceiptPdf(order, profile, targetVariant);
      toast.success(`Downloaded ${receiptFilename(order, targetVariant)}`);
    } catch {
      toast.error('Could not generate the PDF receipt.');
    }
  };

  const variantLabels: { id: ReceiptVariant; label: string }[] = [
    { id: 'customer', label: 'Customer receipt' },
    { id: 'driver', label: 'Driver slip' },
    { id: 'kitchen', label: 'Kitchen ticket' },
  ];

  return (
    <Sheet
      open={!!order}
      onClose={onClose}
      surface={surface}
      size="md"
      title={`Receipt · #${code}`}
      footer={
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 py-2.5 rounded-btn bg-soft text-ink text-sm font-semibold transition hover:opacity-90"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => handleDownloadPdf(variant)}
            className="flex-1 min-h-[44px] px-5 py-2.5 rounded-btn bg-brand text-on-brand text-sm font-bold flex items-center justify-center gap-2 shadow-xs transition hover:opacity-95 active:scale-[0.99]"
          >
            <Download size={16} />
            <span>
              Download {variant === 'driver' ? 'Delivery Slip' : variant === 'kitchen' ? 'Kitchen Ticket' : 'Receipt'} (PDF)
            </span>
          </button>
        </div>
      }
    >
      <div className="p-4 sm:p-6 space-y-4">
        {allowVariantSwitch && (
          <div className="flex items-center gap-1 p-1 bg-soft border border-line rounded-btn">
            {variantLabels.map((v) => {
              const active = variant === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariant(v.id)}
                  className={`flex-1 min-h-[34px] px-2.5 py-1.5 rounded-btn text-xs font-bold transition whitespace-nowrap ${
                    active ? 'bg-brand text-on-brand shadow-2xs' : 'text-muted hover:text-ink'
                  }`}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Paper Receipt Card */}
        <div className="rounded-card border border-line bg-white text-gray-900 shadow-ios-sm overflow-hidden">
          {/* Top Brand Header */}
          <div
            className={`px-5 py-4 text-white flex items-start justify-between gap-3 ${
              variant === 'driver'
                ? 'bg-slate-900'
                : variant === 'kitchen'
                  ? 'bg-[#18221B]'
                  : 'bg-[#17231C]'
            }`}
          >
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-300">
                {variant === 'driver'
                  ? 'Driver Delivery & Payout Slip'
                  : variant === 'kitchen'
                    ? 'Kitchen Preparation Ticket'
                    : 'Official Order Receipt'}
              </p>
              <h3 className="font-display text-xl font-extrabold tracking-tight truncate mt-0.5">{storeName}</h3>
              {(profile?.address || profile?.phone) && (
                <p className="text-xs text-gray-300 mt-0.5 truncate">
                  {[profile?.address, profile?.phone].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="font-mono text-xl font-extrabold tabular-nums">#{code}</p>
              <span className="inline-block mt-1 px-2 py-0.5 rounded bg-white/15 text-[10px] font-bold uppercase tracking-wider">
                {isDelivery ? 'Delivery' : 'Pickup'} · {STATUS_LABEL[order.status]}
              </span>
            </div>
          </div>

          <div className="p-4 sm:p-5 space-y-4">
            {/* Prominent Cash Collection / Payment Banner */}
            <div
              className={`rounded-control border px-3.5 py-2.5 flex items-center justify-between gap-3 ${
                cashDue
                  ? 'bg-amber-50 border-amber-200 text-amber-950'
                  : 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {paymentMethodOf(order) === 'cash' ? (
                  <Banknote size={18} className={cashDue ? 'text-amber-700 shrink-0' : 'text-emerald-700 shrink-0'} />
                ) : (
                  <CreditCard size={18} className="text-emerald-700 shrink-0" />
                )}
                <div className="min-w-0 text-xs sm:text-sm">
                  <p className="font-bold">
                    {cashDue
                      ? `Collect ${formatMoney(order.total)} in cash ${isDelivery ? 'at drop-off' : 'at pickup'}`
                      : `${pay.label} (${paymentMethodOf(order) === 'cash' ? 'Cash' : 'Card'})`}
                  </p>
                  {order.paymentCollectedBy && order.paymentStatus === 'paid' && (
                    <p className="text-xs opacity-80">Recorded by {order.paymentCollectedBy}</p>
                  )}
                </div>
              </div>
              <span className="font-mono font-extrabold text-sm sm:text-base tabular-nums shrink-0">
                {formatMoney(order.total)}
              </span>
            </div>

            {/* Order & Customer Metadata Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs sm:text-sm bg-gray-50 rounded-control border border-gray-200/80 p-3.5">
              <div className="space-y-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Order details</p>
                <p className="text-gray-800">
                  <span className="text-gray-500">Placed:</span> {createdStr}
                </p>
                {order.scheduledTime && (
                  <p className="font-semibold text-indigo-700">Scheduled: {order.scheduledTime}</p>
                )}
                <p className="text-gray-800">
                  <span className="text-gray-500">Order ID:</span>{' '}
                  <span className="font-mono text-xs">{order.id.slice(0, 14)}</span>
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                  {isDelivery ? 'Customer & Delivery' : 'Customer & Pickup'}
                </p>
                <p className="font-semibold text-gray-900">{order.customerName || 'Guest'}</p>
                {order.customerPhone && (
                  <p className="text-gray-700 flex items-center gap-1 tabular-nums">
                    <Phone size={12} className="text-gray-400" /> {order.customerPhone}
                  </p>
                )}
                {isDelivery && order.deliveryAddress && (
                  <p className="text-gray-700 flex items-start gap-1">
                    <MapPin size={12} className="text-gray-400 shrink-0 mt-0.5" />
                    <span>{order.deliveryAddress}</span>
                  </p>
                )}
                {order.driverName && (
                  <p className="text-gray-700 flex items-center gap-1">
                    <Truck size={12} className="text-gray-400" /> Driver: {order.driverName}
                  </p>
                )}
              </div>
            </div>

            {order.notes && (
              <div className="rounded-control bg-red-50 border border-red-200 px-3.5 py-2 text-xs sm:text-sm text-red-900 font-medium">
                <span className="font-bold">Order note:</span> {order.notes}
              </div>
            )}

            {/* Driver Payout Summary Box when viewing Driver Slip */}
            {variant === 'driver' && (
              <div className="rounded-control bg-slate-900 text-white p-3.5 grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Delivery fee</p>
                  <p className="font-mono font-extrabold text-sm sm:text-base mt-0.5 tabular-nums">
                    {formatMoney(order.deliveryFee || 0)}
                  </p>
                </div>
                <div className="border-x border-white/10">
                  <p className="text-[10px] uppercase tracking-wider text-emerald-300 font-bold">Driver tip</p>
                  <p className="font-mono font-extrabold text-sm sm:text-base mt-0.5 text-emerald-300 tabular-nums">
                    {formatMoney(order.deliveryTip || 0)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-amber-300 font-bold">Cash to collect</p>
                  <p className="font-mono font-extrabold text-sm sm:text-base mt-0.5 text-amber-300 tabular-nums">
                    {cashDue ? formatMoney(order.total) : '$0.00'}
                  </p>
                </div>
              </div>
            )}

            {/* Itemized Line Items */}
            <div>
              <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-gray-500 pb-2 border-b border-gray-200">
                <span className="flex items-center gap-1.5">
                  <UtensilsCrossed size={12} /> Items ({order.items.reduce((s, i) => s + i.quantity, 0)})
                </span>
                {variant !== 'kitchen' && <span>Total</span>}
              </div>
              <ul className="divide-y divide-gray-100">
                {order.items.map((item, i) => (
                  <li key={i} className="py-2.5 flex items-start justify-between gap-3 text-xs sm:text-sm">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900">
                        <span className="font-mono font-extrabold text-emerald-700 tabular-nums mr-1.5">
                          {item.quantity}×
                        </span>
                        {item.name}
                        {variant !== 'kitchen' && item.quantity > 1 && (
                          <span className="text-xs font-normal text-gray-400 font-mono ml-1.5">
                            (@ {formatMoney(item.price)})
                          </span>
                        )}
                      </p>
                      {item.selectedModifiers?.length > 0 && (
                        <p className="text-xs text-gray-500 pl-5 mt-0.5">
                          {item.selectedModifiers
                            .map((m) => (m.groupName ? `${m.groupName}: ${m.name}` : m.name))
                            .join(' · ')}
                        </p>
                      )}
                      {item.prepNotes && (
                        <p className="text-xs font-semibold text-red-700 pl-5 mt-0.5">Note: “{item.prepNotes}”</p>
                      )}
                    </div>
                    {variant !== 'kitchen' && (
                      <span className="font-mono font-semibold text-gray-900 tabular-nums shrink-0">
                        {formatMoney(item.price * item.quantity)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {/* Totals Breakdown */}
            {variant !== 'kitchen' && (
              <div className="pt-3 border-t border-gray-200 space-y-1.5 text-xs sm:text-sm">
                <div className="flex justify-between text-gray-600">
                  <span>Subtotal</span>
                  <span className="font-mono tabular-nums">{formatMoney(computedSubtotal)}</span>
                </div>
                {!!order.discountAmount && order.discountAmount > 0 && (
                  <div className="flex justify-between text-emerald-700 font-medium">
                    <span>Discount{order.promoCode ? ` (${order.promoCode})` : ''}</span>
                    <span className="font-mono tabular-nums">−{formatMoney(order.discountAmount)}</span>
                  </div>
                )}
                {!!order.deliveryFee && order.deliveryFee > 0 && (
                  <div className="flex justify-between text-gray-600">
                    <span>Delivery fee</span>
                    <span className="font-mono tabular-nums">{formatMoney(order.deliveryFee)}</span>
                  </div>
                )}
                {!!order.serviceFee && order.serviceFee > 0 && (
                  <div className="flex justify-between text-gray-600">
                    <span>Service fee</span>
                    <span className="font-mono tabular-nums">{formatMoney(order.serviceFee)}</span>
                  </div>
                )}
                {!!order.tax && order.tax > 0 && (
                  <div className="flex justify-between text-gray-600">
                    <span>Tax</span>
                    <span className="font-mono tabular-nums">{formatMoney(order.tax)}</span>
                  </div>
                )}
                {!!order.restaurantTip && order.restaurantTip > 0 && (
                  <div className="flex justify-between text-gray-600">
                    <span>Restaurant tip</span>
                    <span className="font-mono tabular-nums">{formatMoney(order.restaurantTip)}</span>
                  </div>
                )}
                {!!order.deliveryTip && order.deliveryTip > 0 && (
                  <div className="flex justify-between text-gray-600">
                    <span>Driver tip</span>
                    <span className="font-mono tabular-nums">{formatMoney(order.deliveryTip)}</span>
                  </div>
                )}
                <div className="flex justify-between font-extrabold text-base text-gray-900 pt-2 border-t border-gray-200">
                  <span>{cashDue ? 'Total Due (Cash)' : 'Total'}</span>
                  <span className="font-mono tabular-nums">{formatMoney(order.total)}</span>
                </div>
                {!!order.refundAmount && order.refundAmount > 0 && (
                  <div className="flex justify-between text-red-700 font-semibold text-xs pt-1 font-mono tabular-nums">
                    <span>Refunded</span>
                    <span>
                      −{formatMoney(order.refundAmount)} (Net {formatMoney(netAmount(order))})
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Receipt Footer */}
            <div className="pt-2 border-t border-dashed border-gray-200 flex items-center justify-between text-[11px] text-gray-400">
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 size={12} className="text-emerald-600" /> Verified OrderFlow Receipt
              </span>
              <span className="font-mono">#{code}</span>
            </div>
          </div>
        </div>
      </div>
    </Sheet>
  );
};

/**
 * Compact button to open the receipt modal or directly download the PDF receipt.
 */
export const ReceiptButton: React.FC<{
  onClick: () => void;
  label?: string;
  className?: string;
}> = ({ onClick, label = 'Receipt', className = '' }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    className={`inline-flex items-center justify-center gap-1.5 rounded-btn font-semibold transition whitespace-nowrap ${className}`}
  >
    <FileText size={14} />
    <span>{label}</span>
  </button>
);
