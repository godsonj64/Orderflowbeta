import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, limit, onSnapshot, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import toast from 'react-hot-toast';
import { Camera, CheckCircle2, Download, FileText, LocateFixed, MapPin, Navigation, Package, Phone, Radio } from 'lucide-react';
import { db } from '../firebase';
import type { GeoPoint, Order } from '../types';
import { useAuth } from '../context/AuthContext';
import { useStore } from '../context/StoreContext';
import { receiptFilename } from '../lib/analytics';
import { orderCode } from '../lib/ids';
import { formatMoney } from '../lib/money';
import { formatDateTime, timeAgo, toMillis } from '../lib/dates';
import { isCashDue } from '../lib/orderStatus';
import { geocodeAddressNominatim, haversineDistanceKm, isValidGeoPoint, sanitizeGeoPoint, shouldPublishGpsUpdate } from '../lib/geo';
import { downloadOrderReceiptPdf } from '../lib/pdf';
import { resizeWithPreset } from '../utils/imageUpload';
import { saveProofPhoto } from '../lib/proof';
import { ordersFromSnapshot } from '../lib/orderList';
import { useWakeLock } from '../hooks/useWakeLock';
import { friendlyError, reportError } from '../utils/errorHandling';
import { ReceiptModal } from '../components/ReceiptModal';
import { Sheet, Spinner } from '../components/ui';

const OrderTrackingMap = lazy(() =>
  import('../components/OrderTrackingMap').then((m) => ({ default: m.OrderTrackingMap })),
);

/**
 * Turn-by-turn directions from the driver's current position. This universal link opens
 * the maps app on phones (voice navigation) and the website on a computer.
 */
