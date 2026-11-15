import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { doc, getDoc, getDocFromCache, onSnapshot, serverTimestamp, updateDoc } from 'firebase/firestore';
import toast from 'react-hot-toast';
import {
  Banknote,
  Camera,
  CheckCircle,
  ChefHat,
  Clock,
  CreditCard,
  Download,
  FileText,
  LocateFixed,
  MapPin,
  Navigation,
  Package,
  Phone,
  RotateCcw,
  Star,
  Truck,
  XCircle,
} from 'lucide-react';
import { db } from '../firebase';
import type { GeoPoint, Order } from '../types';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useStore } from '../context/StoreContext';
import { api, isNoDatabaseError } from '../lib/api';
import { formatMoney } from '../lib/money';
import { orderCode } from '../lib/ids';
import { customerStatusLabel, isCashDue, netAmount } from '../lib/orderStatus';
import { formatTimeLabel } from '../lib/hours';
import { prepMinutes } from '../lib/storeStatus';
import { toDate } from '../lib/dates';
import { geocodeAddressNominatim, isValidGeoPoint, sanitizeGeoPoint } from '../lib/geo';
import { watchProofPhoto } from '../lib/proof';
import { friendlyError } from '../utils/errorHandling';
import { ConfirmDialog, PageSpinner, Spinner } from '../components/ui';
import { ReceiptModal } from '../components/ReceiptModal';
import { StatusBanner } from '../components/StatusBanner';
import { downloadOrderReceiptPdf } from '../lib/pdf';
import { receiptFilename } from '../lib/analytics';
import { useStorefrontUI } from '../components/Layout';

const OrderTrackingMap = lazy(() =>
  import('../components/OrderTrackingMap').then((m) => ({ default: m.OrderTrackingMap })),
);

const STATUS_TOASTS: Record<string, string> = {
  confirmed: 'The restaurant accepted your order!',
  preparing: 'Your order is being prepared.',
  ready: 'Your order is ready!',
  out_for_delivery: 'Your order is on the way!',
  completed: 'Enjoy your meal!',
  cancelled: 'Your order was cancelled.',
};

