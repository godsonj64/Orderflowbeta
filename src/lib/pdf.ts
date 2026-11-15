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

type FontKey = 'F1' | 'F2' | 'F3' | 'F4'; // Standard Type1 sans-serif (Helvetica / Helvetica-Bold)
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
    .replace(/\s*(?:\u00B7|\u2022)\s*/g, ' - ')
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

/**
 * Conservative width estimation in points for Helvetica / Helvetica-Bold so wide
 * uppercase strings (like `ORDER #UG6YNY`) never overflow their solid container blocks.
 */
export function estimateTextWidth(text: string, fontSize: number, font: FontKey = 'F1'): number {
  const clean = sanitizePdfText(text);
  let units = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if ('ilI.,:;!| '.includes(ch)) units += 0.3;
    else if ('mwMW@%'.includes(ch)) units += 0.84;
    else if (ch >= 'A' && ch <= 'Z') units += 0.72;
    else if ((ch >= '0' && ch <= '9') || '#$+-=/'.includes(ch)) units += 0.62;
    else units += 0.56;
  }
  const boldFactor = font === 'F2' || font === 'F4' ? 1.08 : 1.0;
  return units * fontSize * boldFactor;
}

/**
 * Computes a scaled font size so `text` fits comfortably within `maxWidth` points.
 */
export function fitPdfFontSize(
  text: string,
  maxWidth: number,
  maxFontSize: number,
  minFontSize = 6.5,
  font: FontKey = 'F1',
): number {
  const clean = sanitizePdfText(text);
  if (!clean || maxWidth <= 0) return maxFontSize;
  const naturalWidth = estimateTextWidth(clean, maxFontSize, font);
  if (naturalWidth <= maxWidth) return maxFontSize;
  const scaled = Math.floor(((maxFontSize * maxWidth) / naturalWidth) * 100) / 100;
  return Math.max(minFontSize, scaled);
}

/**
 * Truncates `text` only if it still exceeds `maxWidth` at `fontSize`, preferring word/separator boundaries.
 */
