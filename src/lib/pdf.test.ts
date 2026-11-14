import test from 'node:test';
import assert from 'node:assert/strict';
import type { Order, RestaurantProfile } from '../types';
import { computeDetailedAnalytics } from './analytics';
import { generateOrderReceiptPdf, generateSalesReportPdf } from './pdf';

const SAMPLE_PROFILE: RestaurantProfile = {
  name: 'Huddle Snack Stop',
  isAcceptingOrders: true,
  address: '100 Main St, Austin, TX',
  phone: '512-555-0199',
  email: 'hello@huddlesnackstop.com',
};

const SAMPLE_ORDER: Order = {
  id: 'order-abc-123',
  orderNumber: '2048',
  customerId: 'cust-1',
  customerName: 'Jordan Lee',
  customerPhone: '512-555-0144',
  deliveryAddress: '742 Evergreen Terrace, Apt 4B',
  type: 'delivery',
  status: 'out_for_delivery',
  paymentMethod: 'cash',
  paymentStatus: 'pending',
  subtotal: 24.0,
  deliveryFee: 3.5,
  tax: 2.0,
  deliveryTip: 4.5,
  total: 34.0,
  driverName: 'Alex Driver',
  notes: 'Ring the side doorbell please',
  createdAt: new Date('2026-11-14T12:00:00Z'),
  items: [
    {
      cartItemId: 'c1',
      itemId: 'i1',
      name: 'Crispy Chicken Sandwich',
      price: 12.0,
      quantity: 2,
      selectedModifiers: [{ id: 'm1', name: 'Spicy Mayo', price: 0, groupName: 'Sauce' }],
      prepNotes: 'Extra crispy',
    },
  ],
};

function bytesToAscii(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

test('generateOrderReceiptPdf generates valid PDF 1.4 documents for customer, driver, and kitchen', () => {
  for (const variant of ['customer', 'driver', 'kitchen', 'staff'] as const) {
    const pdfBytes = generateOrderReceiptPdf(SAMPLE_ORDER, SAMPLE_PROFILE, { variant });
    assert.ok(pdfBytes instanceof Uint8Array);
    assert.ok(pdfBytes.byteLength > 1200, `Expected PDF bytes > 1200 for ${variant}`);

    const text = bytesToAscii(pdfBytes);
    assert.ok(text.startsWith('%PDF-1.4\n'), 'Must start with PDF 1.4 header');
    assert.ok(text.includes('xref'), 'Must contain xref table');
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'Must end with %%EOF');
    assert.ok(text.includes('Huddle Snack Stop'), 'Must include restaurant name');
    assert.ok(text.includes('ORDER #2048'), 'Must include order code');
    assert.ok(text.includes('Crispy Chicken Sandwich'), 'Must include line item');
  }
});

test('generateSalesReportPdf generates valid multi-section custom financial PDF report', () => {
  const analytics = computeDetailedAnalytics([SAMPLE_ORDER]);
  const pdfBytes = generateSalesReportPdf({
    title: 'Huddle Snack Stop - Custom Executive Report',
    rangeLabel: 'Nov 14, 2026',
    preparedBy: 'Manager Admin',
    notes: 'End of shift reconciliation for accountant.',
    profile: SAMPLE_PROFILE,
    analytics,
    orders: [SAMPLE_ORDER],
  });

  assert.ok(pdfBytes instanceof Uint8Array);
  assert.ok(pdfBytes.byteLength > 2000);
  const text = bytesToAscii(pdfBytes);
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.includes('Huddle Snack Stop - Custom Executive Report'));
  assert.ok(text.includes('1. EXECUTIVE FINANCIAL SUMMARY'));
  assert.ok(text.includes('7. ITEMIZED ORDER LEDGER'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
});
