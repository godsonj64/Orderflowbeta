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
import { AutoFitBadgeText, BannerPatternGraphic } from './StatusBanner';
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

  // Solid accent palette per receipt variant (inspired by Industrial Aqua, Heat Marker, and Emerald swatch blocks)
  const headerAccent =
    variant === 'driver'
      ? {
          blockBg: 'bg-[#4FBBBC]',
          blockText: 'text-[#111315]',
          kickerColor: 'text-[#4FBBBC]',
          pattern: 'contours' as const,
          title: 'DRIVER DELIVERY SLIP',
        }
      : variant === 'kitchen'
        ? {
            blockBg: 'bg-[#F39120]',
            blockText: 'text-[#111315]',
            kickerColor: 'text-[#F39120]',
            pattern: 'checker' as const,
            title: 'KITCHEN PREP TICKET',
          }
        : {
            blockBg: 'bg-[#16A34A]',
            blockText: 'text-white',
            kickerColor: 'text-[#4ADE80]',
            pattern: 'waves' as const,
            title: 'OFFICIAL ORDER RECEIPT',
          };

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
            className="flex-1 min-h-[44px] px-5 py-2.5 rounded-btn bg-[#111315] text-white text-sm font-extrabold flex items-center justify-center gap-2 shadow-md transition hover:opacity-95 active:scale-[0.99]"
          >
            <Download size={16} className="text-[#4FBBBC]" />
            <span>
              Download {variant === 'driver' ? 'Delivery Slip' : variant === 'kitchen' ? 'Kitchen Ticket' : 'Receipt'} (PDF)
            </span>
          </button>
        </div>
      }
    >
      <div className="p-4 sm:p-6 space-y-4">
        {allowVariantSwitch && (
          <div className="flex items-center gap-1 p-1 bg-[#111315] rounded-btn">
            {variantLabels.map((v) => {
              const active = variant === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariant(v.id)}
                  className={`flex-1 min-h-[36px] px-2.5 py-1.5 rounded-btn text-xs font-extrabold transition whitespace-nowrap ${
                    active ? 'bg-[#F39120] text-[#111315] shadow-xs' : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Solid Architectural Receipt Card */}
        <div className="rounded-card border border-neutral-300 bg-white text-gray-900 shadow-xl overflow-hidden">
          {/* Top Solid Split-Block Header Banner (auto-scales #CODE so it never overflows) */}
          <div className="flex items-stretch bg-[#111315] text-white overflow-hidden">
            {/* Left Solid Order Code & Mode Block */}
            <div
              className={`w-28 sm:w-32 shrink-0 ${headerAccent.blockBg} ${headerAccent.blockText} px-3 py-4 flex flex-col items-center justify-center text-center select-none overflow-hidden`}
            >
              <span className="text-[8.5px] font-black uppercase tracking-[0.18em] opacity-80 mb-1">
                ORDER
              </span>
              <AutoFitBadgeText maxPx={20} minPx={10}>
                {`#${code}`}
              </AutoFitBadgeText>
              <span className="mt-1.5 text-[9px] font-extrabold uppercase tracking-[0.16em] opacity-95">
                {isDelivery ? 'DELIVERY' : 'PICKUP'}
              </span>
            </div>

            {/* Center Solid Iron Core Store Identity */}
            <div className="flex-1 min-w-0 px-3.5 sm:px-5 py-3.5 sm:py-4 flex flex-col justify-center bg-[#111315]">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <p className={`text-[9.5px] sm:text-[10px] font-extrabold uppercase tracking-[0.15em] truncate ${headerAccent.kickerColor}`}>
                  {headerAccent.title}
                </p>
                <span className="shrink-0 text-[9.5px] sm:text-[10px] font-extrabold uppercase tracking-wider text-neutral-300">
                  {STATUS_LABEL[order.status]}
                </span>
              </div>
              <h3 className="font-display text-lg sm:text-xl font-extrabold tracking-tight text-white truncate mt-0.5">
                {storeName}
              </h3>
              {(profile?.address || profile?.phone) && (
                <p className="text-[11px] sm:text-xs text-neutral-300 mt-0.5 leading-snug break-words tabular-nums">
                  {[profile?.address, profile?.phone].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>

            {/* Right Decorative Pattern Strip */}
            <div className={`w-6 sm:w-9 shrink-0 ${headerAccent.blockBg} relative overflow-hidden`} aria-hidden="true">
              <div className="absolute inset-0 text-[#111315]">
                <BannerPatternGraphic pattern={headerAccent.pattern} />
              </div>
            </div>
          </div>

          <div className="p-4 sm:p-5 space-y-4">
            {/* Solid Split-Block Payment / Cash Collection Banner */}
            <div className="flex items-stretch overflow-hidden rounded-control bg-[#181E1E] text-white shadow-sm">
              <div
                className={`w-22 sm:w-24 shrink-0 px-2.5 py-3 flex flex-col items-center justify-center text-center ${
                  cashDue ? 'bg-[#F39120] text-[#111315]' : 'bg-[#16A34A] text-white'
                }`}
              >
                {paymentMethodOf(order) === 'cash' ? <Banknote size={16} strokeWidth={2.5} /> : <CreditCard size={16} strokeWidth={2.5} />}
                <span className="mt-1 text-[9px] font-black uppercase tracking-[0.15em] leading-none">
                  {cashDue ? 'CASH DUE' : 'PAID'}
                </span>
              </div>

              <div className="flex-1 min-w-0 px-3.5 sm:px-4 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-extrabold text-white leading-snug break-words">
                    {cashDue
                      ? `Collect ${formatMoney(order.total)} in cash ${isDelivery ? 'at drop-off' : 'at pickup'}`
                      : `${pay.label}${variant === 'driver' ? ' · Do not collect cash' : ''}`}
                  </p>
                  <p className="text-[11px] text-neutral-400 mt-0.5 break-words leading-snug">
                    {order.paymentCollectedBy && order.paymentStatus === 'paid'
                      ? `Recorded by ${order.paymentCollectedBy}`
                      : `Ref: ${order.id.slice(0, 14)}`}
                  </p>
                </div>
                <span
                  className={`font-mono font-black text-base sm:text-lg tabular-nums shrink-0 ${
                    cashDue ? 'text-[#F39120]' : 'text-[#4ADE80]'
                  }`}
                >
                  {formatMoney(order.total)}
                </span>
              </div>
            </div>

            {/* Architectural Cream 3-Column Metadata Swatch Card (inspired by IRON CORE / ARCHITECTURAL CREAM reference) */}
            <div className="rounded-control bg-[#EFECE1] border border-[#DDD6C0] p-3.5 sm:p-4 text-[#181E1E]">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                <div className="space-y-0.5 min-w-0">
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-[#EC4624]">
                    PLACED & TIMING
                  </p>
                  <p className="text-xs sm:text-sm font-bold text-[#181E1E] tabular-nums break-words">{createdStr}</p>
                  {order.scheduledTime ? (
                    <p className="text-xs font-extrabold text-[#111315]">Scheduled: {order.scheduledTime}</p>
                  ) : (
                    <p className="text-[11px] text-[#222A2A]/75">ASAP kitchen preparation</p>
                  )}
                </div>

                <div className="space-y-0.5 min-w-0 sm:border-l sm:border-[#D5CEB5] sm:pl-3.5">
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-[#EC4624]">
                    CUSTOMER
                  </p>
                  <p className="text-xs sm:text-sm font-extrabold text-[#181E1E] break-words">
                    {order.customerName || 'Guest'}
                  </p>
                  {order.customerPhone ? (
                    <p className="text-xs text-[#222A2A]/85 flex items-center gap-1 tabular-nums">
                      <Phone size={11} className="text-[#EC4624] shrink-0" /> {order.customerPhone}
                    </p>
                  ) : (
                    <p className="text-[11px] text-[#222A2A]/60">No phone listed</p>
                  )}
                </div>

                <div className="space-y-0.5 min-w-0 sm:border-l sm:border-[#D5CEB5] sm:pl-3.5">
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-[#EC4624]">
                    {isDelivery ? 'DELIVERY DESTINATION' : 'PICKUP LOCATION'}
                  </p>
                  {isDelivery && order.deliveryAddress ? (
                    <p className="text-xs text-[#181E1E] font-semibold flex items-start gap-1 leading-snug break-words">
                      <MapPin size={12} className="text-[#EC4624] shrink-0 mt-0.5" />
                      <span>{order.deliveryAddress}</span>
                    </p>
                  ) : (
                    <p className="text-xs text-[#181E1E] font-semibold break-words">
                      {profile?.address || storeName}
                    </p>
                  )}
                  {order.driverName && (
                    <p className="text-[11px] font-bold text-[#222A2A] flex items-center gap-1 pt-0.5">
                      <Truck size={11} className="text-[#EC4624] shrink-0" /> Driver: {order.driverName}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Solid Rust Signal Banner for Special Order Notes */}
            {order.notes && (
              <div className="flex items-stretch overflow-hidden rounded-control bg-[#111315] text-white">
                <div className="w-20 shrink-0 bg-[#EC4624] text-white px-2.5 py-2.5 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] font-black uppercase tracking-[0.16em]">NOTE</span>
                </div>
                <div className="flex-1 px-3.5 py-2.5 text-xs sm:text-sm font-semibold text-white flex items-center break-words">
                  {order.notes}
                </div>
              </div>
            )}

            {/* Driver Payout Summary Box when viewing Driver Slip */}
            {variant === 'driver' && (
              <div className="rounded-control bg-[#111315] text-white p-3.5 grid grid-cols-3 gap-2 text-center border border-white/10">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-[#4FBBBC] font-extrabold">Delivery fee</p>
                  <p className="font-mono font-black text-sm sm:text-base mt-0.5 tabular-nums text-white">
                    {formatMoney(order.deliveryFee || 0)}
                  </p>
                </div>
                <div className="border-x border-white/10">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-[#4ADE80] font-extrabold">Driver tip</p>
                  <p className="font-mono font-black text-sm sm:text-base mt-0.5 text-[#4ADE80] tabular-nums">
                    {formatMoney(order.deliveryTip || 0)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-[#F39120] font-extrabold">Cash to collect</p>
                  <p className="font-mono font-black text-sm sm:text-base mt-0.5 text-[#F39120] tabular-nums">
                    {cashDue ? formatMoney(order.total) : '$0.00'}
                  </p>
                </div>
              </div>
            )}

            {/* Itemized Line Items */}
            <div>
              <div className="flex items-center justify-between px-3 py-2 rounded-t-lg bg-[#222A2A] text-white text-[10px] font-extrabold uppercase tracking-[0.16em]">
                <span className="flex items-center gap-1.5">
                  <UtensilsCrossed size={12} className="text-[#F39120]" />
                  <span>ITEMIZED ORDER ({order.items.reduce((s, i) => s + i.quantity, 0)})</span>
                </span>
                {variant !== 'kitchen' && <span>LINE TOTAL</span>}
              </div>
              <ul className="divide-y divide-gray-200 border-x border-b border-gray-200 rounded-b-lg px-3">
                {order.items.map((item, i) => (
                  <li key={i} className="py-2.5 flex items-start justify-between gap-3 text-xs sm:text-sm">
                    <div className="min-w-0">
                      <p className="font-bold text-gray-900">
                        <span className="inline-flex items-center justify-center min-w-6 px-1.5 py-0.5 rounded bg-[#111315] text-white font-mono text-xs font-extrabold tabular-nums mr-2">
                          {item.quantity}×
                        </span>
                        {item.name}
                        {variant !== 'kitchen' && item.quantity > 1 && (
                          <span className="text-xs font-normal text-gray-500 font-mono tabular-nums ml-1.5">
                            (@ {formatMoney(item.price)})
                          </span>
                        )}
                      </p>
                      {item.selectedModifiers?.length > 0 && (
                        <p className="text-xs text-gray-600 pl-8 mt-0.5">
                          {item.selectedModifiers
                            .map((m) => (m.groupName ? `${m.groupName}: ${m.name}` : m.name))
                            .join(' · ')}
                        </p>
                      )}
                      {item.prepNotes && (
                        <p className="text-xs font-extrabold text-[#EC4624] pl-8 mt-0.5">
                          Prep note: “{item.prepNotes}”
                        </p>
                      )}
                    </div>
                    {variant !== 'kitchen' && (
                      <span className="font-mono font-extrabold text-gray-900 tabular-nums shrink-0">
                        {formatMoney(item.price * item.quantity)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {/* Totals Breakdown + Solid Grand Total Banner */}
            {variant !== 'kitchen' && (
              <div className="space-y-3">
                <div className="px-1 space-y-1.5 text-xs sm:text-sm">
                  <div className="flex justify-between text-gray-600">
                    <span>Subtotal</span>
                    <span className="font-mono font-semibold text-gray-900 tabular-nums">{formatMoney(computedSubtotal)}</span>
                  </div>
                  {!!order.discountAmount && order.discountAmount > 0 && (
                    <div className="flex justify-between text-[#16A34A] font-bold">
                      <span>Discount{order.promoCode ? ` (${order.promoCode})` : ''}</span>
                      <span className="font-mono tabular-nums">−{formatMoney(order.discountAmount)}</span>
                    </div>
                  )}
                  {!!order.deliveryFee && order.deliveryFee > 0 && (
                    <div className="flex justify-between text-gray-600">
                      <span>Delivery fee</span>
                      <span className="font-mono font-semibold text-gray-900 tabular-nums">{formatMoney(order.deliveryFee)}</span>
                    </div>
                  )}
                  {!!order.serviceFee && order.serviceFee > 0 && (
                    <div className="flex justify-between text-gray-600">
                      <span>Service fee</span>
                      <span className="font-mono font-semibold text-gray-900 tabular-nums">{formatMoney(order.serviceFee)}</span>
                    </div>
                  )}
                  {!!order.tax && order.tax > 0 && (
                    <div className="flex justify-between text-gray-600">
                      <span>Tax</span>
                      <span className="font-mono font-semibold text-gray-900 tabular-nums">{formatMoney(order.tax)}</span>
                    </div>
                  )}
                  {!!order.restaurantTip && order.restaurantTip > 0 && (
                    <div className="flex justify-between text-gray-600">
                      <span>Restaurant tip</span>
                      <span className="font-mono font-semibold text-gray-900 tabular-nums">{formatMoney(order.restaurantTip)}</span>
                    </div>
                  )}
                  {!!order.deliveryTip && order.deliveryTip > 0 && (
                    <div className="flex justify-between text-gray-600">
                      <span>Driver tip</span>
                      <span className="font-mono font-semibold text-gray-900 tabular-nums">{formatMoney(order.deliveryTip)}</span>
                    </div>
                  )}
                </div>

                {/* Solid Split-Block Grand Total Bar */}
                <div className="flex items-stretch overflow-hidden rounded-control bg-[#111315] text-white">
                  <div
                    className={`px-3.5 py-3 flex items-center ${
                      cashDue ? 'bg-[#F39120] text-[#111315]' : 'bg-[#222A2A] text-[#4FBBBC]'
                    }`}
                  >
                    <span className="text-[10px] font-black uppercase tracking-[0.16em] whitespace-nowrap">
                      {cashDue ? 'TOTAL DUE (CASH)' : 'GRAND TOTAL'}
                    </span>
                  </div>
                  <div className="flex-1 px-4 py-3 flex items-center justify-between gap-2 min-w-0">
                    <span className="text-xs text-neutral-400 truncate">
                      {cashDue ? 'Payable upon hand-off' : pay.label}
                    </span>
                    <span className="font-mono font-black text-lg sm:text-xl text-white tabular-nums shrink-0">
                      {formatMoney(order.total)}
                    </span>
                  </div>
                </div>

                {!!order.refundAmount && order.refundAmount > 0 && (
                  <div className="flex items-center justify-between rounded-control bg-[#EC4624] text-white px-3.5 py-2 text-xs font-extrabold font-mono tabular-nums">
                    <span>REFUND ISSUED</span>
                    <span>
                      −{formatMoney(order.refundAmount)} (Net {formatMoney(netAmount(order))})
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Receipt Footer */}
            <div className="pt-2 border-t border-dashed border-gray-200 flex items-center justify-between text-[11px] text-gray-500">
              <span className="inline-flex items-center gap-1 font-semibold">
                <CheckCircle2 size={12} className="text-[#16A34A]" /> Verified OrderFlow Receipt
              </span>
              <span className="font-mono font-bold tabular-nums">#{code}</span>
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