export const OrderTracker: React.FC = () => {
  const { orderId } = useParams<{ orderId: string }>();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();
  const { profile, catalog, status: storeStatus } = useStore();
  const { addToCart } = useCart();
  const { openAuth } = useStorefrontUI();
  const [order, setOrder] = useState<Order | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [submittingRating, setSubmittingRating] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);

  // Real-time GPS & OpenStreetMap state
  const [geocodedStore, setGeocodedStore] = useState<GeoPoint | null>(null);
  const [geocodedDelivery, setGeocodedDelivery] = useState<GeoPoint | null>(null);
  const [pinnedDelivery, setPinnedDelivery] = useState<GeoPoint | null>(null);
  const [customerLiveGps, setCustomerLiveGps] = useState<GeoPoint | null>(null);
  const [locatingMe, setLocatingMe] = useState(false);
  const [proofPhoto, setProofPhoto] = useState<string | null>(null);

  const prevStatus = useRef<string | null>(null);
  const paymentChecked = useRef(false);

  useEffect(() => {
    if (!orderId) {
      setState('missing');
      return;
    }
    if (!user) {
      if (!authLoading) setState('missing');
      return;
    }

    let cancelled = false;
    setState((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    const ref = doc(db, 'orders', orderId);

    getDocFromCache(ref)
      .then((cacheSnap) => {
        if (cancelled || !cacheSnap.exists()) return;
        const next = { id: cacheSnap.id, ...cacheSnap.data() } as Order;
        prevStatus.current = next.status;
        setOrder(next);
        setState('ready');
      })
      .catch(() => undefined);

    getDoc(ref)
      .then((snap) => {
        if (cancelled) return;
        if (!snap.exists()) return;
        const next = { id: snap.id, ...snap.data() } as Order;
        prevStatus.current = next.status;
        setOrder(next);
        setState('ready');
      })
      .catch(() => undefined);

    const safetyTimer = window.setTimeout(() => {
      if (!cancelled) {
        setState((prev) => (prev === 'loading' ? 'missing' : prev));
      }
    }, 3000);

    const unsub = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        if (cancelled) return;
        const fromCache = snap.metadata.fromCache;
        if (!snap.exists()) {
          if (!fromCache) {
            window.clearTimeout(safetyTimer);
            setOrder(null);
            setState('missing');
          }
          return;
        }
        window.clearTimeout(safetyTimer);
        const next = { id: snap.id, ...snap.data() } as Order;
        if (prevStatus.current && prevStatus.current !== next.status && STATUS_TOASTS[next.status]) {
          toast(STATUS_TOASTS[next.status], { duration: 6000 });
          navigator.vibrate?.(150);
        }
        prevStatus.current = next.status;
        setOrder(next);
        setState('ready');
      },
      () => {
        if (cancelled) return;
        window.clearTimeout(safetyTimer);
        setState('missing');
      },
    );
    return () => {
      cancelled = true;
      window.clearTimeout(safetyTimer);
      unsub();
    };
  }, [orderId, user, authLoading]);

  // The driver's position arrives through the live order document above (no polling).

  // Proof-of-delivery photo (stored next to the order, see src/lib/proof.ts).
  const wantsProof = order?.type === 'delivery' && order.status === 'completed' && !order.proofOfDeliveryImage;
  useEffect(() => {
    setProofPhoto(null);
    if (!orderId || !wantsProof) return;
    return watchProofPhoto(orderId, setProofPhoto);
  }, [orderId, wantsProof]);

  // Geocode restaurant address if profile.location is not explicitly set
  useEffect(() => {
    if (isValidGeoPoint(profile?.location)) {
      setGeocodedStore(profile!.location);
      return;
    }
    if (!profile?.address) return;
    const ctrl = new AbortController();
    geocodeAddressNominatim(profile.address, ctrl.signal).then((pt) => {
      if (!ctrl.signal.aborted && pt) setGeocodedStore(pt);
    });
    return () => ctrl.abort();
  }, [profile?.location, profile?.address]);

  // Geocode customer delivery address if order.deliveryLocation is not explicitly set
  useEffect(() => {
    if (!order || order.type !== 'delivery') return;
    if (isValidGeoPoint(order.deliveryLocation)) {
      setGeocodedDelivery(order.deliveryLocation);
      return;
    }
    if (!order.deliveryAddress) return;
    const ctrl = new AbortController();
    geocodeAddressNominatim(order.deliveryAddress, ctrl.signal).then((pt) => {
      if (!ctrl.signal.aborted && pt) setGeocodedDelivery(pt);
    });
    return () => ctrl.abort();
  }, [order?.type, order?.deliveryLocation, order?.deliveryAddress]);

  // Self-heal: if the payment went through but the confirmation never reached us
  useEffect(() => {
    if (!order || paymentChecked.current) return;
    if (order.status === 'payment_pending' && order.paymentMethod !== 'cash') {
      paymentChecked.current = true;
      setCheckingPayment(true);
      api
        .confirmPayment(order.id)
        .catch(() => undefined)
        .finally(() => setCheckingPayment(false));
    }
  }, [order]);

  const storePoint = useMemo(
    () => (isValidGeoPoint(profile?.location) ? profile!.location : geocodedStore),
    [profile?.location, geocodedStore],
  );

  // A pin the customer just dropped shows immediately, then the saved order takes over.
  const deliveryPoint = useMemo(() => {
    const saved = isValidGeoPoint(order?.deliveryLocation) ? order!.deliveryLocation! : null;
    if (pinnedDelivery && (!saved || (pinnedDelivery.updatedAt || 0) > (saved.updatedAt || 0))) return pinnedDelivery;
    return saved || geocodedDelivery;
  }, [order?.deliveryLocation, pinnedDelivery, geocodedDelivery]);

  const driverPoint = useMemo(() => (isValidGeoPoint(order?.driverLocation) ? order!.driverLocation! : null), [order?.driverLocation]);

  const saveCustomerDeliveryPin = async (point: GeoPoint) => {
    if (!order || order.type !== 'delivery') return;
    const clean = sanitizeGeoPoint({ ...point, updatedAt: Date.now() });
    if (!clean) return;
    setPinnedDelivery(clean);
    try {
      await updateDoc(doc(db, 'orders', order.id), { deliveryLocation: clean, updatedAt: serverTimestamp() });
      toast.success('Delivery GPS pin updated for your driver', { id: 'pin-saved' });
    } catch (err) {
      setPinnedDelivery(null);
      toast.error(friendlyError(err, 'Could not update the GPS pin.'), { id: 'pin-saved' });
    }
  };

  const shareMyCurrentGps = () => {
    if (!('geolocation' in navigator)) {
      toast.error('GPS is not supported by this browser.');
      return;
    }
    setLocatingMe(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const pt: GeoPoint = {
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
          accuracy: Math.round(pos.coords.accuracy),
          updatedAt: Date.now(),
        };
        setCustomerLiveGps(pt);
        if (order?.type === 'delivery' && !['completed', 'cancelled'].includes(order.status)) {
          await saveCustomerDeliveryPin(pt);
        } else {
          toast.success('Showing your live GPS distance on the map');
        }
        setLocatingMe(false);
      },
      (err) => {
        setLocatingMe(false);
        toast.error(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was denied. Enable location access in your browser settings.'
            : 'Could not get your GPS location.',
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 },
    );
  };

  if (state === 'loading' || (authLoading && !user)) return <PageSpinner label="Loading your order…" />;

  if (state === 'missing' || !order) {
    return (
      <div className="text-center py-20 max-w-sm mx-auto">
        <h1 className="text-2xl font-extrabold mb-2">Order not found</h1>
        <p className="text-muted mb-6">{user ? "We couldn't find this order on your account." : 'Sign in to see your order.'}</p>
        {user ? (
          <Link to="/my-orders" className="inline-block bg-brand text-on-brand px-6 py-3 rounded-btn font-semibold">
            My orders
          </Link>
        ) : (
          <button onClick={openAuth} className="bg-brand text-on-brand px-6 py-3 rounded-btn font-semibold">
            Sign in
          </button>
        )}
      </div>
    );
  }

  const isDelivery = order.type === 'delivery';
  const steps = [
    { key: 'new', label: 'Received', icon: Clock },
    { key: 'confirmed', label: 'Accepted', icon: CheckCircle },
    { key: 'preparing', label: 'Preparing', icon: ChefHat },
    { key: isDelivery ? 'out_for_delivery' : 'ready', label: isDelivery ? 'On the way' : 'Ready', icon: isDelivery ? Truck : Package },
    { key: 'completed', label: isDelivery ? 'Delivered' : 'Picked up', icon: CheckCircle },
  ];
  const order_: Record<string, number> = { new: 0, confirmed: 1, preparing: 2, ready: isDelivery ? 2 : 3, out_for_delivery: 3, completed: 4 };
  const currentStep = order_[order.status] ?? -1;
  const cancelled = order.status === 'cancelled';
  const pendingPayment = order.status === 'payment_pending';
  const cashDue = isCashDue(order);
  const paidByCard = order.paymentMethod !== 'cash' && ['paid', 'partially_refunded'].includes(order.paymentStatus || '');

  const scheduled = toDate(order.scheduledFor);
  const created = toDate(order.createdAt);
  const eta = !scheduled && created && ['new', 'confirmed', 'preparing'].includes(order.status) ? new Date(created.getTime() + prepMinutes(profile) * 60_000) : null;

  const handleCancel = async () => {
    setCancelling(true);
    try {
      try {
        // The server cancels the order and refunds card payments in one step. If it
        // says no (e.g. the kitchen already accepted the order) that answer stands.
        const res = await api.cancel(order.id, 'Cancelled by customer');
        toast.success(res.refunded ? 'Order cancelled. Your refund is on its way.' : 'Order cancelled.');
      } catch (err) {
        // Basic mode (server without database access): an unpaid cash order can be
        // cancelled directly. Anything paid always needs the server for the refund.
        if (!isNoDatabaseError(err) || order.paymentMethod !== 'cash' || order.paymentStatus === 'paid') throw err;
        await updateDoc(doc(db, 'orders', order.id), {
          status: 'cancelled',
          cancelledBy: 'customer',
          cancelReason: 'Cancelled by customer',
          updatedAt: serverTimestamp(),
        });
        toast.success('Order cancelled.');
      }
      setCancelOpen(false);
    } catch (err) {
      setCancelOpen(false);
      toast.error(friendlyError(err, 'Could not cancel the order. Please call the restaurant.'), { duration: 6000 });
    } finally {
      setCancelling(false);
    }
  };

  const submitRating = async () => {
    if (!rating) return;
    setSubmittingRating(true);
    try {
      try {
        await api.rate(order.id, rating, comment.trim());
      } catch (err) {
        if (!isNoDatabaseError(err)) throw err;
        await updateDoc(doc(db, 'orders', order.id), {
          rating,
          ...(comment.trim() ? { ratingComment: comment.trim() } : {}),
          ratedAt: serverTimestamp(),
        });
      }
      toast.success('Thanks for your feedback!');
    } catch (err) {
      toast.error(friendlyError(err, 'Could not save your rating.'));
    } finally {
      setSubmittingRating(false);
    }
  };

  const reorder = () => {
    let added = 0;
    for (const line of order.items) {
      const item = catalog.items.get(line.itemId);
      if (!item || !item.active || item.isSoldOut) continue;
      addToCart({ itemId: line.itemId, name: item.name, price: line.price, quantity: line.quantity, selectedModifiers: line.selectedModifiers || [], prepNotes: line.prepNotes });
      added += line.quantity;
    }
    if (added) toast.success(`Added ${added} item${added === 1 ? '' : 's'} to your cart`);
    else toast.error('These items are no longer available.');
  };

  const breakdown: [string, number | undefined, string?][] = [
    ['Subtotal', order.subtotal],
    ['Discount' + (order.promoCode ? ` (${order.promoCode})` : ''), order.discountAmount ? -order.discountAmount : 0, 'text-emerald-700'],
    ['Delivery fee', order.deliveryFee],
    ['Service fee', order.serviceFee],
    ['Tax', order.tax],
    ['Tip', order.restaurantTip],
    ['Driver tip', order.deliveryTip],
  ];

  const showLiveMap = !cancelled && !pendingPayment && (isDelivery || !!storePoint || !!customerLiveGps);
  const mapDestPoint = isDelivery ? deliveryPoint : customerLiveGps;

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {(location.state as { placed?: boolean } | null)?.placed && !cancelled && (
        <StatusBanner
          tone="emerald"
          pattern="waves"
          metric={`#${orderCode(order)}`}
          metricLabel="SENT TO KITCHEN"
          kicker="ORDER CONFIRMED & QUEUED"
          title={`Thanks${order.customerName ? `, ${order.customerName.split(' ')[0]}` : ''}! Your order was sent to the kitchen.`}
          subtitle="Our kitchen team has your ticket on the board and is preparing your order."
        />
      )}

      <section className="bg-card rounded-card border border-line p-5 sm:p-7">
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-muted font-mono tabular-nums">Order #{orderCode(order)}</p>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold mt-1">
            {pendingPayment ? (checkingPayment ? 'Confirming payment…' : 'Payment not completed') : customerStatusLabel(order)}
          </h1>
          <p className="text-sm text-muted mt-1">
            {isDelivery ? `Delivery to ${order.deliveryAddress || 'your address'}` : `Pickup at ${profile?.address || profile?.name || 'the restaurant'}`}
          </p>
          {scheduled && <p className="mt-2 text-sm font-semibold text-brand">Scheduled for {order.scheduledTime || scheduled.toLocaleString()}</p>}
          {eta && !cancelled && (
            <p className="mt-2 text-sm font-semibold">
              Estimated {isDelivery ? 'ready for the driver' : 'ready'} around {formatTimeLabel(eta, storeStatus.timeZone)}
            </p>
          )}
        </div>

        {pendingPayment && !checkingPayment && (
          <div className="mt-5">
            <StatusBanner
              tone="heat"
              pattern="slashes"
              compact
              metric="HOLD"
              metricLabel="PAYMENT DUE"
              title="We haven't received payment for this order yet."
              subtitle="Your ticket will be sent to the kitchen as soon as checkout is completed."
              action={
                <Link
                  to="/cart"
                  className="inline-flex items-center px-3.5 py-2 rounded-btn bg-[#F39120] text-[#111315] text-xs font-extrabold uppercase tracking-wider hover:opacity-95 transition whitespace-nowrap"
                >
                  Return to checkout
                </Link>
              }
            />
          </div>
        )}

        {cancelled ? (
          <div className="mt-6">
            <StatusBanner
              tone="rust"
              pattern="slashes"
              role="alert"
              metric="VOID"
              metricLabel="CANCELLED"
              title="This order was cancelled."
              subtitle={
                <>
                  {order.paymentStatus === 'refunded' && (
                    <span className="block">
                      A refund of {formatMoney(order.refundAmount ?? order.total)} was issued to your card (5–10 business days).
                    </span>
                  )}
                  {order.cancelReason && order.cancelledBy === 'staff' && (
                    <span className="block">Reason: {order.cancelReason}</span>
                  )}
                </>
              }
            />
          </div>
        ) : (
          !pendingPayment && (
            <ol className="mt-7 grid grid-cols-5 gap-1" aria-label="Order progress">
              {steps.map((step, i) => {
                const done = i <= currentStep;
                const Icon = step.icon;
                return (
                  <li key={step.key} className="flex flex-col items-center text-center gap-1.5">
                    <span className="relative w-full flex items-center justify-center">
                      {i > 0 && <span className={`absolute right-1/2 top-1/2 -translate-y-1/2 w-full h-1 rounded ${i <= currentStep ? 'bg-brand' : 'bg-soft'}`} />}
                      <span
                        className={`relative z-10 w-10 h-10 rounded-full flex items-center justify-center border-2 transition ${
                          done ? 'bg-brand border-brand text-on-brand' : 'bg-card border-line text-muted'
                        } ${i === currentStep ? 'ring-4 ring-brand/20' : ''}`}
                      >
                        <Icon size={18} />
                      </span>
                    </span>
                    <span className={`text-[11px] sm:text-xs font-semibold leading-tight ${done ? '' : 'text-muted'}`}>{step.label}</span>
                  </li>
                );
              })}
            </ol>
          )
        )}

        {isDelivery && order.driverName && !cancelled && order.status !== 'completed' && (
          <div className="mt-6">
            <StatusBanner
              tone="aqua"
              pattern="contours"
              compact
              metric={driverPoint ? 'LIVE' : 'DRIVER'}
              metricLabel={driverPoint ? 'GPS ACTIVE' : 'ASSIGNED'}
              title={`${order.driverName} is your delivery driver`}
              subtitle={
                driverPoint
                  ? 'Sharing real-time GPS coordinates on the live map below.'
                  : order.deliveryStatus === 'picked_up'
                    ? 'Picked up your order and heading your way now.'
                    : 'Heading to the restaurant to pick up your order.'
              }
            />
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {!pendingPayment && (
            <>
              <button
                type="button"
                onClick={() => setReceiptOpen(true)}
                className="min-h-[44px] px-4 py-2.5 rounded-btn bg-soft hover:opacity-90 text-ink text-sm font-semibold flex items-center gap-2 transition"
              >
                <FileText size={16} className="text-brand" /> View receipt
              </button>
              <button
                type="button"
                onClick={() => {
                  downloadOrderReceiptPdf(order, profile, 'customer');
                  toast.success(`Downloaded ${receiptFilename(order, 'customer')}`);
                }}
                className="min-h-[44px] px-4 py-2.5 rounded-btn bg-soft hover:opacity-90 text-ink text-sm font-semibold flex items-center gap-2 transition"
              >
                <Download size={16} className="text-brand" /> Download PDF
              </button>
            </>
          )}
          {order.status === 'new' && (
            <button onClick={() => setCancelOpen(true)} className="min-h-[44px] px-4 py-2.5 rounded-btn bg-red-50 text-red-700 text-sm font-semibold">
              Cancel order
            </button>
          )}
          {profile?.phone && (
            <a href={`tel:${profile.phone}`} className="min-h-[44px] px-4 py-2.5 rounded-btn bg-soft text-sm font-semibold flex items-center gap-2">
              <Phone size={16} /> Call restaurant
            </a>
          )}
          {(order.status === 'completed' || cancelled) && (
            <button onClick={reorder} className="min-h-[44px] px-4 py-2.5 rounded-btn bg-brand text-on-brand text-sm font-semibold flex items-center gap-2">
              <RotateCcw size={16} /> Order again
            </button>
          )}
        </div>
      </section>

      {/* Real-time OpenStreetMap + GPS tracking section */}
      {showLiveMap && (
        <section className="bg-card rounded-card border border-line p-4 sm:p-6 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-bold text-base flex items-center gap-2">
                <MapPin size={17} className="text-brand" />
                {isDelivery ? 'Live delivery map' : 'Pickup location & route'}
              </h2>
              <p className="text-xs text-muted mt-0.5">
                {isDelivery
                  ? driverPoint
                    ? 'Tracking your driver in real time on OpenStreetMap.'
                    : order.status === 'completed'
                      ? 'Delivered destination.'
                      : 'Pin your exact drop-off spot so your driver can find you right away.'
                  : profile?.address || 'Find us on OpenStreetMap or share your GPS to see your route.'}
              </p>
            </div>

            {order.status !== 'completed' && (
              <button
                type="button"
                onClick={shareMyCurrentGps}
                disabled={locatingMe}
                className="min-h-[38px] px-3.5 py-2 rounded-btn bg-soft hover:opacity-90 text-xs font-semibold flex items-center gap-1.5 transition disabled:opacity-50"
              >
                {locatingMe ? <Spinner size={14} /> : <LocateFixed size={14} />}
                {isDelivery ? 'Pin my exact GPS' : customerLiveGps ? 'Update my GPS' : 'Show my distance'}
              </button>
            )}
          </div>

          {storePoint || mapDestPoint || driverPoint ? (
            <Suspense
              fallback={
                <div className="h-64 rounded-2xl bg-soft flex items-center justify-center text-muted text-sm">
                  <Spinner size={18} />
                </div>
              }
            >
              <OrderTrackingMap
                storePoint={storePoint}
                storeLabel={profile?.name || 'Restaurant'}
                destinationPoint={mapDestPoint}
                destinationLabel={isDelivery ? order.deliveryAddress || 'Drop-off' : 'Your location'}
                driverPoint={isDelivery && order.status !== 'completed' ? driverPoint : null}
                driverLabel={order.driverName ? `${order.driverName} (Live GPS)` : 'Driver (Live GPS)'}
                onSelectPoint={isDelivery && order.status !== 'completed' ? saveCustomerDeliveryPin : undefined}
                editablePin="destination"
                heightClassName="h-64 sm:h-80"
              />
            </Suspense>
          ) : (
            <div className="rounded-2xl border border-dashed border-line p-6 text-center space-y-2">
              <p className="text-sm text-muted">
                Tap <strong>{isDelivery ? 'Pin my exact GPS' : 'Show my distance'}</strong> to display your live coordinates on OpenStreetMap.
              </p>
            </div>
          )}

          {!isDelivery && (profile?.address || storePoint) && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted">
              <span>{profile?.address}</span>
              {storePoint && (
                <a
                  href={`https://www.openstreetmap.org/?mlat=${storePoint.lat}&mlon=${storePoint.lng}#map=17/${storePoint.lat}/${storePoint.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-brand inline-flex items-center gap-1 hover:underline"
                >
                  <Navigation size={12} /> Open in OpenStreetMap
                </a>
              )}
            </div>
          )}
        </section>
      )}

      <section className="bg-card rounded-card border border-line p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="font-bold">Payment & Receipt</h2>
          <div className="flex items-center gap-2">
            <span className="text-sm flex items-center gap-1.5 text-muted">
              {order.paymentMethod === 'cash' ? <Banknote size={16} /> : <CreditCard size={16} />}
              {order.paymentMethod === 'cash' ? 'Cash' : 'Card'}
            </span>
            {!pendingPayment && (
              <button
                type="button"
                onClick={() => {
                  downloadOrderReceiptPdf(order, profile, 'customer');
                  toast.success(`Downloaded ${receiptFilename(order, 'customer')}`);
                }}
                className="px-2.5 py-1 rounded-btn bg-soft hover:opacity-90 text-xs font-bold text-brand inline-flex items-center gap-1 transition"
              >
                <Download size={13} /> Receipt PDF
              </button>
            )}
          </div>
        </div>
        {cashDue ? (
          <p className="rounded-control bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 text-sm font-semibold font-mono tabular-nums">
            Please pay {formatMoney(order.total)} in cash {isDelivery ? 'to your driver' : 'when you pick up'}.
          </p>
        ) : order.paymentStatus === 'paid' ? (
          <p className="text-sm text-emerald-700 font-semibold font-mono tabular-nums">
            Paid{order.paymentMethod === 'cash' ? ' in cash' : ''} · {formatMoney(order.total)}
          </p>
        ) : null}

        <h2 className="font-bold mt-6 mb-3">Items</h2>
        <ul className="space-y-3">
          {order.items.map((item, idx) => (
            <li key={idx} className="flex justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="font-semibold">
                  <span className="text-muted mr-1.5 font-mono tabular-nums">{item.quantity}×</span>
                  {item.name}
                </p>
                {item.selectedModifiers?.length > 0 && <p className="text-xs text-muted">{item.selectedModifiers.map((m) => m.name).join(', ')}</p>}
                {item.prepNotes && <p className="text-xs text-muted italic">“{item.prepNotes}”</p>}
              </div>
              <span className="whitespace-nowrap font-mono tabular-nums">{formatMoney(item.price * item.quantity)}</span>
            </li>
          ))}
        </ul>

        {order.notes && (
          <div className="mt-4 rounded-control bg-soft px-3 py-2 text-sm">
            <span className="font-semibold">Notes:</span> {order.notes}
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-line space-y-1.5 text-sm">
          {breakdown
            .filter(([, v]) => !!v)
            .map(([label, value, cls]) => (
              <div key={label} className={`flex justify-between ${cls || ''}`}>
                <span>{label}</span>
                <span className="font-mono tabular-nums">{formatMoney(value || 0)}</span>
              </div>
            ))}
          <div className="flex justify-between font-extrabold text-base pt-2">
            <span>Total</span>
            <span className="font-mono tabular-nums">{formatMoney(order.total)}</span>
          </div>
          {!!order.refundAmount && order.refundAmount > 0 && (
            <div className="flex justify-between text-red-700 text-sm font-mono tabular-nums">
              <span>Refunded</span>
              <span>
                −{formatMoney(order.refundAmount)} (net {formatMoney(netAmount(order))})
              </span>
            </div>
          )}
        </div>
      </section>

      {(order.proofOfDeliveryImage || proofPhoto) && (
        <section className="bg-card rounded-card border border-line p-5">
          <h2 className="font-bold mb-3 flex items-center gap-2">
            <Camera size={18} /> Proof of delivery
          </h2>
          <img src={order.proofOfDeliveryImage || proofPhoto || ''} alt="Proof of delivery" loading="lazy" className="rounded-card w-full max-w-sm object-cover" />
        </section>
      )}

      {order.status === 'completed' && (
        <section className="bg-card rounded-card border border-line p-5">
          <h2 className="font-bold mb-3">How was your order?</h2>
          {order.rating ? (
            <div>
              <div className="flex gap-1 mb-2">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star key={s} size={22} className={s <= order.rating! ? 'fill-amber-400 text-amber-400' : 'text-line'} />
                ))}
              </div>
              {order.ratingComment && <p className="text-sm text-muted">“{order.ratingComment}”</p>}
              <p className="text-xs text-muted mt-2">Thanks for your feedback!</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((s) => (
                  <button key={s} type="button" onClick={() => setRating(s)} aria-label={`${s} star${s > 1 ? 's' : ''}`} aria-pressed={s <= rating} className="p-1.5">
                    <Star size={34} className={s <= rating ? 'fill-amber-400 text-amber-400' : 'text-line'} />
                  </button>
                ))}
              </div>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value.slice(0, 1000))}
                rows={3}
                placeholder="Tell us more (optional)"
                className="w-full rounded-control border border-line bg-page px-3.5 py-2.5 text-sm placeholder:text-muted focus:ring-2 focus:ring-brand outline-none resize-none"
              />
              <button onClick={submitRating} disabled={!rating || submittingRating} className="px-5 py-2.5 rounded-btn bg-brand text-on-brand font-semibold text-sm disabled:opacity-50 flex items-center gap-2">
                {submittingRating && <Spinner size={16} />} Submit rating
              </button>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={cancelOpen}
        surface="store"
        danger
        busy={cancelling}
        title="Cancel this order?"
        message={paidByCard ? `You'll be refunded ${formatMoney(order.total)} to your card.` : 'The restaurant has not started on it yet.'}
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        onCancel={() => setCancelOpen(false)}
        onConfirm={handleCancel}
      />

      <ReceiptModal
        order={receiptOpen ? order : null}
        profile={profile}
        onClose={() => setReceiptOpen(false)}
        defaultVariant="customer"
        surface="store"
      />
    </div>
  );
};