export function clipPdfTextToWidth(text: string, maxWidth: number, fontSize: number, font: FontKey = 'F1'): string {
  const clean = sanitizePdfText(text).trim();
  if (!clean || estimateTextWidth(clean, fontSize, font) <= maxWidth) return clean;
  const ellipsis = '...';
  const targetWidth = Math.max(10, maxWidth - estimateTextWidth(ellipsis, fontSize, font));
  let out = '';
  for (let i = 0; i < clean.length; i++) {
    const next = out + clean[i];
    if (estimateTextWidth(next, fontSize, font) > targetWidth) break;
    out = next;
  }
  return `${out.trimEnd()}${ellipsis}`;
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
      minSize?: number;
      maxWidth?: number;
      color?: Rgb;
      align?: 'left' | 'center' | 'right';
      pageIndex?: number;
    },
  ): void {
    let clean = sanitizePdfText(text);
    if (!clean) return;
    const font = options?.font ?? 'F1';
    const requestedSize = options?.size ?? 10;
    const minSize = options?.minSize ?? 6.5;
    const maxWidth = options?.maxWidth;

    const size =
      maxWidth && maxWidth > 0
        ? fitPdfFontSize(clean, maxWidth, requestedSize, minSize, font)
        : requestedSize;

    if (maxWidth && maxWidth > 0 && estimateTextWidth(clean, size, font) > maxWidth + 0.5) {
      clean = clipPdfTextToWidth(clean, maxWidth, size, font);
    }

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
      this.drawRect(this.margin, footerY - 12, this.contentWidth, 16, {
        fill: [0.067, 0.075, 0.082],
        pageIndex: i,
      });
      this.drawRect(this.margin, footerY - 12, 6, 16, {
        fill: [0.953, 0.569, 0.125],
        pageIndex: i,
      });
      this.drawText(leftLabel, this.margin + 12, footerY - 1.5, {
        font: 'F2',
        size: 7.5,
        minSize: 6,
        maxWidth: this.contentWidth - 95,
        color: [0.85, 0.87, 0.86],
        pageIndex: i,
      });
      this.drawText(`PAGE ${i + 1} OF ${total}`, this.pageWidth - this.margin - 8, footerY - 1.5, {
        font: 'F2',
        size: 7.5,
        color: [0.953, 0.569, 0.125],
        align: 'right',
        pageIndex: i,
      });
    }
  }

  buildBytes(): Uint8Array {
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

/**
 * Palette inspired by the Industrial Swatch & Woven Label reference cards:
 * - Iron Core (#111315 / #222A2A)
 * - Industrial Aqua (#4FBBBC)
 * - Rust Signal (#EC4624)
 * - Heat Marker (#F39120)
 * - Architectural Cream (#EFECE1)
 * - Kitchen Emerald (#16A34A)
 */
const COLORS = {
  ironCore: [0.067, 0.075, 0.082] as Rgb, // #111315
  ironSlate: [0.133, 0.165, 0.165] as Rgb, // #222A2A
  industrialAqua: [0.31, 0.733, 0.737] as Rgb, // #4FBBBC
  rustSignal: [0.925, 0.275, 0.141] as Rgb, // #EC4624
  heatMarker: [0.953, 0.569, 0.125] as Rgb, // #F39120
  archCream: [0.937, 0.925, 0.882] as Rgb, // #EFECE1
  archCreamBorder: [0.835, 0.808, 0.71] as Rgb, // #D5CEB5
  emeraldSolid: [0.086, 0.639, 0.29] as Rgb, // #16A34A
  emeraldBright: [0.29, 0.871, 0.502] as Rgb, // #4ADE80
  ink: [0.09, 0.11, 0.1] as Rgb,
  muted: [0.42, 0.46, 0.44] as Rgb,
  mutedLight: [0.74, 0.77, 0.76] as Rgb,
  line: [0.85, 0.87, 0.86] as Rgb,
  soft: [0.96, 0.965, 0.96] as Rgb,
  white: [1, 1, 1] as Rgb,
};

/**
 * Generates a complete, printable & downloadable PDF receipt for an order,
 * styled with solid architectural split-block banners and auto-scaling typography.
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

  const accentColor: Rgb =
    variant === 'driver'
      ? COLORS.industrialAqua
      : variant === 'kitchen'
        ? COLORS.heatMarker
        : COLORS.emeraldSolid;

  const accentTextOnBlock: Rgb =
    variant === 'driver' || variant === 'kitchen' ? COLORS.ironCore : COLORS.white;

  // 1. Top Split-Zone Solid Header Banner (Left Solid Code Block + Center Iron Core)
  const headerH = 76;
  const leftBlockW = 118;
  const rightStripW = 0;
  const centerMaxW = w - leftBlockW - 28;

  // Center Iron Core Body
  doc.drawRect(x0, doc.y, w, headerH, { fill: COLORS.ironCore });
  // Left Solid Accent Block
  doc.drawRect(x0, doc.y, leftBlockW, headerH, { fill: accentColor });

  // Left Block Text: ORDER #CODE (auto-fitted to leftBlockW - 18 so 6+ char codes like #UG6YNY never overflow)
  doc.drawText(`ORDER #${code}`, x0 + leftBlockW / 2, doc.y + 35, {
    font: 'F4',
    size: 13,
    minSize: 8,
    maxWidth: leftBlockW - 18,
    color: accentTextOnBlock,
    align: 'center',
  });
  doc.drawText(isDelivery ? 'DELIVERY' : 'PICKUP', x0 + leftBlockW / 2, doc.y + 52, {
    font: 'F2',
    size: 8.5,
    maxWidth: leftBlockW - 18,
    color: accentTextOnBlock,
    align: 'center',
  });

  // Center Block Text: Kicker, Restaurant Name, Contact Info, Status
  const centerX = x0 + leftBlockW + 14;
  const statusStr = STATUS_LABEL[order.status].toUpperCase();
  const statusW = estimateTextWidth(statusStr, 8.5, 'F2') + 12;

  doc.drawText(variantTitle, centerX, doc.y + 20, {
    font: 'F2',
    size: 8.5,
    minSize: 6.5,
    maxWidth: centerMaxW - statusW,
    color: variant === 'customer' || variant === 'staff' ? COLORS.emeraldBright : accentColor,
  });
  doc.drawText(statusStr, xRight - rightStripW - 12, doc.y + 20, {
    font: 'F2',
    size: 8.5,
    color: COLORS.mutedLight,
    align: 'right',
  });
  doc.drawText(storeName, centerX, doc.y + 41, {
    font: 'F2',
    size: 18,
    minSize: 11,
    maxWidth: centerMaxW,
    color: COLORS.white,
  });

  const contactParts = [storeAddress, storePhone, storeEmail].filter(Boolean).join('  |  ');
  if (contactParts) {
    // Auto-scales the contact line so long emails like orders@huddlesnackstop.com never get chopped mid-word
    doc.drawText(contactParts, centerX, doc.y + 58, {
      font: 'F1',
      size: 8.5,
      minSize: 6.5,
      maxWidth: centerMaxW,
      color: COLORS.mutedLight,
    });
  }

  doc.y += headerH + 12;

  // 2. Solid Split-Block Payment / Cash Collection Banner
  const payBannerH = 42;
  const payBadgeW = 92;
  const payRightPad = 92;
  const payTextMaxW = w - payBadgeW - payRightPad - 24;
  const payBannerAccent: Rgb = cashDue ? COLORS.heatMarker : COLORS.emeraldSolid;
  const payBadgeInk: Rgb = cashDue ? COLORS.ironCore : COLORS.white;

  doc.drawRect(x0, doc.y, w, payBannerH, { fill: COLORS.ironSlate });
  doc.drawRect(x0, doc.y, payBadgeW, payBannerH, { fill: payBannerAccent });

  doc.drawText(cashDue ? 'CASH DUE' : 'PAID', x0 + payBadgeW / 2, doc.y + 20, {
    font: 'F2',
    size: 10,
    maxWidth: payBadgeW - 12,
    color: payBadgeInk,
    align: 'center',
  });
  doc.drawText(paymentMethodOf(order).toUpperCase(), x0 + payBadgeW / 2, doc.y + 32, {
    font: 'F1',
    size: 7.5,
    maxWidth: payBadgeW - 12,
    color: payBadgeInk,
    align: 'center',
  });

  // Note: `pay.label` already includes the method (e.g. "Paid · Cash" or "Paid · Card")
  const payHeadline = cashDue
    ? `COLLECT ${formatMoney(order.total)} IN CASH (${isDelivery ? 'AT DROP-OFF' : 'AT PICKUP'})`
    : `${pay.label.toUpperCase()} - DO NOT COLLECT CASH`;

  doc.drawText(payHeadline, x0 + payBadgeW + 14, doc.y + 18, {
    font: 'F2',
    size: 10,
    minSize: 7.5,
    maxWidth: payTextMaxW,
    color: cashDue ? COLORS.heatMarker : COLORS.white,
  });

  const paySubline =
    variant === 'driver'
      ? `Driver Tip: ${formatMoney(order.deliveryTip || 0)}   |   Delivery Fee: ${formatMoney(order.deliveryFee || 0)}   |   Driver: ${order.driverName || 'Unassigned'}`
      : order.paymentCollectedBy && order.paymentStatus === 'paid'
        ? `Recorded by: ${order.paymentCollectedBy}   |   Order ID: ${order.id}`
        : `Order Reference: #${code}   |   ID: ${order.id}`;

  doc.drawText(paySubline, x0 + payBadgeW + 14, doc.y + 32, {
    font: 'F1',
    size: 8.5,
    minSize: 6.5,
    maxWidth: payTextMaxW,
    color: COLORS.mutedLight,
  });

  doc.drawText(formatMoney(order.total), xRight - 14, doc.y + 26, {
    font: 'F4',
    size: 13,
    minSize: 9,
    maxWidth: payRightPad - 12,
    color: cashDue ? COLORS.heatMarker : COLORS.emeraldBright,
    align: 'right',
  });

  doc.y += payBannerH + 12;

  // 3. Architectural Cream 3-Column Metadata Swatch Box (inspired by IRON CORE / ARCHITECTURAL CREAM reference)
  const metaH = 72;
  doc.drawRect(x0, doc.y, w, metaH, {
    fill: COLORS.archCream,
    stroke: COLORS.archCreamBorder,
    lineWidth: 0.85,
  });
  const colW = w / 3;
  const colInnerW = colW - 22;
  doc.drawLine(x0 + colW, doc.y + 10, x0 + colW, doc.y + metaH - 10, {
    color: COLORS.archCreamBorder,
    lineWidth: 0.7,
  });
  doc.drawLine(x0 + colW * 2, doc.y + 10, x0 + colW * 2, doc.y + metaH - 10, {
    color: COLORS.archCreamBorder,
    lineWidth: 0.7,
  });

  // Column 1: Order Timing & Schedule
  doc.drawText('PLACED & TIMING', x0 + 12, doc.y + 17, {
    font: 'F2',
    size: 7.5,
    maxWidth: colInnerW,
    color: COLORS.rustSignal,
  });
  doc.drawText(createdStr, x0 + 12, doc.y + 32, {
    font: 'F2',
    size: 9.5,
    minSize: 7,
    maxWidth: colInnerW,
    color: COLORS.ironCore,
  });
  doc.drawText(
    order.scheduledTime ? `Scheduled: ${order.scheduledTime}` : 'ASAP Kitchen Preparation',
    x0 + 12,
    doc.y + 46,
    { font: 'F1', size: 8.5, minSize: 6.5, maxWidth: colInnerW, color: COLORS.ironSlate },
  );
  doc.drawText(`ID: ${order.id}`, x0 + 12, doc.y + 59, {
    font: 'F3',
    size: 7.5,
    minSize: 6,
    maxWidth: colInnerW,
    color: COLORS.muted,
  });

  // Column 2: Customer & Contact
  const c2x = x0 + colW + 12;
  doc.drawText('CUSTOMER & CONTACT', c2x, doc.y + 17, {
    font: 'F2',
    size: 7.5,
    maxWidth: colInnerW,
    color: COLORS.rustSignal,
  });
  doc.drawText(order.customerName || 'Guest', c2x, doc.y + 32, {
    font: 'F2',
    size: 10,
    minSize: 7.5,
    maxWidth: colInnerW,
    color: COLORS.ironCore,
  });
  doc.drawText(`Phone: ${order.customerPhone || 'Not provided'}`, c2x, doc.y + 46, {
    font: 'F1',
    size: 8.5,
    minSize: 6.5,
    maxWidth: colInnerW,
    color: COLORS.ironSlate,
  });
  if (order.driverName) {
    doc.drawText(`Driver: ${order.driverName}`, c2x, doc.y + 59, {
      font: 'F2',
      size: 8.5,
      minSize: 6.5,
      maxWidth: colInnerW,
      color: COLORS.ironCore,
    });
  }

  // Column 3: Fulfillment Destination
  const c3x = x0 + colW * 2 + 12;
  doc.drawText(isDelivery ? 'DELIVERY DESTINATION' : 'PICKUP LOCATION', c3x, doc.y + 17, {
    font: 'F2',
    size: 7.5,
    maxWidth: colInnerW,
    color: COLORS.rustSignal,
  });
  const locationLine = isDelivery
    ? order.deliveryAddress || 'Address on file'
    : storeAddress || storeName;
  const locWrapped = wrapPdfText(locationLine, colInnerW, 8.5, 'F2');
  let locY = doc.y + 32;
  for (const line of locWrapped.slice(0, 3)) {
    doc.drawText(line, c3x, locY, { font: 'F2', size: 8.5, minSize: 6.5, maxWidth: colInnerW, color: COLORS.ironCore });
    locY += 12;
  }

  doc.y += metaH + 12;

  // 4. Solid Rust Signal Split Banner for Special Order Notes
  if (order.notes) {
    const noteLines = wrapPdfText(order.notes, w - 106, 9, 'F2');
    const noteH = Math.max(28, 12 + noteLines.length * 12);
    doc.drawRect(x0, doc.y, w, noteH, { fill: COLORS.ironCore });
    doc.drawRect(x0, doc.y, 72, noteH, { fill: COLORS.rustSignal });
    doc.drawText('NOTE', x0 + 36, doc.y + noteH / 2 + 3, {
      font: 'F2',
      size: 9,
      color: COLORS.white,
      align: 'center',
    });
    let ny = doc.y + 14;
    for (const line of noteLines) {
      doc.drawText(line, x0 + 84, ny, { font: 'F2', size: 9, maxWidth: w - 96, color: COLORS.white });
      ny += 12;
    }
    doc.y += noteH + 12;
  }

  // 5. Itemized Table Header (Solid Iron Core + Accent Strip)
  const drawItemsHeader = () => {
    doc.drawRect(x0, doc.y, w, 24, { fill: COLORS.ironCore });
    doc.drawRect(x0, doc.y, 42, 24, { fill: accentColor });
    doc.drawText('QTY', x0 + 21, doc.y + 15, {
      font: 'F2',
      size: 8.5,
      color: accentTextOnBlock,
      align: 'center',
    });
    doc.drawText('ITEM & CUSTOMIZATIONS', x0 + 54, doc.y + 15, {
      font: 'F2',
      size: 8.5,
      color: COLORS.white,
    });
    if (variant !== 'kitchen') {
      doc.drawText('UNIT PRICE', xRight - 94, doc.y + 15, {
        font: 'F2',
        size: 8.5,
        color: COLORS.mutedLight,
        align: 'right',
      });
      doc.drawText('LINE TOTAL', xRight - 12, doc.y + 15, {
        font: 'F2',
        size: 8.5,
        color: COLORS.white,
        align: 'right',
      });
    }
    doc.y += 24;
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
    const rowH = 22 + modLines.length * 11 + noteLines.length * 11;

    doc.ensureSpace(rowH + 12, drawItemsHeader);

    if (idx % 2 === 1) {
      doc.drawRect(x0, doc.y, w, rowH, { fill: COLORS.soft });
    }
    doc.drawLine(x0, doc.y + rowH, xRight, doc.y + rowH, { color: COLORS.line, lineWidth: 0.5 });

    // Solid quantity pill block
    doc.drawRect(x0 + 8, doc.y + 4, 26, 14, { fill: COLORS.ironSlate });
    doc.drawText(`${item.quantity}x`, x0 + 21, doc.y + 14, {
      font: 'F4',
      size: 9,
      maxWidth: 22,
      color: COLORS.white,
      align: 'center',
    });

    let iy = doc.y + 14.5;
    doc.drawText(item.name, x0 + 54, iy, {
      font: 'F2',
      size: 10,
      minSize: 7.5,
      maxWidth: itemDescMaxWidth,
      color: COLORS.ink,
    });

    if (variant !== 'kitchen') {
      doc.drawText(formatMoney(item.price), xRight - 94, iy, {
        font: 'F3',
        size: 9.5,
        color: COLORS.muted,
        align: 'right',
      });
      doc.drawText(formatMoney(item.price * item.quantity), xRight - 12, iy, {
        font: 'F4',
        size: 9.5,
        color: COLORS.ink,
        align: 'right',
      });
    }

    for (const mLine of modLines) {
      iy += 11;
      doc.drawText(mLine, x0 + 54, iy, { font: 'F1', size: 8.5, color: COLORS.muted });
    }
    for (const nLine of noteLines) {
      iy += 11;
      doc.drawText(nLine, x0 + 54, iy, { font: 'F2', size: 8.5, color: COLORS.rustSignal });
    }

    doc.y += rowH;
  }

  doc.y += 14;

  // 6. Totals & Financial Breakdown Box + Solid Grand Total Banner
  if (variant !== 'kitchen') {
    const computedSub =
      order.subtotal !== undefined
        ? order.subtotal
        : (order.items || []).reduce((s, i) => s + i.price * i.quantity, 0);

    const rows: { label: string; value: string; color?: Rgb }[] = [
      { label: 'Subtotal', value: formatMoney(computedSub) },
    ];
    if (order.discountAmount && order.discountAmount > 0) {
      rows.push({
        label: `Discount${order.promoCode ? ` (${order.promoCode})` : ''}`,
        value: `-${formatMoney(order.discountAmount)}`,
        color: COLORS.emeraldSolid,
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

    const boxWidth = 250;
    const boxX = xRight - boxWidth;
    const subBoxH = rows.length * 16 + 10;
    const totalBarH = 30;
    const leftCardH = Math.max(subBoxH + totalBarH, 74);
    const totalHeight = Math.max(leftCardH, subBoxH + totalBarH + (order.refundAmount ? 22 : 0));

    doc.ensureSpace(totalHeight + 60);

    // Subtotals Card
    doc.drawRect(boxX, doc.y, boxWidth, subBoxH, {
      fill: COLORS.soft,
      stroke: COLORS.line,
      lineWidth: 0.75,
    });

    let ty = doc.y + 15;
    for (const r of rows) {
      doc.drawText(r.label, boxX + 12, ty, {
        font: 'F1',
        size: 9.5,
        maxWidth: boxWidth - 95,
        color: r.color || COLORS.muted,
      });
      doc.drawText(r.value, xRight - 12, ty, {
        font: 'F3',
        size: 9.5,
        color: r.color || COLORS.ink,
        align: 'right',
      });
      ty += 16;
    }

    // Solid Split-Block Grand Total Bar
    const totalY = doc.y + subBoxH;
    doc.drawRect(boxX, totalY, boxWidth, totalBarH, { fill: COLORS.ironCore });
    doc.drawRect(boxX, totalY, 108, totalBarH, {
      fill: cashDue ? COLORS.heatMarker : accentColor,
    });
    doc.drawText(cashDue ? 'TOTAL DUE' : 'GRAND TOTAL', boxX + 54, totalY + 19, {
      font: 'F2',
      size: 9,
      maxWidth: 96,
      color: cashDue ? COLORS.ironCore : accentTextOnBlock,
      align: 'center',
    });
    doc.drawText(formatMoney(order.total), xRight - 12, totalY + 20, {
      font: 'F4',
      size: 13,
      minSize: 9,
      maxWidth: boxWidth - 124,
      color: COLORS.white,
      align: 'right',
    });

    if (order.refundAmount && order.refundAmount > 0) {
      const refY = totalY + totalBarH + 2;
      doc.drawRect(boxX, refY, boxWidth, 20, { fill: COLORS.rustSignal });
      doc.drawText('REFUNDED', boxX + 10, refY + 13, { font: 'F2', size: 8, color: COLORS.white });
      doc.drawText(`-${formatMoney(order.refundAmount)} (Net ${formatMoney(netAmount(order))})`, xRight - 10, refY + 13, {
        font: 'F4',
        size: 8.5,
        maxWidth: boxWidth - 80,
        color: COLORS.white,
        align: 'right',
      });
    }

    // Left of totals box: Thank-you / Driver hand-off block
    const leftBlockW2 = w - boxWidth - 14;
    if (variant === 'driver') {
      doc.drawRect(x0, doc.y, leftBlockW2, leftCardH, {
        fill: COLORS.archCream,
        stroke: COLORS.archCreamBorder,
        lineWidth: 0.75,
      });
      doc.drawRect(x0, doc.y, leftBlockW2, 20, { fill: COLORS.ironSlate });
      doc.drawText('DELIVERY HAND-OFF CONFIRMATION', x0 + 10, doc.y + 13.5, {
        font: 'F2',
        size: 8,
        maxWidth: leftBlockW2 - 20,
        color: COLORS.industrialAqua,
      });
      doc.drawText(`Driver: ${order.driverName || '____________________'}`, x0 + 12, doc.y + 38, {
        font: 'F2',
        size: 9,
        maxWidth: leftBlockW2 - 24,
        color: COLORS.ironCore,
      });
      doc.drawText('Received By / Signature: _______________________', x0 + 12, doc.y + 58, {
        font: 'F1',
        size: 8.5,
        maxWidth: leftBlockW2 - 24,
        color: COLORS.ironSlate,
      });
    } else {
      doc.drawRect(x0, doc.y, leftBlockW2, leftCardH, {
        fill: COLORS.archCream,
        stroke: COLORS.archCreamBorder,
        lineWidth: 0.75,
      });
      doc.drawRect(x0, doc.y, 8, leftCardH, { fill: accentColor });
      doc.drawText(`Thank you for ordering from ${storeName}!`, x0 + 18, doc.y + 22, {
        font: 'F2',
        size: 10.5,
        minSize: 7.5,
        maxWidth: leftBlockW2 - 28,
        color: COLORS.ironCore,
      });
      doc.drawText(`Verified Receipt  |  Order #${code}`, x0 + 18, doc.y + 38, {
        font: 'F2',
        size: 8.5,
        maxWidth: leftBlockW2 - 28,
        color: COLORS.rustSignal,
      });
      doc.drawText(`Order ID: ${order.id}`, x0 + 18, doc.y + 52, {
        font: 'F1',
        size: 8,
        maxWidth: leftBlockW2 - 28,
        color: COLORS.ironSlate,
      });
      if (order.paymentIntentId && !order.paymentIntentId.startsWith('mock_')) {
        doc.drawText(`Card Ref: ${order.paymentIntentId.slice(-12)}`, x0 + 18, doc.y + 65, {
          font: 'F3',
          size: 8,
          maxWidth: leftBlockW2 - 28,
          color: COLORS.muted,
        });
      }
    }

    doc.y += totalHeight + 18;
  }

  doc.addPageFooters(`${storeName.toUpperCase()}  |  ORDER #${code}  |  VERIFIED ORDERFLOW RECEIPT`);
  return doc.buildBytes();
}

/**
 * Generates a customizable multi-page Sales & Insights PDF report styled with
 * solid architectural split-block banners and Industrial Swatch KPI cards.
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

  // Report Cover Split-Zone Solid Banner
  const headerH = 78;
  const leftBlockW = 114;
  const rightStripW = 0;
  const centerMaxW = w - leftBlockW - 28;

  doc.drawRect(x0, doc.y, w, headerH, { fill: COLORS.ironCore });
  doc.drawRect(x0, doc.y, leftBlockW, headerH, { fill: COLORS.heatMarker });

  doc.drawText(formatMoney(analytics.netSales), x0 + leftBlockW / 2, doc.y + 36, {
    font: 'F4',
    size: 13,
    minSize: 8,
    maxWidth: leftBlockW - 16,
    color: COLORS.ironCore,
    align: 'center',
  });
  doc.drawText('NET REVENUE', x0 + leftBlockW / 2, doc.y + 52, {
    font: 'F2',
    size: 7.5,
    maxWidth: leftBlockW - 16,
    color: COLORS.ironCore,
    align: 'center',
  });

  const cx0 = x0 + leftBlockW + 14;
  doc.drawText('ORDERFLOW FINANCIAL & OPERATIONS REPORT', cx0, doc.y + 20, {
    font: 'F2',
    size: 8.5,
    minSize: 6.5,
    maxWidth: centerMaxW - 120,
    color: COLORS.industrialAqua,
  });
  doc.drawText(reportTitle, cx0, doc.y + 40, {
    font: 'F2',
    size: 15.5,
    minSize: 9.5,
    maxWidth: centerMaxW,
    color: COLORS.white,
  });
  doc.drawText(`Period: ${input.rangeLabel}   |   Generated: ${generatedStr}`, cx0, doc.y + 58, {
    font: 'F1',
    size: 8.5,
    minSize: 6.5,
    maxWidth: centerMaxW,
    color: COLORS.mutedLight,
  });
  if (input.preparedBy) {
    doc.drawText(`Prepared by: ${input.preparedBy}`, xRight - rightStripW - 12, doc.y + 20, {
      font: 'F2',
      size: 8,
      minSize: 6.5,
      maxWidth: 115,
      color: COLORS.heatMarker,
      align: 'right',
    });
  }
  doc.y += headerH + 12;

  if (input.notes?.trim()) {
    const lines = wrapPdfText(input.notes.trim(), w - 102, 9, 'F1');
    const h = Math.max(26, 12 + lines.length * 12);
    doc.drawRect(x0, doc.y, w, h, { fill: COLORS.archCream, stroke: COLORS.archCreamBorder, lineWidth: 0.75 });
    doc.drawRect(x0, doc.y, 74, h, { fill: COLORS.rustSignal });
    doc.drawText('MEMO', x0 + 37, doc.y + h / 2 + 3, {
      font: 'F2',
      size: 8.5,
      color: COLORS.white,
      align: 'center',
    });
    let ny = doc.y + 14;
    for (const l of lines) {
      doc.drawText(l, x0 + 84, ny, { font: 'F2', size: 9, maxWidth: w - 96, color: COLORS.ironCore });
      ny += 12;
    }
    doc.y += h + 12;
  }

  // Solid Split-Block Section Heading
  const drawSectionHeading = (title: string, subtitle?: string, accent: Rgb = COLORS.industrialAqua) => {
    doc.ensureSpace(46);
    const barH = 24;
    doc.drawRect(x0, doc.y, w, barH, { fill: COLORS.ironCore });
    doc.drawRect(x0, doc.y, 10, barH, { fill: accent });
    const subW = subtitle ? estimateTextWidth(subtitle, 8, 'F2') + 20 : 0;
    doc.drawText(title.toUpperCase(), x0 + 18, doc.y + 15.5, {
      font: 'F2',
      size: 9.5,
      minSize: 7.5,
      maxWidth: w - 28 - subW,
      color: COLORS.white,
    });
    if (subtitle) {
      doc.drawText(subtitle, xRight - 10, doc.y + 15.5, {
        font: 'F2',
        size: 8,
        minSize: 6.5,
        maxWidth: w * 0.48,
        color: accent,
        align: 'right',
      });
    }
    doc.y += barH + 8;
  };

  const drawTable = (
    columns: { header: string; width: number; align?: 'left' | 'right' | 'center'; mono?: boolean }[],
    rows: string[][],
  ) => {
    const headerH = 20;
    const rowH = 18;
    const renderHeader = () => {
      doc.drawRect(x0, doc.y, w, headerH, { fill: COLORS.ironSlate });
      let cx = x0;
      for (const col of columns) {
        const tx = col.align === 'right' ? cx + col.width - 8 : col.align === 'center' ? cx + col.width / 2 : cx + 8;
        doc.drawText(col.header, tx, doc.y + 13, {
          font: 'F2',
          size: 8,
          minSize: 6,
          maxWidth: col.width - 12,
          color: COLORS.archCream,
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
        doc.drawRect(x0, doc.y, w, rowH, { fill: COLORS.soft });
      }
      doc.drawLine(x0, doc.y + rowH, xRight, doc.y + rowH, { color: COLORS.line, lineWidth: 0.4 });
      let cx = x0;
      const row = rows[rIdx];
      for (let cIdx = 0; cIdx < columns.length; cIdx++) {
        const col = columns[cIdx];
        const cell = row[cIdx] ?? '';
        const tx = col.align === 'right' ? cx + col.width - 8 : col.align === 'center' ? cx + col.width / 2 : cx + 8;
        doc.drawText(cell, tx, doc.y + 12.5, {
          font: col.mono ? 'F3' : cIdx === 0 ? 'F2' : 'F1',
          size: 8.5,
          minSize: 6.5,
          maxWidth: col.width - 12,
          color: COLORS.ink,
          align: col.align || 'left',
        });
        cx += col.width;
      }
      doc.y += rowH;
    }
    doc.y += 12;
  };

  // 1. Executive Summary & Revenue Reconciliation (with Solid Swatch KPI Cards inspired by reference palette)
  if (sections.executiveSummary) {
    drawSectionHeading(
      '1. Executive Financial Summary',
      `${analytics.salesCount} Valid Sales  |  ${analytics.cancelledCount} Cancelled`,
      COLORS.heatMarker,
    );

    const kpis: {
      label: string;
      value: string;
      sub: string;
      bg: Rgb;
      labelColor: Rgb;
      valueColor: Rgb;
      subColor: Rgb;
    }[] = [
      {
        label: 'NET COLLECTED SALES',
        value: formatMoney(analytics.netSales),
        sub: `Avg Ticket ${formatMoney(analytics.avgOrderValue)}`,
        bg: COLORS.ironSlate, // IRON CORE (#222A2A)
        labelColor: COLORS.heatMarker,
        valueColor: COLORS.white,
        subColor: COLORS.mutedLight,
      },
      {
        label: 'GROSS BILLED TOTAL',
        value: formatMoney(analytics.grossTotal),
        sub: `Subtotal ${formatMoney(analytics.grossSubtotal)}`,
        bg: COLORS.industrialAqua, // INDUSTRIAL AQUA (#4FBBBC)
        labelColor: COLORS.ironCore,
        valueColor: COLORS.ironCore,
        subColor: COLORS.ironSlate,
      },
      {
        label: 'CARD / CASH SPLIT',
        value: `${formatMoney(analytics.cardCollected)} / ${formatMoney(analytics.cashCollected)}`,
        sub: `Cash Due ${formatMoney(analytics.cashDue)}`,
        bg: COLORS.heatMarker, // HEAT MARKER (#F39120)
        labelColor: COLORS.ironCore,
        valueColor: COLORS.ironCore,
        subColor: COLORS.ironSlate,
      },
      {
        label: 'TAX & TIPS COLLECTED',
        value: `${formatMoney(analytics.tax)} / ${formatMoney(analytics.totalTips)}`,
        sub: `${analytics.totalItemsSold} Items Sold`,
        bg: COLORS.archCream, // ARCHITECTURAL CREAM (#EFECE1)
        labelColor: COLORS.rustSignal,
        valueColor: COLORS.ironCore,
        subColor: COLORS.ironSlate,
      },
    ];

    const cardGap = 8;
    const cardW = (w - cardGap * 3) / 4;
    const cardInnerW = cardW - 16;
    const cardH = 56;
    doc.ensureSpace(cardH + 14);
    for (let i = 0; i < kpis.length; i++) {
      const kx = x0 + i * (cardW + cardGap);
      doc.drawRect(kx, doc.y, cardW, cardH, { fill: kpis[i].bg });
      doc.drawText(kpis[i].label, kx + 8, doc.y + 15, {
        font: 'F2',
        size: 7,
        minSize: 5.8,
        maxWidth: cardInnerW,
        color: kpis[i].labelColor,
      });
      doc.drawText(kpis[i].value, kx + 8, doc.y + 33, {
        font: 'F4',
        size: 11,
        minSize: 7.2,
        maxWidth: cardInnerW,
        color: kpis[i].valueColor,
      });
      doc.drawText(kpis[i].sub, kx + 8, doc.y + 47, {
        font: 'F1',
        size: 7.5,
        minSize: 6,
        maxWidth: cardInnerW,
        color: kpis[i].subColor,
      });
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
    drawSectionHeading('2. Payment Method & Fulfillment Breakdown', undefined, COLORS.industrialAqua);
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
    drawSectionHeading('3. Sales by Menu Category', undefined, COLORS.rustSignal);
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
    drawSectionHeading('4. Menu Item Sales Performance', `Top ${Math.min(analytics.itemBreakdown.length, 30)} items`, COLORS.heatMarker);
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
    drawSectionHeading('5. Day-of-Week & Peak Rush Hour Breakdown', peakNote, COLORS.industrialAqua);

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
    drawSectionHeading('6. Promo Codes, Drivers & Cash Reconciliation', undefined, COLORS.rustSignal);
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
    drawSectionHeading('7. Itemized Order Ledger', `Showing ${ledgerOrders.length} orders`, COLORS.emeraldSolid);
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

  doc.addPageFooters(`${reportTitle.toUpperCase()}  |  ${input.rangeLabel.toUpperCase()}  |  POWERED BY ORDERFLOW`);
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
