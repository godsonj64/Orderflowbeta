import { format } from 'date-fns';
import type { MenuCategory, MenuItem, Order } from '../types';
import { toDate } from './dates';
import { orderCode } from './ids';
import { fromCents, toCents } from './money';
import { isCashDue, paymentMethodOf } from './orderStatus';

/** Orders that represent valid placed sales (not abandoned payment_pending and not cancelled). */
export function isSaleOrder(order: Order): boolean {
  return order.status !== 'payment_pending' && order.status !== 'cancelled';
}

export interface PaymentBreakdownRow {
  method: 'card' | 'cash_paid' | 'cash_due';
  label: string;
  orders: number;
  grossAmount: number;
  refundedAmount: number;
  netAmount: number;
  sharePercent: number;
}

export interface FulfillmentBreakdownRow {
  type: 'pickup' | 'delivery';
  label: string;
  orders: number;
  grossSubtotal: number;
  deliveryFees: number;
  tips: number;
  netSales: number;
  avgOrderValue: number;
  sharePercent: number;
}

export interface CategoryBreakdownRow {
  categoryId: string;
  categoryName: string;
  quantitySold: number;
  orderCount: number;
  grossRevenue: number;
  sharePercent: number;
}

export interface ItemBreakdownRow {
  itemId: string;
  name: string;
  categoryName: string;
  quantitySold: number;
  orderCount: number;
  unitPriceAvg: number;
  grossRevenue: number;
  sharePercent: number;
  topModifiers: string[];
}

export interface HourlyBreakdownRow {
  hour: number;
  label: string;
  orders: number;
  revenue: number;
  avgOrderValue: number;
}

export interface WeekdayBreakdownRow {
  dayIndex: number;
  label: string;
  orders: number;
  revenue: number;
  avgOrderValue: number;
}

export interface PromoBreakdownRow {
  code: string;
  orders: number;
  totalDiscount: number;
  netSalesGenerated: number;
}

export interface DriverBreakdownRow {
  driverId: string;
  driverName: string;
  deliveriesCount: number;
  completedCount: number;
  deliveryFees: number;
  driverTips: number;
  cashCollected: number;
  cashDue: number;
  totalOrderValue: number;
}

export interface CashCollectorRow {
  collectorName: string;
  ordersCount: number;
  amountCollected: number;
}

export interface DetailedSalesAnalytics {
  totalOrdersInRange: number;
  salesCount: number;
  completedCount: number;
  activeCount: number;
  cancelledCount: number;
  refundedOrderCount: number;
  totalItemsSold: number;
  avgItemsPerOrder: number;

  grossSubtotal: number;
  discounts: number;
  deliveryFees: number;
  serviceFees: number;
  tax: number;
  restaurantTips: number;
  deliveryTips: number;
  totalTips: number;
  grossTotal: number;
  refunds: number;
  netSales: number;
  avgOrderValue: number;

  cardCollected: number;
  cashCollected: number;
  cashDue: number;

  pickupCount: number;
  deliveryCount: number;

