import React, { useEffect, useMemo, useState } from 'react';
import { Timestamp, collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { endOfDay, format, startOfDay, subDays } from 'date-fns';
import toast from 'react-hot-toast';
import {
  Clock,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  Layers,
  Receipt,
  Search,
  SlidersHorizontal,
  TrendingUp,
  Truck,
  UtensilsCrossed,
} from 'lucide-react';
import { db } from '../firebase';
import type { Order } from '../types';
import { useAuth } from '../context/AuthContext';
import { useStore } from '../context/StoreContext';
import { computeDetailedAnalytics, formatOrderItemsSummary, isSaleOrder } from '../lib/analytics';
import { formatDateTime, toDate, toMillis } from '../lib/dates';
import { orderCode } from '../lib/ids';
import { formatMoney } from '../lib/money';
import { STATUS_LABEL, STATUS_STYLE, isCashDue, netAmount, paymentMethodOf, paymentSummary } from '../lib/orderStatus';
import {
  downloadOrderReceiptPdf,
  downloadPdfBytes,
  generateSalesReportPdf,
  type SalesReportSections,
} from '../lib/pdf';
import { reportError } from '../utils/errorHandling';
import { ReceiptModal } from './ReceiptModal';
import { Sheet, Spinner, adminInput } from './ui';

type Range = 'today' | 'yesterday' | '7d' | '30d' | 'custom';
type BreakdownTab = 'overview' | 'catalog' | 'operations' | 'ledger';
type ReportOrderSubset = 'valid_sales' | 'all_orders' | 'card_only' | 'cash_only' | 'delivery_only' | 'pickup_only';

const RANGE_LABEL: Record<Range, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': '7 days',
  '30d': '30 days',
  custom: 'Custom',
};

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function bounds(range: Range, customStart: string, customEnd: string): [Date, Date] | null {
  const now = new Date();
  switch (range) {
    case 'today':
      return [startOfDay(now), endOfDay(now)];
    case 'yesterday': {
      const y = subDays(now, 1);
      return [startOfDay(y), endOfDay(y)];
    }
    case '7d':
      return [startOfDay(subDays(now, 6)), endOfDay(now)];
    case '30d':
      return [startOfDay(subDays(now, 29)), endOfDay(now)];
    case 'custom': {
      if (!customStart || !customEnd) return null;
      const d1 = new Date(`${customStart}T00:00`);
      const d2 = new Date(`${customEnd}T00:00`);
      if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
      const [first, second] = d1 <= d2 ? [d1, d2] : [d2, d1];
      return [startOfDay(first), endOfDay(second)];
    }
  }
}

