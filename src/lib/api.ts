/** Small client for the app's own server API (server.ts). Attaches the Firebase ID token. */
import { auth } from '../firebase';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: any = null,
  ) {
    super(message);
  }
}

/** Phones on weak connections can leave a request hanging forever; give up and let the user retry. */
const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = await auth.currentUser?.getIdToken().catch(() => null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  let data: any = null;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    try {
      data = await res.json();
    } catch (err) {
      if (controller.signal.aborted) throw err;
      // Non-JSON response (e.g. the dev server is restarting).
    }
  } catch {
    throw new ApiError(
      controller.signal.aborted
        ? 'The server is taking too long to answer. Check your connection and try again.'
        : "Can't reach the server. Check your connection and try again.",
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status}). Please try again.`, res.status, data);
  }
  return data as T;
}

/** The server answered, but it has no database access (see "basic mode" in SETUP.md). */
export function isNoDatabaseError(err: unknown): boolean {
  return err instanceof ApiError && err.data?.code === 'SERVER_NO_DATABASE';
}

/** The request may or may not have reached the server (offline, timeout): safe to retry, not to assume failure. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 0;
}

export const apiGet = <T>(path: string) => request<T>('GET', path);
export const apiPost = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

import type { OrderTotals, ModifierSelection, TipChoice } from './pricing';
import type { GeoPoint, OrderStatus, OrderType, PaymentMethod, PaymentStatus } from '../types';

export interface CheckoutRequest {
  items: { itemId: string; quantity: number; selections: ModifierSelection[]; notes?: string }[];
  orderType: OrderType;
  paymentMethod: PaymentMethod;
  customerName: string;
  customerPhone: string;
  deliveryAddress?: string;
  deliveryLocation?: GeoPoint | null;
  notes?: string;
  scheduledFor?: string | null;
  promoCode?: string | null;
  tip?: { restaurant?: TipChoice; delivery?: TipChoice };
  expectedTotalCents?: number;
  replacesOrderId?: string | null;
  /** Same key = same order: lets a retry after a lost response return the existing order. */
  checkoutKey?: string;
}

export interface CheckoutResponse {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  totals: OrderTotals;
  clientSecret: string | null;
  /** True when this answers a repeated request for an order that already existed. */
  duplicate?: boolean;
}

/** "server": orders are priced and created by the server. "direct": basic mode (cash only, see SETUP.md). */
export type OrderingMode = 'server' | 'direct';

export interface PaymentStateResponse {
  paid: boolean;
  status: OrderStatus;
  paymentStatus?: PaymentStatus;
  stripeStatus?: string;
  processing?: boolean;
}

export const api = {
  config: () => apiGet<{ cardPayments: boolean; ordering?: OrderingMode }>('/api/config'),
  health: () =>
    apiGet<{ status: string; firestore: 'ok' | 'error'; ordering?: OrderingMode; cardPayments: boolean; webhooks: boolean }>('/api/health'),
  checkout: (body: CheckoutRequest) => apiPost<CheckoutResponse>('/api/checkout', body),
  confirmPayment: (orderId: string) => apiPost<PaymentStateResponse>(`/api/orders/${encodeURIComponent(orderId)}/confirm-payment`),
  abandon: (orderId: string) => apiPost<PaymentStateResponse>(`/api/orders/${encodeURIComponent(orderId)}/abandon`),
  cancel: (orderId: string, reason?: string) =>
    apiPost<{ status: OrderStatus; refunded?: boolean; paymentStatus?: PaymentStatus }>(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { reason }),
  refund: (orderId: string, amount?: number, reason?: string) =>
    apiPost<{ refundAmount: number; paymentStatus: PaymentStatus; status: OrderStatus }>(`/api/orders/${encodeURIComponent(orderId)}/refund`, { amount, reason }),
  rate: (orderId: string, rating: number, comment?: string) =>
    apiPost<{ ok: true }>(`/api/orders/${encodeURIComponent(orderId)}/rate`, { rating, comment }),
};
