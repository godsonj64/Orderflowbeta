import test from 'node:test';
import assert from 'node:assert/strict';
import type { Order, RestaurantProfile } from '../types';
import { computeDetailedAnalytics } from './analytics';
import {
  estimateTextWidth,
  fitPdfFontSize,
  generateOrderReceiptPdf,
  generateSalesReportPdf,
} from './pdf';

const SAMPLE_PROFILE: RestaurantProfile = {
  name: 'Huddle Snack Stop',
  isAcceptingOrders: true,
  address: '408 Congress Ave, Austin, TX 78701',
  phone: '(512) 555-0194',
  email: 'orders@huddlesnackstop.com',
};

const SAMPLE_ORDER: Order = {
  id: 'ug6yny-abc-123',
  orderNumber: 'UG6YNY',
  customerId: 'cust-1',
  customerName: 'Jordan Lee',
  customerPhone: '512-555-0144',
  deliveryAddress: '742 Evergreen Terrace, Apt 4B',
  type: 'delivery',
  status: 'completed',
  paymentMethod: 'cash',
  paymentStatus: 'paid',
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

test('fitPdfFontSize scales down long uppercase codes like ORDER #UG6YNY to fit inside left header block', () => {
  const maxWidth = 100; // leftBlockW (118) - 18pt horizontal padding
  const fittedSize = fitPdfFontSize('ORDER #UG6YNY', maxWidth, 14.5, 8, 'F4');
  assert.ok(fittedSize < 14.5, 'Expected font size to scale down below 14.5pt for 13-char uppercase code');
  assert.ok(fittedSize >= 8, 'Expected font size to stay above minSize 8pt');
  const renderedWidth = estimateTextWidth('ORDER #UG6YNY', fittedSize, 'F4');
  assert.ok(
    renderedWidth <= maxWidth + 0.5,
    `Expected rendered width (${renderedWidth}) to fit within maxWidth (${maxWidth})`,
  );
});

test('generateOrderReceiptPdf preserves full contact email and avoids duplicate CASH (CASH) payment label', () => {
  for (const variant of ['customer', 'driver', 'kitchen', 'staff'] as const) {
    const pdfBytes = generateOrderReceiptPdf(SAMPLE_ORDER, SAMPLE_PROFILE, { variant });
    assert.ok(pdfBytes instanceof Uint8Array);
    assert.ok(pdfBytes.byteLength > 1200, `Expected PDF bytes > 1200 for ${variant}`);

    const text = bytesToAscii(pdfBytes);
    assert.ok(text.startsWith('%PDF-1.4\n'), 'Must start with PDF 1.4 header');
    assert.ok(text.includes('xref'), 'Must contain xref table');
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'Must end with %%EOF');
    assert.ok(text.includes('Huddle Snack Stop'), 'Must include restaurant name');
    assert.ok(text.includes('ORDER #UG6YNY'), 'Must include 6-character order code');
    assert.ok(text.includes('orders@huddlesnackstop.com'), 'Must preserve full email address without chopping');
    assert.ok(!text.includes('CASH (CASH)'), 'Must not duplicate payment method as CASH (CASH)');
    assert.ok(text.includes('PAID - CASH - DO NOT COLLECT CASH'), 'Must include clean payment status banner text');
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
