import { format } from 'date-fns';
import type { Order, RestaurantProfile } from '../types';
import type { DetailedSalesAnalytics } from './analytics';
import { receiptFilename } from './analytics';
import { formatDateTime, toDate } from './dates';
import { orderCode } from './ids';
import { formatMoney } from './money';
import { STATUS_LABEL, isCashDue, netAmount, paymentMethodOf, paymentSummary } from './orderStatus';

export type ReceiptVariant = 'customer' | 'driver' | 'kitchen' | 'staff';

export interface SalesReportSections {
  executiveSummary: boolean;
  paymentAndFulfillment: boolean;
  categoryBreakdown: boolean;
  itemBreakdown: boolean;
  hourlyAndWeekday: boolean;
  promoAndDriver: boolean;
  orderLedger: boolean;
}

export interface SalesReportPdfInput {
  title?: string;
  rangeLabel: string;
  generatedAt?: Date;
  preparedBy?: string;
  notes?: string;
  profile?: RestaurantProfile | null;
  analytics: DetailedSalesAnalytics;
  orders: Order[];
  sections?: Partial<SalesReportSections>;
}

const DEFAULT_REPORT_SECTIONS: SalesReportSections = {
  executiveSummary: true,
  paymentAndFulfillment: true,
  categoryBreakdown: true,
  itemBreakdown: true,
  hourlyAndWeekday: true,
  promoAndDriver: true,
  orderLedger: true,
};

type FontKey = 'F1' | 'F2' | 'F3' | 'F4'; // F1: Helvetica, F2: Helvetica-Bold, F3: Courier, F4: Courier-Bold
type Rgb = [number, number, number]; // 0..1

/**
 * Sanitizes text into WinAnsi / ASCII range supported by standard Type1 PDF fonts,
 * and escapes PDF literal string delimiters.
 */
export function sanitizePdfText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const str = String(raw)
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00B7|\u2022/g, ' - ')
    .replace(/\u00D7/g, 'x')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
  return str;
}

