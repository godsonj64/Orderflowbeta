import test from 'node:test';
import assert from 'node:assert/strict';
import type { MenuCategory, MenuItem, Order } from '../types';
import { computeDetailedAnalytics, formatOrderItemsSummary, receiptFilename } from './analytics';

const CATEGORIES: MenuCategory[] = [
  { id: 'cat-burgers', name: 'Smash Burgers', displayOrder: 1, active: true },
  { id: 'cat-drinks', name: 'Drinks', displayOrder: 2, active: true },
];

const ITEMS: MenuItem[] = [
  { id: 'item-burger', categoryId: 'cat-burgers', name: 'Double Smash', basePrice: 12.5, active: true },
  { id: 'item-cola', categoryId: 'cat-drinks', name: 'Craft Cola', basePrice: 3.5, active: true },
];

const SAMPLE_ORDERS: Order[] = [
  {
    id: 'ord-1001',
    orderNumber: '1001',
    customerId: 'cust-1',
    customerName: 'Alice Rivera',
    customerPhone: '555-0101',
    type: 'delivery',
    status: 'completed',
    paymentMethod: 'card',
    paymentStatus: 'paid',
    subtotal: 28.5,
    discountAmount: 3.5,
    promoCode: 'WELCOME10',
    deliveryFee: 4.0,
    serviceFee: 1.5,
    tax: 2.25,
    restaurantTip: 3.0,
    deliveryTip: 5.0,
    total: 40.75,
    driverId: 'drv-1',
    driverName: 'Marco Driver',
    createdAt: new Date('2026-11-13T18:30:00Z'),
    items: [
      {
        cartItemId: 'line-1',
        itemId: 'item-burger',
        name: 'Double Smash',
        price: 12.5,
        quantity: 2,
        selectedModifiers: [{ id: 'm1', name: 'Extra Cheese', price: 1.5, groupName: 'Add-ons' }],
      },
      {
        cartItemId: 'line-2',
        itemId: 'item-cola',
        name: 'Craft Cola',
        price: 3.5,
        quantity: 1,
        selectedModifiers: [],
      },
    ],
  },
  {
    id: 'ord-1002',
    orderNumber: '1002',
    customerId: 'cust-2',
    customerName: 'Ben Carter',
    type: 'pickup',
    status: 'completed',
    paymentMethod: 'cash',
    paymentStatus: 'paid',
    paymentCollectedBy: 'Sarah Counter',
    subtotal: 12.5,
    tax: 1.0,
    restaurantTip: 2.0,
    total: 15.5,
    createdAt: new Date('2026-11-13T18:45:00Z'),
    items: [
      {
        cartItemId: 'line-3',
        itemId: 'item-burger',
        name: 'Double Smash',
        price: 12.5,
        quantity: 1,
        selectedModifiers: [],
      },
    ],
  },
  {
    id: 'ord-1003',
    orderNumber: '1003',
    customerId: 'cust-3',
    customerName: 'Chloe Kim',
    type: 'delivery',
    status: 'out_for_delivery',
    paymentMethod: 'cash',
    paymentStatus: 'pending',
    subtotal: 16.0,
    deliveryFee: 4.0,
    tax: 1.5,
    deliveryTip: 3.0,
    total: 24.5,
    driverId: 'drv-1',
    driverName: 'Marco Driver',
    createdAt: new Date('2026-11-13T19:15:00Z'),
    items: [
      {
        cartItemId: 'line-4',
        itemId: 'item-burger',
        name: 'Double Smash',
        price: 12.5,
        quantity: 1,
        selectedModifiers: [],
      },
      {
        cartItemId: 'line-5',
        itemId: 'item-cola',
        name: 'Craft Cola',
        price: 3.5,
        quantity: 1,
        selectedModifiers: [],
      },
    ],
  },
  {
    id: 'ord-1004',
    orderNumber: '1004',
    customerId: 'cust-4',
    customerName: 'Cancelled Order',
    type: 'pickup',
    status: 'cancelled',
    paymentMethod: 'card',
    paymentStatus: 'refunded',
    total: 15.0,
    refundAmount: 15.0,
    createdAt: new Date('2026-11-13T20:00:00Z'),
    items: [],
  },
];