  paymentBreakdown: PaymentBreakdownRow[];
  fulfillmentBreakdown: FulfillmentBreakdownRow[];
  categoryBreakdown: CategoryBreakdownRow[];
  itemBreakdown: ItemBreakdownRow[];
  hourlyBreakdown: HourlyBreakdownRow[];
  peakHour: HourlyBreakdownRow | null;
  weekdayBreakdown: WeekdayBreakdownRow[];
  promoBreakdown: PromoBreakdownRow[];
  driverBreakdown: DriverBreakdownRow[];
  cashCollectors: CashCollectorRow[];
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Computes a complete, cent-accurate financial & operational breakdown from a list of orders.
 */
export function computeDetailedAnalytics(
  orders: Order[],
  options?: {
    categories?: MenuCategory[];
    items?: MenuItem[];
  },
): DetailedSalesAnalytics {
  const validOrders = orders.filter((o) => o.status !== 'payment_pending');
  const sales = validOrders.filter(isSaleOrder);

  const categoryNameById = new Map<string, string>();
  for (const c of options?.categories || []) {
    categoryNameById.set(c.id, c.name);
  }
  const itemCategoryById = new Map<string, string>();
  for (const item of options?.items || []) {
    itemCategoryById.set(item.id, item.categoryId);
  }

  let grossSubtotalCents = 0;
  let discountsCents = 0;
  let deliveryFeesCents = 0;
  let serviceFeesCents = 0;
  let taxCents = 0;
  let restaurantTipsCents = 0;
  let deliveryTipsCents = 0;
  let grossTotalCents = 0;
  let refundsCents = 0;
  let netSalesCents = 0;

  let cardOrders = 0;
  let cardGrossCents = 0;
  let cardRefundCents = 0;
  let cardNetCents = 0;

  let cashPaidOrders = 0;
  let cashPaidCents = 0;

  let cashDueOrders = 0;
  let cashDueCents = 0;

  let pickupOrders = 0;
  let pickupSubtotalCents = 0;
  let pickupTipsCents = 0;
  let pickupNetCents = 0;

  let deliveryOrders = 0;
  let deliverySubtotalCents = 0;
  let deliveryFeeBucketCents = 0;
  let deliveryTipsBucketCents = 0;
  let deliveryNetCents = 0;

  let completedCount = 0;
  let activeCount = 0;
  let cancelledCount = 0;
  let refundedOrderCount = 0;
  let totalItemsSold = 0;

  for (const o of validOrders) {
    const refCents = toCents(o.refundAmount || 0);
    if (refCents > 0) {
      refundsCents += refCents;
      refundedOrderCount += 1;
    }
    if (o.status === 'cancelled') {
      if (o.paymentStatus !== 'failed') cancelledCount += 1;
      continue;
    }
    if (o.status === 'completed') completedCount += 1;
    else activeCount += 1;
  }

  const categoryAgg = new Map<
    string,
    { categoryId: string; categoryName: string; quantitySold: number; orderIds: Set<string>; revenueCents: number }
  >();
  const itemAgg = new Map<
    string,
    {
      itemId: string;
      name: string;
      categoryName: string;
      quantitySold: number;
      orderIds: Set<string>;
      revenueCents: number;
      modifierCounts: Map<string, number>;
    }
  >();

  const hourlyAgg = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    orders: 0,
    revenueCents: 0,
  }));

  const weekdayAgg = Array.from({ length: 7 }, (_, dayIndex) => ({
    dayIndex,
    orders: 0,
    revenueCents: 0,
  }));

  const promoAgg = new Map<string, { code: string; orders: number; discountCents: number; netSalesCents: number }>();
  const driverAgg = new Map<
    string,
    {
      driverId: string;
      driverName: string;
      deliveriesCount: number;
      completedCount: number;
      deliveryFeesCents: number;
      driverTipsCents: number;
      cashCollectedCents: number;
      cashDueCents: number;
      totalOrderValueCents: number;
    }
  >();
  const collectorAgg = new Map<string, { collectorName: string; ordersCount: number; amountCollectedCents: number }>();

  for (const o of sales) {
    const orderTotalCents = toCents(o.total);
    const orderRefundCents = toCents(o.refundAmount || 0);
    const orderNetCents = Math.max(0, orderTotalCents - orderRefundCents);

    const itemLinesCents = (o.items || []).reduce((sum, i) => sum + toCents(i.price) * i.quantity, 0);
    const subCents = o.subtotal !== undefined ? toCents(o.subtotal) : itemLinesCents;
    const discCents = toCents(o.discountAmount || 0);
    const delFeeCents = toCents(o.deliveryFee || 0);
    const srvFeeCents = toCents(o.serviceFee || 0);
    const txCents = toCents(o.tax || 0);
    const restTipCents = toCents(o.restaurantTip || 0);
    const delTipCents = toCents(o.deliveryTip || 0);

    grossSubtotalCents += subCents;
    discountsCents += discCents;
    deliveryFeesCents += delFeeCents;
    serviceFeesCents += srvFeeCents;
    taxCents += txCents;
    restaurantTipsCents += restTipCents;
    deliveryTipsCents += delTipCents;
    grossTotalCents += orderTotalCents;
    netSalesCents += orderNetCents;

    const method = paymentMethodOf(o);
    if (method === 'cash') {
      if (o.paymentStatus === 'paid') {
        cashPaidOrders += 1;
        cashPaidCents += orderNetCents;
        const collector = (o.paymentCollectedBy || 'Staff').trim();
        const cEntry = collectorAgg.get(collector) || { collectorName: collector, ordersCount: 0, amountCollectedCents: 0 };
        cEntry.ordersCount += 1;
        cEntry.amountCollectedCents += orderNetCents;
        collectorAgg.set(collector, cEntry);
      } else if (isCashDue(o)) {
        cashDueOrders += 1;
        cashDueCents += orderTotalCents;
      }
    } else if (['paid', 'partially_refunded', 'refunded'].includes(o.paymentStatus || '')) {
      cardOrders += 1;
      cardGrossCents += orderTotalCents;
      cardRefundCents += orderRefundCents;
      cardNetCents += orderNetCents;
    }

    if (o.type === 'delivery') {
      deliveryOrders += 1;
      deliverySubtotalCents += subCents;
      deliveryFeeBucketCents += delFeeCents;
      deliveryTipsBucketCents += restTipCents + delTipCents;
      deliveryNetCents += orderNetCents;
    } else {
      pickupOrders += 1;
      pickupSubtotalCents += subCents;
      pickupTipsCents += restTipCents + delTipCents;
      pickupNetCents += orderNetCents;
    }

    // Promo breakdown
    if (o.promoCode && discCents > 0) {
      const code = o.promoCode.trim().toUpperCase();
      const pEntry = promoAgg.get(code) || { code, orders: 0, discountCents: 0, netSalesCents: 0 };
      pEntry.orders += 1;
      pEntry.discountCents += discCents;
      pEntry.netSalesCents += orderNetCents;
      promoAgg.set(code, pEntry);
    }

    // Driver breakdown
    if (o.type === 'delivery' && (o.driverId || o.driverName)) {
      const key = o.driverId || o.driverName || 'unassigned';
      const name = o.driverName || 'Assigned Driver';
      const dEntry = driverAgg.get(key) || {
        driverId: key,
        driverName: name,
        deliveriesCount: 0,
        completedCount: 0,
        deliveryFeesCents: 0,
        driverTipsCents: 0,
        cashCollectedCents: 0,
        cashDueCents: 0,
        totalOrderValueCents: 0,
      };
      dEntry.deliveriesCount += 1;
      if (o.status === 'completed') dEntry.completedCount += 1;
      dEntry.deliveryFeesCents += delFeeCents;
      dEntry.driverTipsCents += delTipCents;
      dEntry.totalOrderValueCents += orderNetCents;
      if (method === 'cash') {
        if (o.paymentStatus === 'paid') dEntry.cashCollectedCents += orderNetCents;
        else if (isCashDue(o)) dEntry.cashDueCents += orderTotalCents;
      }
      driverAgg.set(key, dEntry);
    }

    // Time-of-day and weekday breakdown
    const createdDate = toDate(o.createdAt);
    if (createdDate) {
      const hr = createdDate.getHours();
      hourlyAgg[hr].orders += 1;
      hourlyAgg[hr].revenueCents += orderNetCents;

      const dayIdx = createdDate.getDay();
      weekdayAgg[dayIdx].orders += 1;
      weekdayAgg[dayIdx].revenueCents += orderNetCents;
    }

    // Items & Categories breakdown
    for (const line of o.items || []) {
      const qty = Math.max(0, Number(line.quantity) || 0);
      const lineCents = toCents(line.price) * qty;
      totalItemsSold += qty;

      const catId = itemCategoryById.get(line.itemId) || 'uncategorized';
      const catName = categoryNameById.get(catId) || (catId === 'uncategorized' ? 'Menu Items' : catId);

      const catRow = categoryAgg.get(catId) || {
        categoryId: catId,
        categoryName: catName,
        quantitySold: 0,
        orderIds: new Set<string>(),
        revenueCents: 0,
      };
      catRow.quantitySold += qty;
      catRow.orderIds.add(o.id);
      catRow.revenueCents += lineCents;
      categoryAgg.set(catId, catRow);

      const itemKey = line.itemId || line.name;
      const itemRow = itemAgg.get(itemKey) || {
        itemId: itemKey,
        name: line.name,
        categoryName: catName,
        quantitySold: 0,
        orderIds: new Set<string>(),
        revenueCents: 0,
        modifierCounts: new Map<string, number>(),
      };
      itemRow.quantitySold += qty;
      itemRow.orderIds.add(o.id);
      itemRow.revenueCents += lineCents;
      for (const mod of line.selectedModifiers || []) {
        if (mod?.name) {
          itemRow.modifierCounts.set(mod.name, (itemRow.modifierCounts.get(mod.name) || 0) + qty);
        }
      }
      itemAgg.set(itemKey, itemRow);
    }
  }

  const totalItemRevenueCents = [...itemAgg.values()].reduce((s, r) => s + r.revenueCents, 0);
  const shareOf = (partCents: number, wholeCents: number) =>
    wholeCents > 0 ? Number(((partCents / wholeCents) * 100).toFixed(1)) : 0;

  const paymentBreakdown: PaymentBreakdownRow[] = [
    {
      method: 'card',
      label: 'Card payments',
      orders: cardOrders,
      grossAmount: fromCents(cardGrossCents),
      refundedAmount: fromCents(cardRefundCents),
      netAmount: fromCents(cardNetCents),
      sharePercent: shareOf(cardNetCents, netSalesCents),
    },
    {
      method: 'cash_paid',
      label: 'Cash collected',
      orders: cashPaidOrders,
      grossAmount: fromCents(cashPaidCents),
      refundedAmount: 0,
      netAmount: fromCents(cashPaidCents),
      sharePercent: shareOf(cashPaidCents, netSalesCents),
    },
    {
      method: 'cash_due',
      label: 'Cash outstanding (due)',
      orders: cashDueOrders,
      grossAmount: fromCents(cashDueCents),
      refundedAmount: 0,
      netAmount: fromCents(cashDueCents),
      sharePercent: shareOf(cashDueCents, netSalesCents),
    },
  ];

  const fulfillmentBreakdown: FulfillmentBreakdownRow[] = [
    {
      type: 'pickup',
      label: 'Pickup orders',
      orders: pickupOrders,
      grossSubtotal: fromCents(pickupSubtotalCents),
      deliveryFees: 0,
      tips: fromCents(pickupTipsCents),
      netSales: fromCents(pickupNetCents),
      avgOrderValue: pickupOrders > 0 ? fromCents(Math.round(pickupNetCents / pickupOrders)) : 0,
      sharePercent: shareOf(pickupNetCents, netSalesCents),
    },
    {
      type: 'delivery',
      label: 'Delivery orders',
      orders: deliveryOrders,
      grossSubtotal: fromCents(deliverySubtotalCents),
      deliveryFees: fromCents(deliveryFeeBucketCents),
      tips: fromCents(deliveryTipsBucketCents),
      netSales: fromCents(deliveryNetCents),
      avgOrderValue: deliveryOrders > 0 ? fromCents(Math.round(deliveryNetCents / deliveryOrders)) : 0,
      sharePercent: shareOf(deliveryNetCents, netSalesCents),
    },
  ];

  const categoryBreakdown: CategoryBreakdownRow[] = [...categoryAgg.values()]
    .sort((a, b) => b.revenueCents - a.revenueCents || b.quantitySold - a.quantitySold)
    .map((c) => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      quantitySold: c.quantitySold,
      orderCount: c.orderIds.size,
      grossRevenue: fromCents(c.revenueCents),
      sharePercent: shareOf(c.revenueCents, totalItemRevenueCents),
    }));

  const itemBreakdown: ItemBreakdownRow[] = [...itemAgg.values()]
    .sort((a, b) => b.revenueCents - a.revenueCents || b.quantitySold - a.quantitySold)
    .map((item) => {
      const topModifiers = [...item.modifierCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name} (${count}×)`);
      return {
        itemId: item.itemId,
        name: item.name,
        categoryName: item.categoryName,
        quantitySold: item.quantitySold,
        orderCount: item.orderIds.size,
        unitPriceAvg: item.quantitySold > 0 ? fromCents(Math.round(item.revenueCents / item.quantitySold)) : 0,
        grossRevenue: fromCents(item.revenueCents),
        sharePercent: shareOf(item.revenueCents, totalItemRevenueCents),
        topModifiers,
      };
    });

  const hourlyBreakdown: HourlyBreakdownRow[] = hourlyAgg.map((h) => ({
    hour: h.hour,
    label: format(new Date(2000, 0, 1, h.hour), 'ha').toLowerCase(),
    orders: h.orders,
    revenue: fromCents(h.revenueCents),
    avgOrderValue: h.orders > 0 ? fromCents(Math.round(h.revenueCents / h.orders)) : 0,
  }));

  const peakHour =
    hourlyBreakdown
      .filter((h) => h.orders > 0)
      .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)[0] || null;

  // Order Mon(1) -> Sat(6), Sun(0)
  const orderedDayIndices = [1, 2, 3, 4, 5, 6, 0];
  const weekdayBreakdown: WeekdayBreakdownRow[] = orderedDayIndices.map((idx) => {
    const w = weekdayAgg[idx];
    return {
      dayIndex: idx,
      label: WEEKDAY_NAMES[idx],
      orders: w.orders,
      revenue: fromCents(w.revenueCents),
      avgOrderValue: w.orders > 0 ? fromCents(Math.round(w.revenueCents / w.orders)) : 0,
    };
  });

  const promoBreakdown: PromoBreakdownRow[] = [...promoAgg.values()]
    .sort((a, b) => b.discountCents - a.discountCents)
    .map((p) => ({
      code: p.code,
      orders: p.orders,
      totalDiscount: fromCents(p.discountCents),
      netSalesGenerated: fromCents(p.netSalesCents),
    }));

  const driverBreakdown: DriverBreakdownRow[] = [...driverAgg.values()]
    .sort((a, b) => b.deliveriesCount - a.deliveriesCount)
    .map((d) => ({
      driverId: d.driverId,
      driverName: d.driverName,
      deliveriesCount: d.deliveriesCount,
      completedCount: d.completedCount,
      deliveryFees: fromCents(d.deliveryFeesCents),
      driverTips: fromCents(d.driverTipsCents),
      cashCollected: fromCents(d.cashCollectedCents),
      cashDue: fromCents(d.cashDueCents),
      totalOrderValue: fromCents(d.totalOrderValueCents),
    }));

  const cashCollectors: CashCollectorRow[] = [...collectorAgg.values()]
    .sort((a, b) => b.amountCollectedCents - a.amountCollectedCents)
    .map((c) => ({
      collectorName: c.collectorName,
      ordersCount: c.ordersCount,
      amountCollected: fromCents(c.amountCollectedCents),
    }));

  const totalTipsCents = restaurantTipsCents + deliveryTipsCents;

  return {
    totalOrdersInRange: validOrders.length,
    salesCount: sales.length,
    completedCount,
    activeCount,
    cancelledCount,
    refundedOrderCount,
    totalItemsSold,
    avgItemsPerOrder: sales.length > 0 ? Number((totalItemsSold / sales.length).toFixed(1)) : 0,

    grossSubtotal: fromCents(grossSubtotalCents),
    discounts: fromCents(discountsCents),
    deliveryFees: fromCents(deliveryFeesCents),
    serviceFees: fromCents(serviceFeesCents),
    tax: fromCents(taxCents),
    restaurantTips: fromCents(restaurantTipsCents),
    deliveryTips: fromCents(deliveryTipsCents),
    totalTips: fromCents(totalTipsCents),
    grossTotal: fromCents(grossTotalCents),
    refunds: fromCents(refundsCents),
    netSales: fromCents(netSalesCents),
    avgOrderValue: sales.length > 0 ? fromCents(Math.round(netSalesCents / sales.length)) : 0,

    cardCollected: fromCents(cardNetCents),
    cashCollected: fromCents(cashPaidCents),
    cashDue: fromCents(cashDueCents),

    pickupCount: pickupOrders,
    deliveryCount: deliveryOrders,

    paymentBreakdown,
    fulfillmentBreakdown,
    categoryBreakdown,
    itemBreakdown,
    hourlyBreakdown,
    peakHour,
    weekdayBreakdown,
    promoBreakdown,
    driverBreakdown,
    cashCollectors,
  };
}

/**
 * Formats an order's line items and modifiers into a clean summary string for CSV / ledger export.
 */
export function formatOrderItemsSummary(order: Order): string {
  return (order.items || [])
    .map((i) => {
      const mods = i.selectedModifiers?.length ? ` (${i.selectedModifiers.map((m) => m.name).join(', ')})` : '';
      return `${i.quantity}x ${i.name}${mods}`;
    })
    .join('; ');
}

/**
 * Generates a standardized filename for an order receipt PDF.
 */
export function receiptFilename(order: Order, variant: 'customer' | 'driver' | 'kitchen' | 'staff' = 'customer'): string {
  const code = orderCode(order).replace(/[^A-Za-z0-9_-]/g, '');
  const prefix =
    variant === 'driver'
      ? 'Delivery_Slip'
      : variant === 'kitchen'
        ? 'Kitchen_Ticket'
        : 'Receipt';
  return `${prefix}_${code || order.id}.pdf`;
}