function escapePdfLiteral(text: string): string {
  return sanitizePdfText(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Approximate width of a string in points for standard sans-serif fonts. */
function estimateTextWidth(text: string, fontSize: number, font: FontKey = 'F1'): number {
  const clean = sanitizePdfText(text);
  let units = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if ('ilI.,:;!| '.includes(ch)) units += 0.28;
    else if ('mwMW@%'.includes(ch)) units += 0.78;
    else if (ch >= 'A' && ch <= 'Z') units += 0.66;
    else if (ch >= '0' && ch <= '9') units += 0.56;
    else units += 0.53;
  }
  const boldFactor = font === 'F2' || font === 'F4' ? 1.05 : 1.0;
  return units * fontSize * boldFactor;
}

/** Word-wraps a string to fit within `maxWidth` points. */
export function wrapPdfText(text: string, maxWidth: number, fontSize: number, font: FontKey = 'F1'): string[] {
  const clean = sanitizePdfText(text).trim();
  if (!clean) return [''];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize, font) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (estimateTextWidth(word, fontSize, font) <= maxWidth) {
        current = word;
      } else {
        // Hard-break an extra-long token
        let chunk = '';
        for (const ch of word) {
          if (estimateTextWidth(chunk + ch, fontSize, font) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function fmtNum(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/**
 * Lightweight, zero-dependency multi-page PDF 1.4 vector document builder.
 * Coordinates use top-down `y` (0 at top of page, `pageHeight` at bottom) for intuitive layout.
 */
class PdfDocumentBuilder {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly margin: number;
  private pages: string[][] = [];
  private currentPageIdx = -1;
  y = 0;

  constructor(pageWidth = 595.28, pageHeight = 841.89, margin = 36) {
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.margin = margin;
    this.addPage();
  }

  get contentWidth(): number {
    return this.pageWidth - this.margin * 2;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.pages.push([]);
    this.currentPageIdx = this.pages.length - 1;
    this.y = this.margin;
  }

  ensureSpace(heightNeeded: number, onNewPage?: () => void): void {
    if (this.y + heightNeeded > this.pageHeight - this.margin - 24) {
      this.addPage();
      onNewPage?.();
    }
  }

  private pushOp(op: string, pageIndex = this.currentPageIdx): void {
    this.pages[pageIndex].push(op);
  }

  private pdfY(topY: number): number {
    return this.pageHeight - topY;
  }

  drawRect(
    x: number,
    topY: number,
    width: number,
    height: number,
    options?: { fill?: Rgb; stroke?: Rgb; lineWidth?: number; pageIndex?: number },
  ): void {
    const pIdx = options?.pageIndex ?? this.currentPageIdx;
    const ops: string[] = ['q'];
    if (options?.lineWidth) ops.push(`${fmtNum(options.lineWidth)} w`);
    if (options?.fill) ops.push(`${fmtNum(options.fill[0])} ${fmtNum(options.fill[1])} ${fmtNum(options.fill[2])} rg`);
    if (options?.stroke) ops.push(`${fmtNum(options.stroke[0])} ${fmtNum(options.stroke[1])} ${fmtNum(options.stroke[2])} RG`);
    const bottomY = this.pdfY(topY + height);
    const paintOp = options?.fill && options?.stroke ? 'B' : options?.fill ? 'f' : 'S';
    ops.push(`${fmtNum(x)} ${fmtNum(bottomY)} ${fmtNum(width)} ${fmtNum(height)} re ${paintOp}`);
    ops.push('Q');
    this.pushOp(ops.join('\n'), pIdx);
  }

  drawLine(
    x1: number,
    topY1: number,
    x2: number,
    topY2: number,
    options?: { color?: Rgb; lineWidth?: number; dashed?: boolean; pageIndex?: number },
  ): void {
    const pIdx = options?.pageIndex ?? this.currentPageIdx;
    const color = options?.color || [0.85, 0.87, 0.86];
    const lw = options?.lineWidth ?? 0.75;
    const ops: string[] = [
      'q',
      `${fmtNum(lw)} w`,
      `${fmtNum(color[0])} ${fmtNum(color[1])} ${fmtNum(color[2])} RG`,
    ];
    if (options?.dashed) ops.push('[3 3] 0 d');
    ops.push(`${fmtNum(x1)} ${fmtNum(this.pdfY(topY1))} m ${fmtNum(x2)} ${fmtNum(this.pdfY(topY2))} l S`);
    ops.push('Q');
    this.pushOp(ops.join('\n'), pIdx);
  }

  drawText(
    text: string,
    x: number,
    topBaselineY: number,
    options?: {
      font?: FontKey;
      size?: number;
      color?: Rgb;
      align?: 'left' | 'center' | 'right';
      pageIndex?: number;
    },
  ): void {
    const clean = sanitizePdfText(text);
    if (!clean) return;
    const font = options?.font ?? 'F1';
    const size = options?.size ?? 10;
    const color = options?.color ?? [0.09, 0.11, 0.1];
    const align = options?.align ?? 'left';
    const pIdx = options?.pageIndex ?? this.currentPageIdx;

    let drawX = x;
    if (align !== 'left') {
      const w = estimateTextWidth(clean, size, font);
      drawX = align === 'center' ? x - w / 2 : x - w;
    }

    const pdfY = this.pdfY(topBaselineY);
    const ops = [
      'BT',
      `/${font} ${fmtNum(size)} Tf`,
      `${fmtNum(color[0])} ${fmtNum(color[1])} ${fmtNum(color[2])} rg`,
      `${fmtNum(drawX)} ${fmtNum(pdfY)} Td`,
      `(${escapePdfLiteral(clean)}) Tj`,
      'ET',
    ];
    this.pushOp(ops.join('\n'), pIdx);
  }

  addPageFooters(leftLabel: string): void {
    const total = this.pages.length;
    for (let i = 0; i < total; i++) {
      const footerY = this.pageHeight - 20;
      this.drawLine(this.margin, footerY - 10, this.pageWidth - this.margin, footerY - 10, {
        color: [0.88, 0.9, 0.89],
        lineWidth: 0.5,
        pageIndex: i,
      });
      this.drawText(leftLabel, this.margin, footerY, {
        font: 'F1',
        size: 8,
        color: [0.45, 0.5, 0.48],
        pageIndex: i,
      });
      this.drawText(`Page ${i + 1} of ${total}`, this.pageWidth - this.margin, footerY, {
        font: 'F1',
        size: 8,
        color: [0.45, 0.5, 0.48],
        align: 'right',
        pageIndex: i,
      });
    }
  }

  buildBytes(): Uint8Array {
    // Object layout:
    // 1: Catalog
    // 2: Pages
    // 3: Font F1 (Helvetica)
    // 4: Font F2 (Helvetica-Bold)
    // 5: Font F3 (Courier)
    // 6: Font F4 (Courier-Bold)
    // For each page i (0..N-1):
    //   Page object = 7 + i * 2
    //   Content stream object = 8 + i * 2
    const objects: string[] = [];
    const pageObjNums: number[] = [];

    for (let i = 0; i < this.pages.length; i++) {
      pageObjNums.push(7 + i * 2);
    }

    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    for (let i = 0; i < this.pages.length; i++) {
      const contentObjNum = 8 + i * 2;
      const streamBody = this.pages[i].join('\n');
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmtNum(this.pageWidth)} ${fmtNum(this.pageHeight)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${contentObjNum} 0 R >>`,
      );
      objects.push(`<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`);
    }

    const parts: string[] = ['%PDF-1.4\n'];
    const offsets: number[] = [0];
    let byteOffset = parts[0].length;

    for (let idx = 0; idx < objects.length; idx++) {
      offsets.push(byteOffset);
      const objStr = `${idx + 1} 0 obj\n${objects[idx]}\nendobj\n`;
      parts.push(objStr);
      byteOffset += objStr.length;
    }

    const xrefOffset = byteOffset;
    const xrefLines: string[] = [
      'xref',
      `0 ${objects.length + 1}`,
      '0000000000 65535 f ',
    ];
    for (let i = 1; i <= objects.length; i++) {
      xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `);
    }
    const trailer = [
      ...xrefLines,
      'trailer',
      `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
      'startxref',
      String(xrefOffset),
      '%%EOF',
      '',
    ].join('\n');
    parts.push(trailer);

    const fullString = parts.join('');
    const bytes = new Uint8Array(fullString.length);
    for (let i = 0; i < fullString.length; i++) {
      bytes[i] = fullString.charCodeAt(i) & 0xff;
    }
    return bytes;
  }
}

const COLORS = {
  brandDark: [0.09, 0.14, 0.11] as Rgb,
  brandGreen: [0.16, 0.48, 0.31] as Rgb,
  brandTint: [0.94, 0.97, 0.95] as Rgb,
  ink: [0.09, 0.11, 0.1] as Rgb,
  muted: [0.42, 0.46, 0.44] as Rgb,
  line: [0.86, 0.88, 0.87] as Rgb,
  soft: [0.96, 0.97, 0.96] as Rgb,
  amberBg: [1.0, 0.96, 0.88] as Rgb,
  amberBorder: [0.95, 0.76, 0.35] as Rgb,
  amberText: [0.55, 0.33, 0.04] as Rgb,
  redBg: [0.99, 0.93, 0.93] as Rgb,
  redText: [0.72, 0.14, 0.14] as Rgb,
  white: [1, 1, 1] as Rgb,
};

/**
 * Generates a complete, printable & downloadable PDF receipt for an order,
 * tailored to Customers, Drivers, Kitchen Staff, or Store Managers.
 */
export function generateOrderReceiptPdf(
  order: Order,
  profile?: RestaurantProfile | null,
  options?: { variant?: ReceiptVariant },
): Uint8Array {
  const variant: ReceiptVariant = options?.variant || 'customer';
  const doc = new PdfDocumentBuilder(595.28, 841.89, 36);
  const w = doc.contentWidth;
  const x0 = doc.margin;
  const xRight = doc.pageWidth - doc.margin;

  const storeName = profile?.name?.trim() || 'Restaurant';
  const storeAddress = profile?.address?.trim() || '';
  const storePhone = profile?.phone?.trim() || '';
  const storeEmail = profile?.email?.trim() || '';
  const code = orderCode(order);
  const createdStr = formatDateTime(order.createdAt) || format(new Date(), 'MMM d, yyyy h:mm a');
  const pay = paymentSummary(order);
  const cashDue = isCashDue(order);
  const isDelivery = order.type === 'delivery';

  const variantTitle =
    variant === 'driver'
      ? 'DRIVER DELIVERY & PAYOUT SLIP'
      : variant === 'kitchen'
        ? 'KITCHEN PREPARATION TICKET'
        : variant === 'staff'
          ? 'MERCHANT ORDER RECEIPT'
          : 'OFFICIAL ORDER RECEIPT';

  // Top Header Banner
  const headerH = 74;
  doc.drawRect(x0, doc.y, w, headerH, {
    fill: variant === 'driver' ? [0.11, 0.15, 0.22] : variant === 'kitchen' ? [0.11, 0.14, 0.12] : COLORS.brandDark,
  });

  doc.drawText(variantTitle, x0 + 16, doc.y + 20, {
    font: 'F2',
    size: 8.5,
    color: [0.68, 0.88, 0.75],
  });
  doc.drawText(storeName, x0 + 16, doc.y + 39, {
    font: 'F2',
    size: 18,
    color: COLORS.white,
  });

  const contactParts = [storeAddress, storePhone, storeEmail].filter(Boolean).join('  |  ');
  if (contactParts) {
    doc.drawText(contactParts.slice(0, 95), x0 + 16, doc.y + 56, {
      font: 'F1',
      size: 8.5,
      color: [0.82, 0.86, 0.84],
    });
  }

  // Right side of header: Order # + Fulfillment Badge
  doc.drawText(`ORDER #${code}`, xRight - 16, doc.y + 34, {
    font: 'F4',
    size: 17,
    color: COLORS.white,
    align: 'right',
  });
  doc.drawText(`${isDelivery ? 'DELIVERY' : 'PICKUP'}  |  ${STATUS_LABEL[order.status].toUpperCase()}`, xRight - 16, doc.y + 53, {
    font: 'F2',
    size: 9,
    color: [0.85, 0.92, 0.88],
    align: 'right',
  });

  doc.y += headerH + 14;

  // Driver / Cash Collection Prominent Alert Box
  if (cashDue || variant === 'driver') {
    const alertH = 38;
    const isWarning = cashDue;
    doc.drawRect(x0, doc.y, w, alertH, {
      fill: isWarning ? COLORS.amberBg : COLORS.brandTint,
      stroke: isWarning ? COLORS.amberBorder : COLORS.brandGreen,
      lineWidth: 1,
    });
    const headline = cashDue
      ? `COLLECT ${formatMoney(order.total)} IN CASH (${isDelivery ? 'AT DROP-OFF' : 'AT PICKUP'})`
      : `PREPAID (${pay.label.toUpperCase()}) - DO NOT COLLECT CASH`;
    doc.drawText(headline, x0 + 14, doc.y + 16, {
      font: 'F2',
      size: 10.5,
      color: isWarning ? COLORS.amberText : COLORS.brandGreen,
    });
    const subline =
      variant === 'driver'
        ? `Driver Tip: ${formatMoney(order.deliveryTip || 0)}   |   Delivery Fee: ${formatMoney(order.deliveryFee || 0)}   |   Driver: ${order.driverName || 'Unassigned'}`
        : `Payment Status: ${pay.label}   |   Order ID: ${order.id}`;
    doc.drawText(subline, x0 + 14, doc.y + 30, {
      font: 'F1',
      size: 8.5,
      color: isWarning ? COLORS.amberText : COLORS.ink,
    });
    doc.y += alertH + 12;
  }

  // Two-column Metadata Box: Order Details (Left) & Customer / Fulfillment Details (Right)
  const metaH = 82;
  doc.drawRect(x0, doc.y, w, metaH, {
    fill: COLORS.soft,
    stroke: COLORS.line,
    lineWidth: 0.75,
  });
  const midX = x0 + w * 0.5;
  doc.drawLine(midX, doc.y + 8, midX, doc.y + metaH - 8, { color: COLORS.line, lineWidth: 0.6 });

  // Left column
  let ly = doc.y + 16;
  doc.drawText('ORDER INFORMATION', x0 + 12, ly, { font: 'F2', size: 8, color: COLORS.muted });
  ly += 14;
  doc.drawText(`Placed: ${createdStr}`, x0 + 12, ly, { font: 'F1', size: 9.5, color: COLORS.ink });
  ly += 13;
  doc.drawText(
    `Fulfillment: ${isDelivery ? 'Delivery' : 'Pickup'}${order.scheduledTime ? ` (Scheduled: ${order.scheduledTime})` : ' (ASAP)'}`,
    x0 + 12,
    ly,
    { font: 'F1', size: 9.5, color: COLORS.ink },
  );
  ly += 13;
  doc.drawText(`Payment: ${pay.label} (${paymentMethodOf(order).toUpperCase()})`, x0 + 12, ly, {
    font: 'F2',
    size: 9.5,
    color: cashDue ? COLORS.amberText : COLORS.brandGreen,
  });
  if (order.paymentCollectedBy && order.paymentStatus === 'paid') {
    ly += 12;
    doc.drawText(`Collected by: ${order.paymentCollectedBy}`, x0 + 12, ly, { font: 'F1', size: 8.5, color: COLORS.muted });
  }

  // Right column
  let ry = doc.y + 16;
  doc.drawText(isDelivery ? 'CUSTOMER & DELIVERY ADDRESS' : 'CUSTOMER & PICKUP LOCATION', midX + 12, ry, {
    font: 'F2',
    size: 8,
    color: COLORS.muted,
  });
  ry += 14;
  doc.drawText(`Customer: ${order.customerName || 'Guest'}`, midX + 12, ry, { font: 'F2', size: 9.5, color: COLORS.ink });
  ry += 13;
  doc.drawText(`Phone: ${order.customerPhone || 'Not provided'}`, midX + 12, ry, { font: 'F1', size: 9.5, color: COLORS.ink });
  ry += 13;
  const locationLine = isDelivery
    ? `Deliver to: ${order.deliveryAddress || 'Address on file'}`
    : `Pickup at: ${storeAddress || storeName}`;
  const locWrapped = wrapPdfText(locationLine, w * 0.5 - 24, 9, 'F1');
  for (const line of locWrapped.slice(0, 2)) {
    doc.drawText(line, midX + 12, ry, { font: 'F1', size: 9, color: COLORS.ink });
    ry += 11;
  }

  doc.y += metaH + 12;

  // Special Order Notes (if any)
  if (order.notes) {
    const noteLines = wrapPdfText(`Order Note: ${order.notes}`, w - 24, 9.5, 'F2');
    const noteH = 14 + noteLines.length * 12;
    doc.drawRect(x0, doc.y, w, noteH, {
      fill: COLORS.redBg,
      stroke: [0.92, 0.72, 0.72],
      lineWidth: 0.75,
    });
    let ny = doc.y + 14;
    for (const line of noteLines) {
      doc.drawText(line, x0 + 12, ny, { font: 'F2', size: 9.5, color: COLORS.redText });
      ny += 12;
    }
    doc.y += noteH + 12;
  }

  // Itemized Table Header
  const drawItemsHeader = () => {
    doc.drawRect(x0, doc.y, w, 22, { fill: COLORS.brandDark });
    doc.drawText('QTY', x0 + 10, doc.y + 14, { font: 'F2', size: 8.5, color: COLORS.white });
    doc.drawText('ITEM & CUSTOMIZATIONS', x0 + 52, doc.y + 14, { font: 'F2', size: 8.5, color: COLORS.white });
    if (variant !== 'kitchen') {
      doc.drawText('UNIT PRICE', xRight - 90, doc.y + 14, { font: 'F2', size: 8.5, color: COLORS.white, align: 'right' });
      doc.drawText('LINE TOTAL', xRight - 10, doc.y + 14, { font: 'F2', size: 8.5, color: COLORS.white, align: 'right' });
    }
    doc.y += 22;
  };

  drawItemsHeader();

  const itemDescMaxWidth = variant === 'kitchen' ? w - 70 : w - 190;
  for (let idx = 0; idx < (order.items || []).length; idx++) {
    const item = order.items[idx];
    const modStr =
      item.selectedModifiers && item.selectedModifiers.length > 0
        ? item.selectedModifiers.map((m) => (m.groupName ? `${m.groupName}: ${m.name}` : m.name)).join(' | ')
        : '';
    const modLines = modStr ? wrapPdfText(modStr, itemDescMaxWidth, 8.5, 'F1') : [];
    const noteLines = item.prepNotes ? wrapPdfText(`Prep note: "${item.prepNotes}"`, itemDescMaxWidth, 8.5, 'F2') : [];
    const rowH = 20 + modLines.length * 11 + noteLines.length * 11;

    doc.ensureSpace(rowH + 12, drawItemsHeader);

    if (idx % 2 === 1) {
      doc.drawRect(x0, doc.y, w, rowH, { fill: [0.98, 0.985, 0.98] });
    }
    doc.drawLine(x0, doc.y + rowH, xRight, doc.y + rowH, { color: COLORS.line, lineWidth: 0.5 });

    let iy = doc.y + 14;
    doc.drawText(`${item.quantity}x`, x0 + 10, iy, { font: 'F4', size: 10, color: COLORS.brandGreen });
    doc.drawText(item.name, x0 + 52, iy, { font: 'F2', size: 10, color: COLORS.ink });

    if (variant !== 'kitchen') {
      doc.drawText(formatMoney(item.price), xRight - 90, iy, {
        font: 'F3',
        size: 9.5,
        color: COLORS.muted,
        align: 'right',
      });
      doc.drawText(formatMoney(item.price * item.quantity), xRight - 10, iy, {
        font: 'F4',
        size: 9.5,
        color: COLORS.ink,
        align: 'right',
      });
    }

    for (const mLine of modLines) {
      iy += 11;
      doc.drawText(mLine, x0 + 52, iy, { font: 'F1', size: 8.5, color: COLORS.muted });
    }
    for (const nLine of noteLines) {
      iy += 11;
      doc.drawText(nLine, x0 + 52, iy, { font: 'F2', size: 8.5, color: COLORS.redText });
    }

    doc.y += rowH;
  }

  doc.y += 14;

  // Totals & Financial Breakdown Box (for Customer, Driver, Staff)
  if (variant !== 'kitchen') {
    const computedSub =
      order.subtotal !== undefined
        ? order.subtotal
        : (order.items || []).reduce((s, i) => s + i.price * i.quantity, 0);

    const rows: { label: string; value: string; bold?: boolean; color?: Rgb }[] = [
      { label: 'Subtotal', value: formatMoney(computedSub) },
    ];
    if (order.discountAmount && order.discountAmount > 0) {
      rows.push({
        label: `Discount${order.promoCode ? ` (${order.promoCode})` : ''}`,
        value: `-${formatMoney(order.discountAmount)}`,
        color: COLORS.brandGreen,
      });
    }
    if (order.deliveryFee && order.deliveryFee > 0) {
      rows.push({ label: 'Delivery Fee', value: formatMoney(order.deliveryFee) });
    }
    if (order.serviceFee && order.serviceFee > 0) {
      rows.push({ label: 'Service Fee', value: formatMoney(order.serviceFee) });
    }
    if (order.tax && order.tax > 0) {
      rows.push({ label: 'Tax', value: formatMoney(order.tax) });
    }
    if (order.restaurantTip && order.restaurantTip > 0) {
      rows.push({ label: 'Restaurant Tip', value: formatMoney(order.restaurantTip) });
    }
    if (order.deliveryTip && order.deliveryTip > 0) {
      rows.push({ label: 'Driver Tip', value: formatMoney(order.deliveryTip) });
    }

    const boxWidth = 240;
    const boxX = xRight - boxWidth;
    const boxH = rows.length * 16 + 44 + (order.refundAmount ? 20 : 0);

    doc.ensureSpace(boxH + 60);

    doc.drawRect(boxX, doc.y, boxWidth, boxH, {
      fill: COLORS.soft,
      stroke: COLORS.line,
      lineWidth: 0.75,
    });

    let ty = doc.y + 16;
    for (const r of rows) {
      doc.drawText(r.label, boxX + 12, ty, { font: 'F1', size: 9.5, color: r.color || COLORS.muted });
      doc.drawText(r.value, xRight - 12, ty, {
        font: 'F3',
        size: 9.5,
        color: r.color || COLORS.ink,
        align: 'right',
      });
      ty += 16;
    }

    doc.drawLine(boxX + 12, ty - 6, xRight - 12, ty - 6, { color: COLORS.line, lineWidth: 0.75 });
    ty += 8;
    doc.drawText(cashDue ? 'TOTAL DUE (CASH)' : 'TOTAL', boxX + 12, ty, {
      font: 'F2',
      size: 11,
      color: cashDue ? COLORS.amberText : COLORS.ink,
    });
    doc.drawText(formatMoney(order.total), xRight - 12, ty, {
      font: 'F4',
      size: 12,
      color: cashDue ? COLORS.amberText : COLORS.brandGreen,
      align: 'right',
    });

    if (order.refundAmount && order.refundAmount > 0) {
      ty += 16;
      doc.drawText('Refunded', boxX + 12, ty, { font: 'F2', size: 9, color: COLORS.redText });
      doc.drawText(`-${formatMoney(order.refundAmount)} (Net ${formatMoney(netAmount(order))})`, xRight - 12, ty, {
        font: 'F4',
        size: 9,
        color: COLORS.redText,
        align: 'right',
      });
    }

    // Left of totals box: Thank-you / Driver signature block
    const leftBlockW = w - boxWidth - 16;
    if (variant === 'driver') {
      doc.drawRect(x0, doc.y, leftBlockW, boxH, {
        fill: COLORS.white,
        stroke: COLORS.line,
        lineWidth: 0.75,
      });
      doc.drawText('DELIVERY HAND-OFF CONFIRMATION', x0 + 12, doc.y + 16, {
        font: 'F2',
        size: 8.5,
        color: COLORS.muted,
      });
      doc.drawText(`Driver: ${order.driverName || '____________________'}`, x0 + 12, doc.y + 34, {
        font: 'F1',
        size: 9,
        color: COLORS.ink,
      });
      doc.drawText('Delivered At / Signature: ___________________________', x0 + 12, doc.y + 56, {
        font: 'F1',
        size: 9,
        color: COLORS.ink,
      });
    } else {
      doc.drawText(`Thank you for ordering from ${storeName}!`, x0, doc.y + 16, {
        font: 'F2',
        size: 10.5,
        color: COLORS.ink,
      });
      doc.drawText(`Order Reference: #${code} (${order.id})`, x0, doc.y + 32, {
        font: 'F1',
        size: 8.5,
        color: COLORS.muted,
      });
      if (order.paymentIntentId && !order.paymentIntentId.startsWith('mock_')) {
        doc.drawText(`Card Ref: ${order.paymentIntentId.slice(-12)}`, x0, doc.y + 46, {
          font: 'F3',
          size: 8.5,
          color: COLORS.muted,
        });
      }
    }

    doc.y += boxH + 18;
  }

  doc.addPageFooters(`${storeName}  |  Order #${code}  |  Powered by OrderFlow`);
  return doc.buildBytes();
}

/**
 * Generates a customizable multi-page Sales & Insights PDF report with executive KPIs,
 * revenue waterfall, payment/fulfillment split, category & item breakdowns, peak hours,
 * driver/promo reconciliation, and an itemized order ledger.
 */
export function generateSalesReportPdf(input: SalesReportPdfInput): Uint8Array {
  const sections: SalesReportSections = { ...DEFAULT_REPORT_SECTIONS, ...(input.sections || {}) };
  const doc = new PdfDocumentBuilder(595.28, 841.89, 34);
  const w = doc.contentWidth;
  const x0 = doc.margin;
  const xRight = doc.pageWidth - doc.margin;

  const storeName = input.profile?.name?.trim() || 'Restaurant';
  const reportTitle = input.title?.trim() || `${storeName} - Sales & Financial Report`;
  const generatedStr = format(input.generatedAt || new Date(), 'MMM d, yyyy h:mm a');
  const { analytics } = input;

  // Report Cover Banner
  const headerH = 76;
  doc.drawRect(x0, doc.y, w, headerH, { fill: COLORS.brandDark });
  doc.drawText('ORDERFLOW FINANCIAL & OPERATIONS REPORT', x0 + 16, doc.y + 20, {
    font: 'F2',
    size: 8.5,
    color: [0.68, 0.88, 0.75],
  });
  doc.drawText(reportTitle.slice(0, 56), x0 + 16, doc.y + 40, {
    font: 'F2',
    size: 16,
    color: COLORS.white,
  });
  doc.drawText(`Period: ${input.rangeLabel}   |   Generated: ${generatedStr}`, x0 + 16, doc.y + 58, {
    font: 'F1',
    size: 9,
    color: [0.82, 0.86, 0.84],
  });
  if (input.preparedBy) {
    doc.drawText(`Prepared by: ${input.preparedBy}`, xRight - 16, doc.y + 58, {
      font: 'F1',
      size: 8.5,
      color: [0.82, 0.86, 0.84],
      align: 'right',
    });
  }
  doc.y += headerH + 14;

  if (input.notes?.trim()) {
    const lines = wrapPdfText(`Report Memo: ${input.notes.trim()}`, w - 24, 9, 'F1');
    const h = 14 + lines.length * 12;
    doc.drawRect(x0, doc.y, w, h, { fill: COLORS.brandTint, stroke: COLORS.brandGreen, lineWidth: 0.6 });
    let ny = doc.y + 14;
    for (const l of lines) {
      doc.drawText(l, x0 + 12, ny, { font: 'F1', size: 9, color: COLORS.ink });
      ny += 12;
    }
    doc.y += h + 12;
  }

  const drawSectionHeading = (title: string, subtitle?: string) => {
    doc.ensureSpace(44);
    doc.drawText(title.toUpperCase(), x0, doc.y + 12, { font: 'F2', size: 10.5, color: COLORS.brandGreen });
    if (subtitle) {
      doc.drawText(subtitle, xRight, doc.y + 12, { font: 'F1', size: 8.5, color: COLORS.muted, align: 'right' });
    }
    doc.drawLine(x0, doc.y + 17, xRight, doc.y + 17, { color: COLORS.brandGreen, lineWidth: 1 });
    doc.y += 24;
  };

  const drawTable = (
    columns: { header: string; width: number; align?: 'left' | 'right' | 'center'; mono?: boolean }[],
    rows: string[][],
  ) => {
    const headerH = 20;
    const rowH = 18;
    const renderHeader = () => {
      doc.drawRect(x0, doc.y, w, headerH, { fill: COLORS.brandDark });
      let cx = x0;
      for (const col of columns) {
        const tx = col.align === 'right' ? cx + col.width - 8 : col.align === 'center' ? cx + col.width / 2 : cx + 8;
        doc.drawText(col.header, tx, doc.y + 13, {
          font: 'F2',
          size: 8,
          color: COLORS.white,
          align: col.align || 'left',
        });
        cx += col.width;
      }
      doc.y += headerH;
    };

    doc.ensureSpace(headerH + rowH * Math.min(rows.length, 3));
    renderHeader();

    if (rows.length === 0) {
      doc.drawRect(x0, doc.y, w, rowH + 4, { fill: COLORS.soft, stroke: COLORS.line, lineWidth: 0.5 });
      doc.drawText('No records in this period.', x0 + 10, doc.y + 14, { font: 'F1', size: 8.5, color: COLORS.muted });
      doc.y += rowH + 12;
      return;
    }

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      doc.ensureSpace(rowH + 4, renderHeader);
      if (rIdx % 2 === 1) {
        doc.drawRect(x0, doc.y, w, rowH, { fill: [0.975, 0.98, 0.975] });
      }
      doc.drawLine(x0, doc.y + rowH, xRight, doc.y + rowH, { color: COLORS.line, lineWidth: 0.4 });
      let cx = x0;
      const row = rows[rIdx];
      for (let cIdx = 0; cIdx < columns.length; cIdx++) {
        const col = columns[cIdx];
        const cell = row[cIdx] ?? '';
        const tx = col.align === 'right' ? cx + col.width - 8 : col.align === 'center' ? cx + col.width / 2 : cx + 8;
        const maxChars = Math.max(6, Math.floor(col.width / 5.1));
        const clipped = cell.length > maxChars ? `${cell.slice(0, maxChars - 2)}..` : cell;
        doc.drawText(clipped, tx, doc.y + 12.5, {
          font: col.mono ? 'F3' : cIdx === 0 ? 'F2' : 'F1',
          size: 8.5,
          color: COLORS.ink,
          align: col.align || 'left',
        });
        cx += col.width;
      }
      doc.y += rowH;
    }
    doc.y += 12;
  };

  // 1. Executive Summary & Revenue Reconciliation
  if (sections.executiveSummary) {
    drawSectionHeading('1. Executive Financial Summary', `${analytics.salesCount} Valid Sales  |  ${analytics.cancelledCount} Cancelled`);

    const kpis: { label: string; value: string; sub: string }[] = [
      { label: 'NET COLLECTED SALES', value: formatMoney(analytics.netSales), sub: `Avg Ticket ${formatMoney(analytics.avgOrderValue)}` },
      { label: 'GROSS BILLED TOTAL', value: formatMoney(analytics.grossTotal), sub: `Subtotal ${formatMoney(analytics.grossSubtotal)}` },
      { label: 'CARD / CASH SPLIT', value: `${formatMoney(analytics.cardCollected)} / ${formatMoney(analytics.cashCollected)}`, sub: `Cash Due ${formatMoney(analytics.cashDue)}` },
      { label: 'TAX & TIPS COLLECTED', value: `${formatMoney(analytics.tax)} / ${formatMoney(analytics.totalTips)}`, sub: `${analytics.totalItemsSold} Items Sold` },
    ];

    const cardGap = 8;
    const cardW = (w - cardGap * 3) / 4;
    const cardH = 52;
    doc.ensureSpace(cardH + 14);
    for (let i = 0; i < kpis.length; i++) {
      const kx = x0 + i * (cardW + cardGap);
      doc.drawRect(kx, doc.y, cardW, cardH, {
        fill: i === 0 ? COLORS.brandTint : COLORS.soft,
        stroke: i === 0 ? COLORS.brandGreen : COLORS.line,
        lineWidth: 0.75,
      });
      doc.drawText(kpis[i].label, kx + 8, doc.y + 13, { font: 'F2', size: 7, color: COLORS.muted });
      doc.drawText(kpis[i].value, kx + 8, doc.y + 30, {
        font: 'F4',
        size: 10.5,
        color: i === 0 ? COLORS.brandGreen : COLORS.ink,
      });
      doc.drawText(kpis[i].sub, kx + 8, doc.y + 44, { font: 'F1', size: 7.5, color: COLORS.muted });
    }
    doc.y += cardH + 12;

    // Revenue Waterfall Table
    drawTable(
      [
        { header: 'REVENUE RECONCILIATION COMPONENT', width: w * 0.65, align: 'left' },
        { header: 'AMOUNT', width: w * 0.35, align: 'right', mono: true },
      ],
      [
        ['Gross Food & Beverage Subtotal', formatMoney(analytics.grossSubtotal)],
        ['Promotional Discounts Redeemed', `-${formatMoney(analytics.discounts)}`],
        ['Delivery Fees Collected', formatMoney(analytics.deliveryFees)],
        ['Service Fees Collected', formatMoney(analytics.serviceFees)],
        ['Sales Tax Collected', formatMoney(analytics.tax)],
        ['Restaurant Tips + Driver Tips', `${formatMoney(analytics.restaurantTips)} + ${formatMoney(analytics.deliveryTips)} (${formatMoney(analytics.totalTips)})`],
        ['Gross Billed Order Total', formatMoney(analytics.grossTotal)],
        ['Refunds Issued', `-${formatMoney(analytics.refunds)}`],
        ['NET COLLECTED REVENUE', formatMoney(analytics.netSales)],
      ],
    );
  }

  // 2. Payment Method & Fulfillment Breakdown
  if (sections.paymentAndFulfillment) {
    drawSectionHeading('2. Payment Method & Fulfillment Breakdown');
    drawTable(
      [
        { header: 'PAYMENT CHANNEL', width: w * 0.34, align: 'left' },
        { header: 'ORDERS', width: w * 0.14, align: 'right', mono: true },
        { header: 'GROSS', width: w * 0.18, align: 'right', mono: true },
        { header: 'REFUNDED', width: w * 0.16, align: 'right', mono: true },
        { header: 'NET / SHARE', width: w * 0.18, align: 'right', mono: true },
      ],
      analytics.paymentBreakdown.map((p) => [
        p.label,
        String(p.orders),
        formatMoney(p.grossAmount),
        formatMoney(p.refundedAmount),
        `${formatMoney(p.netAmount)} (${p.sharePercent}%)`,
      ]),
    );

    drawTable(
      [
        { header: 'FULFILLMENT TYPE', width: w * 0.28, align: 'left' },
        { header: 'ORDERS', width: w * 0.12, align: 'right', mono: true },
        { header: 'SUBTOTAL', width: w * 0.15, align: 'right', mono: true },
        { header: 'DELIVERY FEES', width: w * 0.15, align: 'right', mono: true },
        { header: 'AVG TICKET', width: w * 0.14, align: 'right', mono: true },
        { header: 'NET / SHARE', width: w * 0.16, align: 'right', mono: true },
      ],
      analytics.fulfillmentBreakdown.map((f) => [
        f.label,
        String(f.orders),
        formatMoney(f.grossSubtotal),
        formatMoney(f.deliveryFees),
        formatMoney(f.avgOrderValue),
        `${formatMoney(f.netSales)} (${f.sharePercent}%)`,
      ]),
    );
  }

  // 3. Category Breakdown
  if (sections.categoryBreakdown) {
    drawSectionHeading('3. Sales by Menu Category');
    drawTable(
      [
        { header: 'CATEGORY NAME', width: w * 0.42, align: 'left' },
        { header: 'ORDERS', width: w * 0.16, align: 'right', mono: true },
        { header: 'QTY SOLD', width: w * 0.16, align: 'right', mono: true },
        { header: 'ITEM REVENUE', width: w * 0.26, align: 'right', mono: true },
      ],
      analytics.categoryBreakdown.map((c) => [
        c.categoryName,
        String(c.orderCount),
        String(c.quantitySold),
        `${formatMoney(c.grossRevenue)} (${c.sharePercent}%)`,
      ]),
    );
  }

  // 4. Item Breakdown
  if (sections.itemBreakdown) {
    drawSectionHeading('4. Menu Item Sales Performance', `Top ${Math.min(analytics.itemBreakdown.length, 30)} items`);
    drawTable(
      [
        { header: 'MENU ITEM', width: w * 0.32, align: 'left' },
        { header: 'CATEGORY', width: w * 0.2, align: 'left' },
        { header: 'QTY', width: w * 0.1, align: 'right', mono: true },
        { header: 'AVG PRICE', width: w * 0.14, align: 'right', mono: true },
        { header: 'REVENUE / SHARE', width: w * 0.24, align: 'right', mono: true },
      ],
      analytics.itemBreakdown.slice(0, 30).map((item) => [
        item.name,
        item.categoryName,
        String(item.quantitySold),
        formatMoney(item.unitPriceAvg),
        `${formatMoney(item.grossRevenue)} (${item.sharePercent}%)`,
      ]),
    );
  }

  // 5. Peak Hours & Day-of-Week Analysis
  if (sections.hourlyAndWeekday) {
    const peakNote = analytics.peakHour
      ? `Peak Hour: ${analytics.peakHour.label.toUpperCase()} (${analytics.peakHour.orders} orders, ${formatMoney(analytics.peakHour.revenue)})`
      : 'No peak hour recorded';
    drawSectionHeading('5. Day-of-Week & Peak Rush Hour Breakdown', peakNote);

    drawTable(
      [
        { header: 'DAY OF WEEK', width: w * 0.34, align: 'left' },
        { header: 'ORDERS', width: w * 0.22, align: 'right', mono: true },
        { header: 'AVG ORDER VALUE', width: w * 0.22, align: 'right', mono: true },
        { header: 'NET REVENUE', width: w * 0.22, align: 'right', mono: true },
      ],
      analytics.weekdayBreakdown.map((d) => [
        d.label,
        String(d.orders),
        formatMoney(d.avgOrderValue),
        formatMoney(d.revenue),
      ]),
    );

    const activeHours = analytics.hourlyBreakdown.filter((h) => h.orders > 0);
    if (activeHours.length > 0) {
      drawTable(
        [
          { header: 'HOUR WINDOW', width: w * 0.34, align: 'left' },
          { header: 'ORDERS', width: w * 0.22, align: 'right', mono: true },
          { header: 'AVG ORDER VALUE', width: w * 0.22, align: 'right', mono: true },
          { header: 'NET REVENUE', width: w * 0.22, align: 'right', mono: true },
        ],
        activeHours.map((h) => [
          h.label.toUpperCase(),
          String(h.orders),
          formatMoney(h.avgOrderValue),
          formatMoney(h.revenue),
        ]),
      );
    }
  }

  // 6. Promo Codes & Driver / Cash Reconciliation
  if (sections.promoAndDriver) {
    drawSectionHeading('6. Promo Codes, Drivers & Cash Reconciliation');
    if (analytics.promoBreakdown.length > 0) {
      drawTable(
        [
          { header: 'PROMO CODE', width: w * 0.36, align: 'left', mono: true },
          { header: 'REDEMPTIONS', width: w * 0.2, align: 'right', mono: true },
          { header: 'DISCOUNT GIVEN', width: w * 0.22, align: 'right', mono: true },
          { header: 'NET SALES GENERATED', width: w * 0.22, align: 'right', mono: true },
        ],
        analytics.promoBreakdown.map((p) => [
          p.code,
          String(p.orders),
          formatMoney(p.totalDiscount),
          formatMoney(p.netSalesGenerated),
        ]),
      );
    }

    if (analytics.driverBreakdown.length > 0) {
      drawTable(
        [
          { header: 'DRIVER NAME', width: w * 0.28, align: 'left' },
          { header: 'DELIVERIES', width: w * 0.14, align: 'right', mono: true },
          { header: 'DEL. FEES', width: w * 0.14, align: 'right', mono: true },
          { header: 'DRIVER TIPS', width: w * 0.14, align: 'right', mono: true },
          { header: 'CASH PAID', width: w * 0.15, align: 'right', mono: true },
          { header: 'CASH DUE', width: w * 0.15, align: 'right', mono: true },
        ],
        analytics.driverBreakdown.map((d) => [
          d.driverName,
          `${d.completedCount}/${d.deliveriesCount}`,
          formatMoney(d.deliveryFees),
          formatMoney(d.driverTips),
          formatMoney(d.cashCollected),
          formatMoney(d.cashDue),
        ]),
      );
    }

    if (analytics.cashCollectors.length > 0) {
      drawTable(
        [
          { header: 'CASH COLLECTED BY (STAFF / DRIVER)', width: w * 0.5, align: 'left' },
          { header: 'CASH ORDERS', width: w * 0.25, align: 'right', mono: true },
          { header: 'TOTAL CASH COLLECTED', width: w * 0.25, align: 'right', mono: true },
        ],
        analytics.cashCollectors.map((c) => [
          c.collectorName,
          String(c.ordersCount),
          formatMoney(c.amountCollected),
        ]),
      );
    }
  }

  // 7. Itemized Order Ledger
  if (sections.orderLedger) {
    const ledgerOrders = input.orders.filter((o) => o.status !== 'payment_pending').slice(0, 120);
    drawSectionHeading('7. Itemized Order Ledger', `Showing ${ledgerOrders.length} orders`);
    drawTable(
      [
        { header: 'ORDER #', width: w * 0.13, align: 'left', mono: true },
        { header: 'DATE / TIME', width: w * 0.21, align: 'left' },
        { header: 'CUSTOMER', width: w * 0.2, align: 'left' },
        { header: 'TYPE', width: w * 0.11, align: 'left' },
        { header: 'STATUS', width: w * 0.13, align: 'left' },
        { header: 'PAYMENT', width: w * 0.1, align: 'left' },
        { header: 'TOTAL', width: w * 0.12, align: 'right', mono: true },
      ],
      ledgerOrders.map((o) => {
        const dt = toDate(o.createdAt);
        return [
          `#${orderCode(o)}`,
          dt ? format(dt, 'MMM d, HH:mm') : '-',
          o.customerName || 'Guest',
          o.type === 'delivery' ? 'Delivery' : 'Pickup',
          STATUS_LABEL[o.status] || o.status,
          paymentMethodOf(o).toUpperCase(),
          formatMoney(netAmount(o)),
        ];
      }),
    );
  }

  doc.addPageFooters(`${reportTitle}  |  ${input.rangeLabel}  |  Powered by OrderFlow`);
  return doc.buildBytes();
}

/**
 * Triggers a browser download for a generated PDF Uint8Array.
 */
export function downloadPdfBytes(bytes: Uint8Array, filename: string): void {
  const safeName = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2500);
}

/**
 * Convenience helper to immediately generate and download an order receipt PDF.
 */
export function downloadOrderReceiptPdf(
  order: Order,
  profile?: RestaurantProfile | null,
  variant: ReceiptVariant = 'customer',
): void {
  const bytes = generateOrderReceiptPdf(order, profile, { variant });
  downloadPdfBytes(bytes, receiptFilename(order, variant));
}