export const AdminFinancials: React.FC<{ orders: Order[] }> = ({ orders }) => {
  const { profile, categories, items } = useStore();
  const { userProfile } = useAuth();

  const [range, setRange] = useState<Range>('today');
  const [activeTab, setActiveTab] = useState<BreakdownTab>('overview');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [customOrders, setCustomOrders] = useState<Order[] | null>(null);
  const [loadingCustom, setLoadingCustom] = useState(false);

  const [itemSearch, setItemSearch] = useState('');
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null);

  // Custom PDF Report Builder Modal state
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportTitle, setReportTitle] = useState('');
  const [reportNotes, setReportNotes] = useState('');
  const [reportSubset, setReportSubset] = useState<ReportOrderSubset>('valid_sales');
  const [reportSections, setReportSections] = useState<SalesReportSections>({
    executiveSummary: true,
    paymentAndFulfillment: true,
    categoryBreakdown: true,
    itemBreakdown: true,
    hourlyAndWeekday: true,
    promoAndDriver: true,
    orderLedger: true,
  });

  const window_ = bounds(range, customStart, customEnd);

  const periodDescription = useMemo(() => {
    if (!window_) return 'Select start and end dates';
    const [s, e] = window_;
    if (range === 'today') return `Today (${format(s, 'MMM d, yyyy')})`;
    if (range === 'yesterday') return `Yesterday (${format(s, 'MMM d, yyyy')})`;
    return `${format(s, 'MMM d, yyyy')} - ${format(e, 'MMM d, yyyy')}`;
  }, [window_, range]);

  // The dashboard streams the last 30 days; older custom ranges are fetched on demand.
  useEffect(() => {
    if (range !== 'custom' || !window_) {
      setCustomOrders(null);
      return;
    }
    let cancelled = false;
    setLoadingCustom(true);
    getDocs(
      query(
        collection(db, 'orders'),
        where('createdAt', '>=', Timestamp.fromDate(window_[0])),
        where('createdAt', '<=', Timestamp.fromDate(window_[1])),
        orderBy('createdAt', 'desc'),
      ),
    )
      .then((snap) => !cancelled && setCustomOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Order)))
      .catch((err) => reportError(err, 'financials-range'))
      .finally(() => !cancelled && setLoadingCustom(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, customStart, customEnd]);

  const inRange = useMemo(() => {
    if (!window_) return [];
    const source = range === 'custom' ? customOrders || [] : orders;
    const [start, end] = window_;
    return source.filter((o) => {
      const t = toMillis(o.createdAt, Date.now());
      return t >= start.getTime() && t <= end.getTime();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, customOrders, range, customStart, customEnd]);

  const analytics = useMemo(
    () => computeDetailedAnalytics(inRange, { categories, items }),
    [inRange, categories, items],
  );

  const chart = useMemo(() => {
    if (!window_) return [];
    const sales = inRange.filter(isSaleOrder);
    const [start, end] = window_;
    const singleDay = end.getTime() - start.getTime() <= 24 * 60 * 60 * 1000;
    const buckets = new Map<string, number>();
    if (singleDay) {
      for (let h = 0; h < 24; h++) buckets.set(`${h}`, 0);
      for (const o of sales) {
        const d = toDate(o.createdAt);
        if (d) {
          buckets.set(`${d.getHours()}`, (buckets.get(`${d.getHours()}`) || 0) + netAmount(o));
        }
      }
      return [...buckets.entries()]
        .map(([h, rev]) => ({
          label: format(new Date(2000, 0, 1, Number(h)), 'ha'),
          revenue: Number(rev.toFixed(2)),
        }))
        .filter((_, i, all) => i >= 6 || all.slice(0, 6).some((x) => x.revenue > 0));
    }
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
      buckets.set(format(d, 'MMM d'), 0);
    }
    for (const o of sales) {
      const d = toDate(o.createdAt);
      if (!d) continue;
      const key = format(d, 'MMM d');
      buckets.set(key, (buckets.get(key) || 0) + netAmount(o));
    }
    return [...buckets.entries()].map(([label, rev]) => ({ label, revenue: Number(rev.toFixed(2)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRange]);

  const filteredItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return analytics.itemBreakdown;
    return analytics.itemBreakdown.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.categoryName.toLowerCase().includes(q) ||
        i.topModifiers.some((m) => m.toLowerCase().includes(q)),
    );
  }, [analytics.itemBreakdown, itemSearch]);

  const ledgerOrders = useMemo(() => {
    const q = ledgerSearch.trim().toLowerCase();
    return inRange
      .filter((o) => o.status !== 'payment_pending')
      .filter((o) => {
        if (!q) return true;
        return (
          orderCode(o).toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q) ||
          o.customerName?.toLowerCase().includes(q) ||
          o.customerPhone?.includes(q) ||
          o.driverName?.toLowerCase().includes(q) ||
          o.items.some((i) => i.name.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => toMillis(b.createdAt, Date.now()) - toMillis(a.createdAt, Date.now()));
  }, [inRange, ledgerSearch]);

  // Orders filtered according to the Custom PDF Report modal's subset selector
  const customReportOrders = useMemo(() => {
    return inRange.filter((o) => {
      if (o.status === 'payment_pending') return false;
      if (reportSubset === 'valid_sales') return isSaleOrder(o);
      if (reportSubset === 'card_only') return isSaleOrder(o) && paymentMethodOf(o) === 'card';
      if (reportSubset === 'cash_only') return isSaleOrder(o) && paymentMethodOf(o) === 'cash';
      if (reportSubset === 'delivery_only') return isSaleOrder(o) && o.type === 'delivery';
      if (reportSubset === 'pickup_only') return isSaleOrder(o) && o.type === 'pickup';
      return true;
    });
  }, [inRange, reportSubset]);

  const customReportAnalytics = useMemo(
    () => computeDetailedAnalytics(customReportOrders, { categories, items }),
    [customReportOrders, categories, items],
  );

  const exportCsv = () => {
    const header = [
      'Order',
      'Date',
      'Customer',
      'Phone',
      'Type',
      'Status',
      'Payment method',
      'Payment status',
      'Collected by',
      'Driver',
      'Subtotal',
      'Discount',
      'Promo',
      'Delivery fee',
      'Service fee',
      'Tax',
      'Tip',
      'Driver tip',
      'Total',
      'Refunded',
      'Net amount',
      'Items',
    ];
    const rows = inRange
      .filter((o) => o.status !== 'payment_pending')
      .map((o) =>
        [
          orderCode(o),
          toDate(o.createdAt)?.toISOString() || '',
          o.customerName || '',
          o.customerPhone || '',
          o.type,
          o.status,
          paymentMethodOf(o),
          o.paymentStatus || '',
          o.paymentCollectedBy || '',
          o.driverName || '',
          (o.subtotal ?? '').toString(),
          (o.discountAmount || 0).toFixed(2),
          o.promoCode || '',
          (o.deliveryFee || 0).toFixed(2),
          (o.serviceFee || 0).toFixed(2),
          (o.tax || 0).toFixed(2),
          (o.restaurantTip || 0).toFixed(2),
          (o.deliveryTip || 0).toFixed(2),
          o.total.toFixed(2),
          (o.refundAmount || 0).toFixed(2),
          netAmount(o).toFixed(2),
          formatOrderItemsSummary(o),
        ]
          .map(csvCell)
          .join(','),
      );
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales_${range}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Exported CSV spreadsheet');
  };

  const handleDownloadQuickPdf = () => {
    try {
      const storeName = profile?.name?.trim() || 'Restaurant';
      const bytes = generateSalesReportPdf({
        title: `${storeName} - Sales & Insights Report`,
        rangeLabel: periodDescription,
        preparedBy: userProfile?.name || userProfile?.email || 'Manager',
        profile,
        analytics,
        orders: inRange,
      });
      const filename = `Sales_Report_${range}_${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      downloadPdfBytes(bytes, filename);
      toast.success(`Downloaded ${filename}`);
    } catch {
      toast.error('Could not generate the PDF report.');
    }
  };

  const handleDownloadCustomPdf = () => {
    const anySectionSelected = Object.values(reportSections).some(Boolean);
    if (!anySectionSelected) {
      toast.error('Select at least one report section to include in the PDF.');
      return;
    }
    try {
      const storeName = profile?.name?.trim() || 'Restaurant';
      const subsetLabel: Record<ReportOrderSubset, string> = {
        valid_sales: 'Valid Sales',
        all_orders: 'All Orders (incl. Cancelled)',
        card_only: 'Card Payments Only',
        cash_only: 'Cash Orders Only',
        delivery_only: 'Delivery Orders Only',
        pickup_only: 'Pickup Orders Only',
      };
      const bytes = generateSalesReportPdf({
        title: reportTitle.trim() || `${storeName} - Custom Financial Report`,
        rangeLabel: `${periodDescription} · ${subsetLabel[reportSubset]}`,
        preparedBy: userProfile?.name || userProfile?.email || 'Manager',
        notes: reportNotes.trim() || undefined,
        profile,
        analytics: customReportAnalytics,
        orders: customReportOrders,
        sections: reportSections,
      });
      const filename = `Custom_Sales_Report_${range}_${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      downloadPdfBytes(bytes, filename);
      setReportModalOpen(false);
      toast.success(`Downloaded ${filename}`);
    } catch {
      toast.error('Could not generate the custom PDF report.');
    }
  };

  const toggleReportSection = (key: keyof SalesReportSections) => {
    setReportSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const Stat = ({
    label,
    value,
    hint,
    tone = '',
    accent = false,
  }: {
    label: string;
    value: string;
    hint?: string;
    tone?: string;
    accent?: boolean;
  }) => (
    <div className={`rounded-card border shadow-ios-sm p-3.5 sm:p-4 ${tone || 'bg-white border-line'}`}>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`text-lg sm:text-2xl font-display font-extrabold tabular-nums mt-0.5 ${accent ? 'text-brand' : 'text-ink'}`}>
        {value}
      </p>
      {hint && <p className="text-[11px] text-muted mt-0.5 tabular-nums">{hint}</p>}
    </div>
  );

  const subTabs: { id: BreakdownTab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
    { id: 'overview', label: 'Overview & Revenue', icon: TrendingUp },
    { id: 'catalog', label: 'Categories & Items', icon: UtensilsCrossed },
    { id: 'operations', label: 'Peak Hours & Drivers', icon: Clock },
    { id: 'ledger', label: `Order Ledger (${ledgerOrders.length})`, icon: Receipt },
  ];

  return (
    <section className="space-y-4 sm:space-y-5">
      {/* Top Controls: Date Range Selector + PDF & CSV Export Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-white border border-line shadow-2xs rounded-btn overflow-x-auto hide-scrollbar">
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`shrink-0 min-h-[34px] px-3 py-1.5 rounded-btn text-xs font-bold transition whitespace-nowrap ${
                range === r ? 'bg-brand text-on-brand shadow-xs' : 'text-muted hover:text-ink'
              }`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (!reportTitle) {
                setReportTitle(`${profile?.name || 'Restaurant'} - Sales & Financial Report`);
              }
              setReportModalOpen(true);
            }}
            className="min-h-[36px] flex items-center gap-1.5 px-3.5 py-1.5 rounded-btn text-xs font-bold bg-brand hover:opacity-95 text-on-brand shadow-xs whitespace-nowrap transition"
          >
            <SlidersHorizontal size={14} />
            <span>Custom PDF Report</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadQuickPdf}
            disabled={!window_}
            className="min-h-[36px] flex items-center gap-1.5 px-3.5 py-1.5 rounded-btn text-xs font-bold bg-white border border-line hover:bg-soft text-ink shadow-2xs disabled:opacity-40 whitespace-nowrap transition"
          >
            <FileText size={14} className="text-brand" />
            <span>Quick PDF</span>
          </button>

          <button
            type="button"
            onClick={exportCsv}
            disabled={!inRange.length}
            className="min-h-[36px] flex items-center gap-1.5 px-3.5 py-1.5 rounded-btn text-xs font-bold bg-white border border-line hover:bg-soft text-ink shadow-2xs disabled:opacity-40 whitespace-nowrap transition"
          >
            <FileSpreadsheet size={14} className="text-brand" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {range === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 bg-white border border-line rounded-card p-3">
          <span className="text-xs font-semibold text-muted">Custom date range:</span>
          <input
            type="date"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            className={`${adminInput} max-w-[165px]`}
            aria-label="Start date"
          />
          <span className="text-muted">–</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            className={`${adminInput} max-w-[165px]`}
            aria-label="End date"
          />
          {loadingCustom && <Spinner className="text-muted" />}
        </div>
      )}

      {/* Executive KPI Summary Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <Stat
          label="Net collected sales"
          value={formatMoney(analytics.netSales)}
          hint={`${analytics.salesCount} sales · avg ${formatMoney(analytics.avgOrderValue)}`}
          accent
        />
        <Stat
          label="Gross billed total"
          value={formatMoney(analytics.grossTotal)}
          hint={`Food subtotal ${formatMoney(analytics.grossSubtotal)}`}
        />
        <Stat
          label="Card collected"
          value={formatMoney(analytics.cardCollected)}
          hint={`${analytics.paymentBreakdown[0]?.orders || 0} card orders`}
        />
        <Stat
          label="Cash collected"
          value={formatMoney(analytics.cashCollected)}
          hint={analytics.cashDue > 0 ? `${formatMoney(analytics.cashDue)} still due` : 'All cash settled'}
          tone={analytics.cashDue > 0 ? 'bg-amber-50 border-amber-200' : ''}
        />
        <Stat
          label="Total tips"
          value={formatMoney(analytics.totalTips)}
          hint={`Store ${formatMoney(analytics.restaurantTips)} · Driver ${formatMoney(analytics.deliveryTips)}`}
        />
        <Stat
          label="Tax & service fees"
          value={formatMoney(analytics.tax + analytics.serviceFees)}
          hint={`Tax ${formatMoney(analytics.tax)} · Fees ${formatMoney(analytics.serviceFees)}`}
        />
        <Stat
          label="Discounts & refunds"
          value={formatMoney(analytics.discounts + analytics.refunds)}
          hint={`Promos ${formatMoney(analytics.discounts)} · Refunds ${formatMoney(analytics.refunds)}`}
        />
        <Stat
          label="Pickup / Delivery"
          value={`${analytics.pickupCount} / ${analytics.deliveryCount}`}
          hint={`${analytics.totalItemsSold} items (${analytics.avgItemsPerOrder}/order)`}
        />
      </div>

      {/* Sub-navigation tabs for Detailed Breakdowns */}
      <div className="flex items-center gap-1 p-1 bg-white border border-line shadow-2xs rounded-btn overflow-x-auto hide-scrollbar">
        {subTabs.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`flex-1 sm:flex-initial shrink-0 min-h-[36px] px-3.5 py-1.5 rounded-btn text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 transition whitespace-nowrap ${
                active ? 'bg-brand text-on-brand shadow-xs' : 'text-muted hover:text-ink'
              }`}
            >
              <Icon size={14} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: Overview & Revenue Reconciliation */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
            {/* Revenue Trend Bar Chart */}
            <div className="lg:col-span-2 bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="font-display font-extrabold text-sm sm:text-base text-ink">Revenue timeline</h3>
                  <p className="text-xs text-muted">{periodDescription}</p>
                </div>
                {analytics.peakHour && (
                  <span className="px-2.5 py-1 rounded-btn bg-soft text-xs font-semibold text-ink">
                    Peak hour: <strong className="text-brand">{analytics.peakHour.label}</strong> ({formatMoney(analytics.peakHour.revenue)})
                  </span>
                )}
              </div>
              <div className="h-56 sm:h-64">
                {chart.some((c) => c.revenue > 0) ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chart} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#EDF0EE" />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#6E7A74', fontSize: 11 }} interval="preserveStartEnd" />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6E7A74', fontSize: 11 }} tickFormatter={(v) => `$${v}`} width={52} />
                      <Tooltip
                        cursor={{ fill: '#F1F4F2' }}
                        contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 4px 12px rgb(0 0 0 / 0.1)' }}
                        formatter={(v: number) => [formatMoney(v), 'Net revenue']}
                      />
                      <Bar dataKey="revenue" fill="var(--color-brand)" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-sm text-muted">
                    No sales recorded in this period
                  </div>
                )}
              </div>
            </div>

            {/* Gross-to-Net Revenue Reconciliation Waterfall */}
            <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5 flex flex-col justify-between">
              <div>
                <h3 className="font-display font-extrabold text-sm sm:text-base text-ink">Revenue reconciliation</h3>
                <p className="text-xs text-muted mb-3">Exact gross-to-net accounting breakdown</p>
                <dl className="space-y-2 text-xs sm:text-sm">
                  <div className="flex justify-between text-ink">
                    <dt>Food & drink subtotal</dt>
                    <dd className="font-mono font-semibold tabular-nums">{formatMoney(analytics.grossSubtotal)}</dd>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <dt>Promo discounts</dt>
                    <dd className="font-mono font-semibold tabular-nums">−{formatMoney(analytics.discounts)}</dd>
                  </div>
                  <div className="flex justify-between text-muted">
                    <dt>Delivery fees</dt>
                    <dd className="font-mono tabular-nums">{formatMoney(analytics.deliveryFees)}</dd>
                  </div>
                  <div className="flex justify-between text-muted">
                    <dt>Service fees</dt>
                    <dd className="font-mono tabular-nums">{formatMoney(analytics.serviceFees)}</dd>
                  </div>
                  <div className="flex justify-between text-muted">
                    <dt>Sales tax collected</dt>
                    <dd className="font-mono tabular-nums">{formatMoney(analytics.tax)}</dd>
                  </div>
                  <div className="flex justify-between text-muted">
                    <dt>Restaurant tips</dt>
                    <dd className="font-mono tabular-nums">{formatMoney(analytics.restaurantTips)}</dd>
                  </div>
                  <div className="flex justify-between text-muted">
                    <dt>Driver tips</dt>
                    <dd className="font-mono tabular-nums">{formatMoney(analytics.deliveryTips)}</dd>
                  </div>
                  <div className="pt-2 border-t border-line flex justify-between font-bold text-ink">
                    <dt>Gross billed total</dt>
                    <dd className="font-mono tabular-nums">{formatMoney(analytics.grossTotal)}</dd>
                  </div>
                  {analytics.refunds > 0 && (
                    <div className="flex justify-between text-red-600 font-semibold">
                      <dt>Refunds issued ({analytics.refundedOrderCount})</dt>
                      <dd className="font-mono tabular-nums">−{formatMoney(analytics.refunds)}</dd>
                    </div>
                  )}
                </dl>
              </div>

              <div className="mt-4 pt-3 border-t-2 border-brand/30 flex items-center justify-between">
                <span className="font-display font-extrabold text-sm text-ink">Net collected revenue</span>
                <span className="font-mono font-extrabold text-lg text-brand tabular-nums">
                  {formatMoney(analytics.netSales)}
                </span>
              </div>
            </div>
          </div>

          {/* Payment Method & Fulfillment Split Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
            <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5">
              <h3 className="font-display font-extrabold text-sm sm:text-base text-ink mb-3">
                Payment method breakdown
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                      <th className="pb-2 font-bold">Channel</th>
                      <th className="pb-2 font-bold text-right">Orders</th>
                      <th className="pb-2 font-bold text-right">Gross</th>
                      <th className="pb-2 font-bold text-right">Refunded</th>
                      <th className="pb-2 font-bold text-right">Net / Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {analytics.paymentBreakdown.map((row) => (
                      <tr key={row.method}>
                        <td className="py-2.5 font-semibold text-ink">{row.label}</td>
                        <td className="py-2.5 text-right font-mono tabular-nums">{row.orders}</td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-muted">
                          {formatMoney(row.grossAmount)}
                        </td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-red-600">
                          {row.refundedAmount > 0 ? `−${formatMoney(row.refundedAmount)}` : '$0.00'}
                        </td>
                        <td className="py-2.5 text-right font-mono font-bold tabular-nums text-ink">
                          {formatMoney(row.netAmount)}{' '}
                          <span className="text-[11px] font-normal text-muted">({row.sharePercent}%)</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5">
              <h3 className="font-display font-extrabold text-sm sm:text-base text-ink mb-3">
                Fulfillment breakdown (Pickup vs Delivery)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                      <th className="pb-2 font-bold">Type</th>
                      <th className="pb-2 font-bold text-right">Orders</th>
                      <th className="pb-2 font-bold text-right">Avg Ticket</th>
                      <th className="pb-2 font-bold text-right">Tips</th>
                      <th className="pb-2 font-bold text-right">Net Sales</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {analytics.fulfillmentBreakdown.map((row) => (
                      <tr key={row.type}>
                        <td className="py-2.5 font-semibold text-ink">{row.label}</td>
                        <td className="py-2.5 text-right font-mono tabular-nums">{row.orders}</td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-muted">
                          {formatMoney(row.avgOrderValue)}
                        </td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-muted">
                          {formatMoney(row.tips)}
                        </td>
                        <td className="py-2.5 text-right font-mono font-bold tabular-nums text-ink">
                          {formatMoney(row.netSales)}{' '}
                          <span className="text-[11px] font-normal text-muted">({row.sharePercent}%)</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Categories & Menu Items Detailed Breakdown */}
      {activeTab === 'catalog' && (
        <div className="space-y-4">
          {/* Category Breakdown */}
          <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div>
                <h3 className="font-display font-extrabold text-sm sm:text-base text-ink flex items-center gap-2">
                  <Layers size={16} className="text-brand" />
                  <span>Sales by menu category</span>
                </h3>
                <p className="text-xs text-muted">Revenue and unit volume across active menu sections</p>
              </div>
            </div>
            {analytics.categoryBreakdown.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {analytics.categoryBreakdown.map((cat) => (
                  <div key={cat.categoryId} className="rounded-control border border-line p-3.5 bg-soft/40">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-sm text-ink truncate">{cat.categoryName}</span>
                      <span className="font-mono font-extrabold text-sm text-brand tabular-nums">
                        {formatMoney(cat.grossRevenue)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted mt-1 font-mono tabular-nums">
                      <span>
                        {cat.quantitySold} sold across {cat.orderCount} order{cat.orderCount === 1 ? '' : 's'}
                      </span>
                      <span>{cat.sharePercent}% of item revenue</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-gray-200 mt-2 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-brand"
                        style={{ width: `${Math.max(4, cat.sharePercent)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted py-6 text-center">No menu items sold in this period.</p>
            )}
          </div>

          {/* Detailed Item & Modifier Performance Table */}
          <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div>
                <h3 className="font-display font-extrabold text-sm sm:text-base text-ink">
                  Item-by-item sales breakdown ({filteredItems.length})
                </h3>
                <p className="text-xs text-muted">Includes unit volume, revenue share, and most popular modifiers</p>
              </div>
              <div className="relative sm:w-64">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder="Filter items or modifiers…"
                  className={`${adminInput} pl-9`}
                />
              </div>
            </div>

            {filteredItems.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                      <th className="pb-2.5 font-bold">Item</th>
                      <th className="pb-2.5 font-bold">Category</th>
                      <th className="pb-2.5 font-bold text-right">Orders</th>
                      <th className="pb-2.5 font-bold text-right">Qty Sold</th>
                      <th className="pb-2.5 font-bold text-right">Avg Price</th>
                      <th className="pb-2.5 font-bold text-right">Gross Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {filteredItems.map((item) => (
                      <tr key={item.itemId}>
                        <td className="py-2.5 pr-3">
                          <p className="font-semibold text-ink">{item.name}</p>
                          {item.topModifiers.length > 0 && (
                            <p className="text-[11px] text-muted mt-0.5">
                              Popular options: {item.topModifiers.join(' · ')}
                            </p>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-muted">{item.categoryName}</td>
                        <td className="py-2.5 text-right font-mono tabular-nums">{item.orderCount}</td>
                        <td className="py-2.5 text-right font-mono font-bold tabular-nums">{item.quantitySold}</td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-muted">
                          {formatMoney(item.unitPriceAvg)}
                        </td>
                        <td className="py-2.5 text-right font-mono font-extrabold tabular-nums text-ink">
                          {formatMoney(item.grossRevenue)}{' '}
                          <span className="text-[11px] font-normal text-muted">({item.sharePercent}%)</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted py-8 text-center">No matching items sold in this period.</p>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Peak Hours, Promos & Driver / Cash Collector Reconciliation */}
      {activeTab === 'operations' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
            {/* Day-of-Week Breakdown */}
            <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5">
              <h3 className="font-display font-extrabold text-sm sm:text-base text-ink mb-3">
                Day-of-week performance
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                      <th className="pb-2 font-bold">Day</th>
                      <th className="pb-2 font-bold text-right">Orders</th>
                      <th className="pb-2 font-bold text-right">Avg Ticket</th>
                      <th className="pb-2 font-bold text-right">Net Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {analytics.weekdayBreakdown.map((d) => (
                      <tr key={d.dayIndex}>
                        <td className="py-2 font-semibold text-ink">{d.label}</td>
                        <td className="py-2 text-right font-mono tabular-nums">{d.orders}</td>
                        <td className="py-2 text-right font-mono tabular-nums text-muted">
                          {formatMoney(d.avgOrderValue)}
                        </td>
                        <td className="py-2 text-right font-mono font-bold tabular-nums text-ink">
                          {formatMoney(d.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Active Rush Hours Table */}
            <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="font-display font-extrabold text-sm sm:text-base text-ink">
                  Hourly rush breakdown
                </h3>
                {analytics.peakHour && (
                  <span className="text-xs font-bold text-brand">
                    Peak: {analytics.peakHour.label.toUpperCase()} ({analytics.peakHour.orders} orders)
                  </span>
                )}
              </div>
              {analytics.hourlyBreakdown.some((h) => h.orders > 0) ? (
                <div className="max-h-64 overflow-y-auto pr-1">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead>
                      <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                        <th className="pb-2 font-bold">Hour</th>
                        <th className="pb-2 font-bold text-right">Orders</th>
                        <th className="pb-2 font-bold text-right">Avg Ticket</th>
                        <th className="pb-2 font-bold text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/60">
                      {analytics.hourlyBreakdown
                        .filter((h) => h.orders > 0)
                        .map((h) => (
                          <tr key={h.hour}>
                            <td className="py-2 font-mono font-semibold uppercase text-ink">{h.label}</td>
                            <td className="py-2 text-right font-mono tabular-nums">{h.orders}</td>
                            <td className="py-2 text-right font-mono tabular-nums text-muted">
                              {formatMoney(h.avgOrderValue)}
                            </td>
                            <td className="py-2 text-right font-mono font-bold tabular-nums text-ink">
                              {formatMoney(h.revenue)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted py-8 text-center">No hourly activity in this period.</p>
              )}
            </div>
          </div>

          {/* Driver Reconciliation & Cash Collectors */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
            <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5">
              <h3 className="font-display font-extrabold text-sm sm:text-base text-ink mb-3 flex items-center gap-2">
                <Truck size={16} className="text-brand" />
                <span>Driver delivery & tip reconciliation</span>
              </h3>
              {analytics.driverBreakdown.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead>
                      <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                        <th className="pb-2 font-bold">Driver</th>
                        <th className="pb-2 font-bold text-right">Deliveries</th>
                        <th className="pb-2 font-bold text-right">Driver Tips</th>
                        <th className="pb-2 font-bold text-right">Cash Paid</th>
                        <th className="pb-2 font-bold text-right">Cash Due</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/60">
                      {analytics.driverBreakdown.map((d) => (
                        <tr key={d.driverId}>
                          <td className="py-2.5 font-semibold text-ink">{d.driverName}</td>
                          <td className="py-2.5 text-right font-mono tabular-nums">
                            {d.completedCount}/{d.deliveriesCount}
                          </td>
                          <td className="py-2.5 text-right font-mono font-semibold text-emerald-700 tabular-nums">
                            {formatMoney(d.driverTips)}
                          </td>
                          <td className="py-2.5 text-right font-mono tabular-nums">
                            {formatMoney(d.cashCollected)}
                          </td>
                          <td className="py-2.5 text-right font-mono font-bold tabular-nums text-amber-800">
                            {formatMoney(d.cashDue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted py-6 text-center">No assigned driver deliveries in this period.</p>
              )}
            </div>

            <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5 space-y-4">
              <div>
                <h3 className="font-display font-extrabold text-sm sm:text-base text-ink mb-2">
                  Promo code performance
                </h3>
                {analytics.promoBreakdown.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs sm:text-sm">
                      <thead>
                        <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                          <th className="pb-2 font-bold">Code</th>
                          <th className="pb-2 font-bold text-right">Uses</th>
                          <th className="pb-2 font-bold text-right">Discount</th>
                          <th className="pb-2 font-bold text-right">Net Sales</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line/60">
                        {analytics.promoBreakdown.map((p) => (
                          <tr key={p.code}>
                            <td className="py-2 font-mono font-bold text-ink">{p.code}</td>
                            <td className="py-2 text-right font-mono tabular-nums">{p.orders}</td>
                            <td className="py-2 text-right font-mono text-emerald-700 tabular-nums">
                              −{formatMoney(p.totalDiscount)}
                            </td>
                            <td className="py-2 text-right font-mono font-bold tabular-nums">
                              {formatMoney(p.netSalesGenerated)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-muted">No promo codes redeemed in this period.</p>
                )}
              </div>

              <div className="pt-3 border-t border-line">
                <h3 className="font-display font-extrabold text-sm text-ink mb-2">
                  Staff cash collection log
                </h3>
                {analytics.cashCollectors.length > 0 ? (
                  <ul className="divide-y divide-line/60 text-xs sm:text-sm">
                    {analytics.cashCollectors.map((c) => (
                      <li key={c.collectorName} className="py-2 flex items-center justify-between">
                        <span className="font-semibold text-ink">
                          {c.collectorName}{' '}
                          <span className="text-xs font-normal text-muted">
                            ({c.ordersCount} cash order{c.ordersCount === 1 ? '' : 's'})
                          </span>
                        </span>
                        <span className="font-mono font-bold tabular-nums text-emerald-700">
                          {formatMoney(c.amountCollected)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">No cash payments collected in this period.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Order Ledger & One-Click Receipt / PDF Download */}
      {activeTab === 'ledger' && (
        <div className="bg-white rounded-card border border-line shadow-ios-sm p-4 sm:p-5 space-y-3.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <div>
              <h3 className="font-display font-extrabold text-sm sm:text-base text-ink">
                Order ledger & receipts ({ledgerOrders.length})
              </h3>
              <p className="text-xs text-muted">
                Inspect or download customer receipts, driver delivery slips, or kitchen tickets for any order
              </p>
            </div>
            <div className="relative sm:w-72">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={ledgerSearch}
                onChange={(e) => setLedgerSearch(e.target.value)}
                placeholder="Search order #, customer, driver…"
                className={`${adminInput} pl-9`}
              />
            </div>
          </div>

          {ledgerOrders.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                    <th className="pb-2.5 font-bold">Order</th>
                    <th className="pb-2.5 font-bold">Date & Time</th>
                    <th className="pb-2.5 font-bold">Customer</th>
                    <th className="pb-2.5 font-bold">Type</th>
                    <th className="pb-2.5 font-bold">Status</th>
                    <th className="pb-2.5 font-bold">Payment</th>
                    <th className="pb-2.5 font-bold text-right">Total</th>
                    <th className="pb-2.5 font-bold text-right">Receipt / PDF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/60">
                  {ledgerOrders.slice(0, 100).map((o) => {
                    const pay = paymentSummary(o);
                    return (
                      <tr key={o.id} className="hover:bg-soft/40 transition">
                        <td className="py-2.5 pr-2 font-mono font-bold text-ink">#{orderCode(o)}</td>
                        <td className="py-2.5 pr-2 text-muted whitespace-nowrap">
                          {formatDateTime(o.createdAt) || '—'}
                        </td>
                        <td className="py-2.5 pr-2">
                          <p className="font-semibold text-ink">{o.customerName || 'Guest'}</p>
                          {o.driverName && <p className="text-[11px] text-muted">Driver: {o.driverName}</p>}
                        </td>
                        <td className="py-2.5 pr-2 capitalize text-muted">{o.type}</td>
                        <td className="py-2.5 pr-2">
                          <span
                            className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLE[o.status]}`}
                          >
                            {STATUS_LABEL[o.status]}
                          </span>
                        </td>
                        <td className="py-2.5 pr-2 text-xs">
                          <span className={isCashDue(o) ? 'font-bold text-amber-800' : 'text-ink'}>{pay.label}</span>
                        </td>
                        <td className="py-2.5 pr-2 text-right font-mono font-bold tabular-nums text-ink">
                          {formatMoney(o.total)}
                        </td>
                        <td className="py-2.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setReceiptOrder(o)}
                              className="px-2.5 py-1 rounded-btn bg-soft hover:bg-gray-200/80 text-ink text-xs font-semibold transition"
                            >
                              View
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                downloadOrderReceiptPdf(o, profile, 'customer');
                                toast.success(`Downloaded Receipt #${orderCode(o)}`);
                              }}
                              className="px-2.5 py-1 rounded-btn bg-brand/10 hover:bg-brand/20 text-brand text-xs font-bold inline-flex items-center gap-1 transition"
                              title="Download PDF Receipt"
                            >
                              <Download size={12} /> PDF
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted py-8 text-center">No orders match this search in the selected period.</p>
          )}
        </div>
      )}

      {/* Custom PDF Report Generator Sheet */}
      <Sheet
        open={reportModalOpen}
        onClose={() => setReportModalOpen(false)}
        surface="admin"
        size="md"
        title="Custom PDF Report Generator"
        footer={
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setReportModalOpen(false)}
              className="min-h-[44px] px-4 py-2.5 rounded-btn bg-gray-100 text-gray-800 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDownloadCustomPdf}
              className="flex-1 min-h-[44px] px-5 py-2.5 rounded-btn bg-brand text-on-brand text-sm font-bold flex items-center justify-center gap-2 shadow-xs hover:opacity-95"
            >
              <Download size={16} />
              <span>Generate & Download PDF Report</span>
            </button>
          </div>
        }
      >
        <div className="p-5 space-y-4 text-sm">
          {/* Live Report Scope Banner */}
          <div className="rounded-card bg-emerald-50/80 border border-emerald-200 p-3.5 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-800">Report Scope</p>
              <p className="text-xs text-emerald-950 mt-0.5">{periodDescription}</p>
            </div>
            <div className="text-right font-mono tabular-nums">
              <p className="text-xs text-emerald-800">{customReportAnalytics.salesCount} valid sales</p>
              <p className="text-base font-extrabold text-emerald-950">{formatMoney(customReportAnalytics.netSales)}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-600">
              Report Title
            </label>
            <input
              value={reportTitle}
              onChange={(e) => setReportTitle(e.target.value)}
              placeholder={`${profile?.name || 'Restaurant'} - Sales & Financial Report`}
              className={adminInput}
              maxLength={80}
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-600 flex items-center gap-1.5">
              <Filter size={13} /> Order Subset Filter
            </label>
            <select
              value={reportSubset}
              onChange={(e) => setReportSubset(e.target.value as ReportOrderSubset)}
              className={adminInput}
            >
              <option value="valid_sales">All Valid Sales (Card + Cash)</option>
              <option value="all_orders">All Orders (Include Cancelled & Refunded)</option>
              <option value="card_only">Card Payments Only</option>
              <option value="cash_only">Cash Orders Only</option>
              <option value="delivery_only">Delivery Orders Only</option>
              <option value="pickup_only">Pickup Orders Only</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-600">
              Sections to Include in PDF
            </label>
            <div className="grid grid-cols-1 gap-2">
              {(
                [
                  [
                    'executiveSummary',
                    '1. Executive Financial Summary & Revenue Reconciliation',
                    'KPIs, gross subtotal, promos, tax, tips, refunds, and net revenue waterfall',
                  ],
                  [
                    'paymentAndFulfillment',
                    '2. Payment Method & Fulfillment Split',
                    'Card vs Cash Collected vs Cash Due, plus Pickup vs Delivery metrics',
                  ],
                  [
                    'categoryBreakdown',
                    '3. Sales by Menu Category',
                    'Category order counts, quantities sold, revenue, and % share',
                  ],
                  [
                    'itemBreakdown',
                    '4. Menu Item Sales Performance',
                    'Top items ranked by revenue and quantity sold with average unit prices',
                  ],
                  [
                    'hourlyAndWeekday',
                    '5. Peak Rush Hours & Day-of-Week Analysis',
                    'Peak hour detection, hourly breakdown, and Mon-Sun sales table',
                  ],
                  [
                    'promoAndDriver',
                    '6. Promo Codes, Drivers & Staff Cash Reconciliation',
                    'Promo redemptions, driver delivery tips & cash due, and staff cash logs',
                  ],
                  [
                    'orderLedger',
                    '7. Itemized Order-by-Order Ledger',
                    'Complete accounting table of individual orders in the selected period',
                  ],
                ] as const
              ).map(([key, title, desc]) => (
                <label
                  key={key}
                  className="flex items-start gap-3 p-3 rounded-control border border-gray-200 hover:bg-gray-50 cursor-pointer transition"
                >
                  <input
                    type="checkbox"
                    checked={reportSections[key]}
                    onChange={() => toggleReportSection(key)}
                    className="w-4 h-4 mt-0.5 accent-emerald-700"
                  />
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 text-xs sm:text-sm">{title}</p>
                    <p className="text-xs text-gray-500">{desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-600">
              Manager / Accountant Memo (Optional)
            </label>
            <textarea
              value={reportNotes}
              onChange={(e) => setReportNotes(e.target.value.slice(0, 400))}
              rows={2}
              placeholder="Add shift notes, deposit references, or accountant instructions for page 1…"
              className={`${adminInput} resize-none`}
            />
          </div>
        </div>
      </Sheet>

      {/* Receipt Modal when inspecting an order from the Ledger */}
      <ReceiptModal
        order={receiptOrder}
        profile={profile}
        onClose={() => setReceiptOrder(null)}
        defaultVariant="customer"
        allowVariantSwitch
        surface="admin"
      />
    </section>
  );
};