test('computeDetailedAnalytics reconciles gross, net, payments, categories, items, promos, and drivers', () => {
  const res = computeDetailedAnalytics(SAMPLE_ORDERS, { categories: CATEGORIES, items: ITEMS });

  assert.equal(res.totalOrdersInRange, 4);
  assert.equal(res.salesCount, 3);
  assert.equal(res.completedCount, 2);
  assert.equal(res.activeCount, 1);
  assert.equal(res.cancelledCount, 1);
  assert.equal(res.refundedOrderCount, 1);
  assert.equal(res.totalItemsSold, 6);

  assert.equal(res.grossSubtotal, 57.0);
  assert.equal(res.discounts, 3.5);
  assert.equal(res.deliveryFees, 8.0);
  assert.equal(res.serviceFees, 1.5);
  assert.equal(res.tax, 4.75);
  assert.equal(res.restaurantTips, 5.0);
  assert.equal(res.deliveryTips, 8.0);
  assert.equal(res.totalTips, 13.0);
  assert.equal(res.grossTotal, 80.75);
  assert.equal(res.refunds, 15.0);
  assert.equal(res.netSales, 80.75);

  assert.equal(res.cardCollected, 40.75);
  assert.equal(res.cashCollected, 15.5);
  assert.equal(res.cashDue, 24.5);

  assert.equal(res.pickupCount, 1);
  assert.equal(res.deliveryCount, 2);

  // Category breakdown
  assert.equal(res.categoryBreakdown.length, 2);
  assert.equal(res.categoryBreakdown[0].categoryName, 'Smash Burgers');
  assert.equal(res.categoryBreakdown[0].quantitySold, 4);
  assert.equal(res.categoryBreakdown[0].grossRevenue, 50.0);

  // Item breakdown
  assert.equal(res.itemBreakdown[0].name, 'Double Smash');
  assert.equal(res.itemBreakdown[0].quantitySold, 4);
  assert.deepEqual(res.itemBreakdown[0].topModifiers, ['Extra Cheese (2×)']);

  // Promo breakdown
  assert.equal(res.promoBreakdown.length, 1);
  assert.equal(res.promoBreakdown[0].code, 'WELCOME10');
  assert.equal(res.promoBreakdown[0].totalDiscount, 3.5);

  // Driver breakdown
  assert.equal(res.driverBreakdown.length, 1);
  assert.equal(res.driverBreakdown[0].driverName, 'Marco Driver');
  assert.equal(res.driverBreakdown[0].deliveriesCount, 2);
  assert.equal(res.driverBreakdown[0].completedCount, 1);
  assert.equal(res.driverBreakdown[0].driverTips, 8.0);
  assert.equal(res.driverBreakdown[0].cashDue, 24.5);

  // Cash collector breakdown
  assert.equal(res.cashCollectors.length, 1);
  assert.equal(res.cashCollectors[0].collectorName, 'Sarah Counter');
  assert.equal(res.cashCollectors[0].amountCollected, 15.5);
});

test('formatOrderItemsSummary and receiptFilename format cleanly', () => {
  const summary = formatOrderItemsSummary(SAMPLE_ORDERS[0]);
  assert.equal(summary, '2x Double Smash (Extra Cheese); 1x Craft Cola');
  assert.equal(receiptFilename(SAMPLE_ORDERS[0], 'customer'), 'Receipt_1001.pdf');
  assert.equal(receiptFilename(SAMPLE_ORDERS[0], 'driver'), 'Delivery_Slip_1001.pdf');
  assert.equal(receiptFilename(SAMPLE_ORDERS[0], 'kitchen'), 'Kitchen_Ticket_1001.pdf');
});