const navigationUrl = (to?: GeoPoint | null, fallbackAddress = '') => {
  const destination = isValidGeoPoint(to) ? `${to.lat},${to.lng}` : fallbackAddress;
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(destination)}`;
};

/** Deliveries a driver still has to finish. */
const ACTIVE_DELIVERY_STATUSES = ['new', 'confirmed', 'preparing', 'ready', 'out_for_delivery'];

export const DriverDashboard: React.FC = () => {
  const { userProfile } = useAuth();
  const { profile } = useStore();
  const [available, setAvailable] = useState<Order[]>([]);
  const [mine, setMine] = useState<Order[]>([]);
  const [completedMine, setCompletedMine] = useState<Order[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [completing, setCompleting] = useState<Order | null>(null);
  const [cashConfirmed, setCashConfirmed] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null);

  // Live GPS broadcasting state
  const [sharingGps, setSharingGps] = useState(false);
  const [driverPos, setDriverPos] = useState<GeoPoint | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [geocodedTargets, setGeocodedTargets] = useState<Record<string, GeoPoint>>({});
  const [geocodedStore, setGeocodedStore] = useState<GeoPoint | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const lastPublishedRef = useRef<GeoPoint | null>(null);
  const latestFixRef = useRef<GeoPoint | null>(null);
  const trailingTimerRef = useRef<number | null>(null);
  const broadcastRef = useRef<((point: GeoPoint, force?: boolean) => Promise<void>) | null>(null);
  const mineRef = useRef<Order[]>(mine);
  mineRef.current = mine;

  const driverName = (userProfile?.name || userProfile?.email || 'Driver').slice(0, 100);

  useEffect(() => {
    if (!userProfile) return;
    const availableCache = new Map<string, Order>();
    const unsubAvailable = onSnapshot(
      query(collection(db, 'orders'), where('type', '==', 'delivery'), where('status', 'in', ['preparing', 'ready']), limit(150)),
      (snap) => {
        setAvailable(
          ordersFromSnapshot(snap, availableCache)
            .filter((o) => !o.driverId)
            .sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt)),
        );
      },
      (err) => reportError(err, 'driver-available'),
    );

    // Only deliveries that are still open. (Listing every delivery this driver ever made
    // downloaded their whole history on each visit and, past the query limit, could
    // hide the delivery they are on right now.)
    const mineBase = [where('type', '==', 'delivery'), where('driverId', '==', userProfile.uid)];
    const mineCache = new Map<string, Order>();
    const showMine = (snap: Parameters<typeof ordersFromSnapshot>[0]) => {
      const allMine = ordersFromSnapshot(snap, mineCache);
      setMine(
        allMine
          .filter((o) => ACTIVE_DELIVERY_STATUSES.includes(o.status))
          .sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt)),
      );
      setCompletedMine(
        allMine
          .filter((o) => o.status === 'completed')
          .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
          .slice(0, 20),
      );
    };
    let unsubMine = onSnapshot(
      query(collection(db, 'orders'), ...mineBase, limit(100)),
      showMine,
      (err) => {
        if ((err as { code?: string })?.code !== 'failed-precondition') return reportError(err, 'driver-mine');
        mineCache.clear();
        unsubMine = onSnapshot(query(collection(db, 'orders'), ...mineBase, limit(100)), showMine, (e) => reportError(e, 'driver-mine'));
      },
    );
    return () => {
      unsubAvailable();
      unsubMine();
    };
  }, [userProfile?.uid]);

  // Geocode store address if profile.location is not set
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

  // Geocode delivery addresses for active deliveries when deliveryLocation is not set
  useEffect(() => {
    let cancelled = false;
    mine.forEach((order) => {
      if (isValidGeoPoint(order.deliveryLocation) || geocodedTargets[order.id] || !order.deliveryAddress) return;
      geocodeAddressNominatim(order.deliveryAddress).then((pt) => {
        if (!cancelled && pt) {
          setGeocodedTargets((prev) => ({ ...prev, [order.id]: pt }));
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [mine, geocodedTargets]);

  const broadcastGpsToActiveOrders = useCallback(async (point: GeoPoint, force = false) => {
    const clean = sanitizeGeoPoint(point);
    if (!clean) return;
    setDriverPos(clean);
    if (!force && !shouldPublishGpsUpdate(lastPublishedRef.current, clean)) {
      // Too soon after the last update. Remember the fix and send it once the interval
      // has passed: otherwise the last stretch before a stop (red light, the customer's
      // door) is never published and the customer's map shows the driver short of where
      // they really are.
      latestFixRef.current = clean;
      if (trailingTimerRef.current === null) {
        trailingTimerRef.current = window.setTimeout(() => {
          trailingTimerRef.current = null;
          const latest = latestFixRef.current;
          const last = lastPublishedRef.current;
          if (latest && (!last || haversineDistanceKm(last, latest) * 1000 >= 10)) {
            void broadcastRef.current?.({ ...latest, updatedAt: Date.now() }, true);
          }
        }, 6500);
      }
      return;
    }
    lastPublishedRef.current = clean;
    latestFixRef.current = null;

    const activeOrders = mineRef.current;
    if (activeOrders.length === 0) return;

    // One small write per active delivery; the customer's tracker receives it through
    // its live order listener.
    await Promise.allSettled(activeOrders.map((o) => updateDoc(doc(db, 'orders', o.id), { driverLocation: clean })));
  }, []);

  broadcastRef.current = broadcastGpsToActiveOrders;

  // Phones stop reporting GPS when the screen locks: keep it on while sharing.
  useWakeLock(sharingGps);

  const stopGpsSharing = useCallback(() => {
    if (watchIdRef.current !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (trailingTimerRef.current !== null) {
      window.clearTimeout(trailingTimerRef.current);
      trailingTimerRef.current = null;
    }
    setSharingGps(false);
  }, []);

  const startGpsSharing = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setGpsError('GPS is not supported by this browser.');
      toast.error('GPS is not supported by this browser.');
      return;
    }
    if (watchIdRef.current !== null) return;
    setGpsError(null);
    setSharingGps(true);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const pt: GeoPoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          updatedAt: Date.now(),
        };
        broadcastGpsToActiveOrders(pt, false);
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Enable GPS access in browser settings.'
            : 'Waiting for GPS signal…';
        setGpsError(msg);
      },
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 },
    );
  }, [broadcastGpsToActiveOrders]);

  const pingGpsNow = useCallback(() => {
    if (!('geolocation' in navigator)) {
      toast.error('GPS is not supported on this device.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const pt: GeoPoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          updatedAt: Date.now(),
        };
        await broadcastGpsToActiveOrders(pt, true);
        toast.success('Live GPS location updated');
      },
      () => toast.error('Could not read GPS location.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 },
    );
  }, [broadcastGpsToActiveOrders]);

  // Stop watching when no active deliveries remain, and cleanup on unmount
  useEffect(() => {
    if (mine.length === 0 && sharingGps) {
      stopGpsSharing();
    }
  }, [mine.length, sharingGps, stopGpsSharing]);

  useEffect(() => () => stopGpsSharing(), [stopGpsSharing]);

  const run = async (order: Order, patch: Record<string, unknown>, success: string) => {
    setBusyId(order.id);
    try {
      await updateDoc(doc(db, 'orders', order.id), { ...patch, updatedAt: serverTimestamp() });
      toast.success(success);
      return true;
    } catch (err) {
      const msg = (err as { code?: string })?.code === 'permission-denied' ? 'Another driver already took this delivery.' : friendlyError(err);
      toast.error(msg);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const accept = async (order: Order) => {
    const ok = await run(order, { driverId: userProfile!.uid, driverName, deliveryStatus: 'assigned' }, 'Delivery accepted. Head to the kitchen when it is ready.');
    if (ok && !sharingGps) startGpsSharing();
  };

  const pickedUp = async (order: Order) => {
    const ok = await run(order, { status: 'out_for_delivery', deliveryStatus: 'picked_up' }, 'Picked up. Live GPS tracking active!');
    if (ok && !sharingGps) startGpsSharing();
  };

  const openComplete = (order: Order) => {
    setCashConfirmed(false);
    setPhoto(null);
    setCompleting(order);
  };

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setPhoto(await resizeWithPreset(file, 'proof'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not use that photo.');
    }
  };

  const complete = async () => {
    if (!completing) return;
    const cashDue = isCashDue(completing);
    if (cashDue && !cashConfirmed) {
      toast.error(`Confirm that you collected ${formatMoney(completing.total)} in cash.`);
      return;
    }
    const order = completing;
    const ok = await run(
      order,
      {
        status: 'completed',
        deliveryStatus: 'delivered',
        ...(cashDue ? { paymentStatus: 'paid', paidAt: serverTimestamp(), paymentCollectedBy: driverName } : {}),
      },
      'Delivered! Great job.',
    );
    if (!ok) return;
    setCompleting(null);
    // The photo is saved next to the order (not inside it) and never blocks the hand-over.
    if (photo && userProfile) {
      saveProofPhoto(order.id, photo, { uid: userProfile.uid, name: driverName }).catch((err) =>
        reportError(err, 'proof-photo', { message: 'The delivery was completed, but the photo could not be saved.' }),
      );
    }
  };

  const cashToCollect = useMemo(() => mine.filter(isCashDue).reduce((sum, o) => sum + o.total, 0), [mine]);
  const storePoint = isValidGeoPoint(profile?.location) ? profile!.location : geocodedStore;

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-ink">Deliveries</h1>
          <p className="text-xs sm:text-sm text-muted mt-0.5">Accept a delivery, share live GPS, and confirm drop-off.</p>
        </div>
        {cashToCollect > 0 && (
          <div className="text-right rounded-btn bg-amber-50 border border-amber-200 px-3 py-2 shrink-0">
            <p className="text-[11px] font-semibold text-amber-800">Cash to collect</p>
            <p className="font-extrabold font-mono tabular-nums text-amber-900">{formatMoney(cashToCollect)}</p>
          </div>
        )}
      </div>

      {/* Live GPS broadcaster strip whenever the driver has active deliveries */}
      {mine.length > 0 && (
        <div
          className={`rounded-card border shadow-ios-sm p-3.5 sm:p-4 flex flex-wrap items-center justify-between gap-3 transition ${
            sharingGps ? 'bg-brand text-on-brand border-brand' : 'bg-white text-ink border-line'
          }`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={`w-9 h-9 rounded-btn flex items-center justify-center shrink-0 ${
                sharingGps ? 'bg-white/20 text-on-brand' : 'bg-accent text-brand'
              }`}
            >
              <Radio size={18} className={sharingGps ? 'animate-pulse' : ''} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold flex items-center gap-2">
                {sharingGps ? 'Live GPS sharing is ON' : 'Share your live GPS with customers'}
              </p>
              <p className={`text-xs truncate ${sharingGps ? 'opacity-85' : 'text-muted'}`}>
                {gpsError
                  ? gpsError
                  : driverPos
                    ? `Coordinates ${driverPos.lat.toFixed(4)}, ${driverPos.lng.toFixed(4)}${driverPos.accuracy ? ` · ±${Math.round(driverPos.accuracy)}m` : ''}`
                    : 'Broadcasts your position onto the customer’s live OpenStreetMap tracker.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={pingGpsNow}
              className={`min-h-[38px] px-3 py-1.5 rounded-btn text-xs font-semibold flex items-center gap-1.5 transition ${
                sharingGps ? 'bg-white/15 hover:bg-white/25 text-on-brand' : 'bg-soft hover:bg-gray-200/70 text-ink'
              }`}
            >
              <LocateFixed size={14} /> Ping now
            </button>
            <button
              type="button"
              onClick={sharingGps ? stopGpsSharing : startGpsSharing}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-btn text-xs font-bold transition ${
                sharingGps ? 'bg-red-500/90 hover:bg-red-500 text-white' : 'bg-brand hover:opacity-95 text-on-brand'
              }`}
            >
              {sharingGps ? 'Pause GPS' : 'Start live GPS'}
            </button>
          </div>
        </div>
      )}

      {mine.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-bold text-sm uppercase tracking-wider text-gray-500">
            My active deliveries ({mine.length})
          </h2>
          {mine.map((order) => {
            const cashDue = isCashDue(order);
            const pickedUp_ = order.deliveryStatus === 'picked_up' || order.status === 'out_for_delivery';
            const destPoint = isValidGeoPoint(order.deliveryLocation) ? order.deliveryLocation : geocodedTargets[order.id] || null;
            const currentDriverPoint = driverPos || (isValidGeoPoint(order.driverLocation) ? order.driverLocation : null);

            return (
              <article key={order.id} className="bg-gray-900 text-white rounded-2xl p-4 sm:p-5 space-y-4">
                <header className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-2xl font-extrabold font-mono tabular-nums">#{orderCode(order)}</h3>
                    <p className="text-sm text-gray-300 mt-0.5">{order.customerName}</p>
                  </div>
                  <span className="text-xs font-bold uppercase tracking-wide bg-white/15 px-2.5 py-1 rounded-md">
                    {pickedUp_ ? 'On the way' : order.status === 'ready' ? 'Ready for pickup' : 'Being prepared'}
                  </span>
                </header>
                {cashDue && (
                  <p className="rounded-xl bg-amber-400 text-black px-4 py-2.5 text-sm font-extrabold font-mono tabular-nums">
                    Collect {formatMoney(order.total)} cash at drop-off
                  </p>
                )}
                <div className="rounded-xl bg-white/10 p-3.5 space-y-2 text-sm">
                  <p className="flex gap-2 font-medium">
                    <MapPin size={16} className="shrink-0 mt-0.5 text-gray-300" /> {order.deliveryAddress}
                  </p>
                  {order.notes && <p className="text-xs text-amber-200 font-medium">Note: {order.notes}</p>}
                  <p className="text-xs text-gray-300">{order.items.map((i) => `${i.quantity}× ${i.name}`).join(' · ')}</p>
                </div>

                {/* Live OpenStreetMap route view for the driver */}
                {(destPoint || storePoint || currentDriverPoint) && (
                  <Suspense
                    fallback={
                      <div className="h-52 rounded-2xl bg-white/5 flex items-center justify-center text-gray-400">
                        <Spinner size={18} />
                      </div>
                    }
                  >
                    <OrderTrackingMap
                      storePoint={storePoint}
                      storeLabel={profile?.name || 'Kitchen'}
                      destinationPoint={destPoint}
                      destinationLabel={`${order.customerName || 'Customer'} · ${order.deliveryAddress || ''}`}
                      driverPoint={currentDriverPoint}
                      driverLabel="You (Driver GPS)"
                      heightClassName="h-52 sm:h-60"
                    />
                  </Suspense>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <a
                    href={navigationUrl(destPoint, order.deliveryAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[48px] flex flex-col items-center justify-center gap-1 rounded-xl bg-white/10 hover:bg-white/15 py-2.5 text-xs font-semibold transition"
                  >
                    <Navigation size={17} /> Navigate
                  </a>
                  {order.customerPhone ? (
                    <a
                      href={`tel:${order.customerPhone}`}
                      className="min-h-[48px] flex flex-col items-center justify-center gap-1 rounded-xl bg-white/10 hover:bg-white/15 py-2.5 text-xs font-semibold transition"
                    >
                      <Phone size={17} /> Call
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        downloadOrderReceiptPdf(order, profile, 'driver');
                        toast.success(`Downloaded ${receiptFilename(order, 'driver')}`);
                      }}
                      className="min-h-[48px] flex flex-col items-center justify-center gap-1 rounded-xl bg-white/10 hover:bg-white/15 py-2.5 text-xs font-semibold transition"
                    >
                      <Download size={17} /> Slip PDF
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setReceiptOrder(order)}
                    className="min-h-[48px] flex flex-col items-center justify-center gap-1 rounded-xl bg-white/10 hover:bg-white/15 py-2.5 text-xs font-semibold transition"
                  >
                    <FileText size={17} /> Receipt / Slip
                  </button>
                  {pickedUp_ ? (
                    <button
                      onClick={() => openComplete(order)}
                      className="min-h-[48px] flex flex-col items-center justify-center gap-1 rounded-xl bg-emerald-500 hover:bg-emerald-600 py-2.5 text-xs font-bold transition"
                    >
                      <CheckCircle2 size={17} /> Delivered
                    </button>
                  ) : (
                    <button
                      onClick={() => pickedUp(order)}
                      disabled={busyId === order.id || order.status !== 'ready'}
                      className="min-h-[48px] flex flex-col items-center justify-center gap-1 rounded-xl bg-white text-gray-900 py-2.5 text-xs font-bold disabled:opacity-40 transition"
                      title={order.status !== 'ready' ? 'Wait until the kitchen marks it ready' : undefined}
                    >
                      {busyId === order.id ? <Spinner size={17} /> : <Package size={17} />} Picked up
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-bold text-sm uppercase tracking-wider text-muted">
          Available for pickup ({available.length})
        </h2>
        {available.length === 0 ? (
          <div className="rounded-card border border-dashed border-line bg-white p-10 text-center text-muted text-sm">
            No deliveries waiting. New ones appear here automatically.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {available.map((order) => (
              <article key={order.id} className="bg-white rounded-card border border-line shadow-ios-sm p-4 flex flex-col gap-3">
                <header className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-extrabold text-lg font-mono tabular-nums text-ink">#{orderCode(order)}</h3>
                    <p className="text-xs text-muted mt-0.5">
                      {order.customerName} · {timeAgo(order.createdAt)}
                    </p>
                  </div>
                  <span
                    className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-md border ${
                      order.status === 'ready' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-orange-50 text-orange-700 border-orange-200'
                    }`}
                  >
                    {order.status === 'ready' ? 'Ready' : 'Cooking'}
                  </span>
                </header>
                <p className="text-sm text-ink line-clamp-2">{order.deliveryAddress}</p>
                {isCashDue(order) && (
                  <p className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200/70 rounded-btn px-3 py-1.5 tabular-nums">
                    Cash order · collect {formatMoney(order.total)}
                  </p>
                )}
                <div className="mt-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setReceiptOrder(order)}
                    className="min-h-[44px] px-3 rounded-btn bg-soft hover:bg-gray-200/70 text-ink text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition"
                    title="View Delivery Slip / Receipt"
                  >
                    <FileText size={15} className="text-brand" /> Slip
                  </button>
                  <button
                    onClick={() => accept(order)}
                    disabled={busyId === order.id}
                    className="flex-1 min-h-[44px] bg-brand hover:opacity-95 text-on-brand rounded-btn py-2.5 text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50 transition"
                  >
                    {busyId === order.id && <Spinner size={16} />} Accept delivery
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Recent completed deliveries with Delivery Slip & Receipt PDF downloads */}
      {completedMine.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-bold text-sm uppercase tracking-wider text-muted">
            Completed deliveries & receipts ({completedMine.length})
          </h2>
          <div className="bg-white rounded-card border border-line shadow-ios-sm divide-y divide-line">
            {completedMine.slice(0, 10).map((order) => (
              <div key={order.id} className="p-3.5 sm:p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-extrabold text-sm text-ink">#{orderCode(order)}</span>
                    <span className="text-xs font-semibold text-ink truncate">{order.customerName || 'Customer'}</span>
                    {!!order.deliveryTip && order.deliveryTip > 0 && (
                      <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[11px] font-mono font-bold">
                        Tip {formatMoney(order.deliveryTip)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted truncate mt-0.5">
                    {formatDateTime(order.createdAt)} · {order.deliveryAddress}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setReceiptOrder(order)}
                    className="min-h-[34px] px-3 py-1.5 rounded-btn bg-soft hover:bg-gray-200/70 text-ink text-xs font-semibold inline-flex items-center gap-1 transition"
                  >
                    <FileText size={13} className="text-brand" /> View slip
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      downloadOrderReceiptPdf(order, profile, 'driver');
                      toast.success(`Downloaded ${receiptFilename(order, 'driver')}`);
                    }}
                    className="min-h-[34px] px-3 py-1.5 rounded-btn bg-brand/10 hover:bg-brand/20 text-brand text-xs font-bold inline-flex items-center gap-1 transition"
                  >
                    <Download size={13} /> PDF
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <Sheet
        open={!!completing}
        onClose={() => setCompleting(null)}
        surface="admin"
        size="sm"
        title={`Complete #${completing ? orderCode(completing) : ''}`}
        footer={
          <button onClick={complete} disabled={!!busyId} className="w-full bg-brand hover:opacity-95 text-on-brand rounded-btn py-3.5 font-bold flex items-center justify-center gap-2 disabled:opacity-50">
            {busyId && <Spinner size={16} />} Confirm delivery
          </button>
        }
      >
        {completing && (
          <div className="p-5 space-y-4">
            {isCashDue(completing) && (
              <label className="flex items-start gap-3 rounded-2xl bg-amber-50 border border-amber-200 p-4 cursor-pointer">
                <input type="checkbox" checked={cashConfirmed} onChange={(e) => setCashConfirmed(e.target.checked)} className="w-5 h-5 mt-0.5 accent-amber-600" />
                <span className="text-sm text-amber-900">
                  I collected <strong className="font-mono tabular-nums">{formatMoney(completing.total)}</strong> in cash from the customer.
                </span>
              </label>
            )}
            <div>
              <p className="text-sm font-semibold mb-2">Proof of delivery (optional)</p>
              {photo ? (
                <img src={photo} alt="Proof of delivery" className="rounded-2xl w-full max-h-64 object-cover" />
              ) : (
                <label className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gray-200 py-8 text-sm font-semibold text-gray-600 cursor-pointer">
                  <Camera size={18} /> Take a photo
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPhoto} />
                </label>
              )}
            </div>
          </div>
        )}
      </Sheet>

      <ReceiptModal
        order={receiptOrder}
        profile={profile}
        onClose={() => setReceiptOrder(null)}
        defaultVariant="driver"
        allowVariantSwitch
        surface="admin"
      />
    </div>
  );
};
