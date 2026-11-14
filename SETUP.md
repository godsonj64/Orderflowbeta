# OrderFlow — setup & operations

## How ordering works

Prices are **calculated on the server**. The browser only sends item ids, quantities
and choices to `POST /api/checkout`; the server reads the menu, profile and promo
from Firestore, applies the rules in `src/lib/pricing.ts` (the same code the
storefront uses to display totals) and creates the order. Whatever the server answers
is final: a rejection (closed, sold out, promo not valid, ...) is shown to the customer.
Nothing a customer writes can mark an order as paid, apply a discount or change a
total — `firestore.rules` blocks it.

Checkout is safe to retry: every attempt carries a key, so a customer who taps
"Place order" again after a dropped connection gets the same order back instead of
sending a second ticket to the kitchen.

| Step | Card | Cash |
| --- | --- | --- |
| Checkout | Order saved as `payment_pending`, Stripe PaymentIntent created for the server-computed total | Order saved as `new`, `paymentStatus: pending` |
| Payment | Confirmed by the server with Stripe (`/api/orders/:id/confirm-payment` and the webhook) | Staff / driver taps **Mark paid (cash)** (recorded with their name and time) |
| Cancel | Customer (before the kitchen accepts) or staff; **refunded automatically** | Cancelled; staff returns cash if already paid |

Card checkouts that never report back are settled by the server on its own, every few
minutes: if the customer did pay (but closed the page), the order is sent to the kitchen;
if nobody paid within 45 minutes, the checkout and its payment are cancelled. A payment
that arrives for an already-cancelled order is refunded automatically.

### Basic mode (server without database access)

The server needs the Firebase Admin SDK to read the menu and write orders. When it has
no credentials for your project (typically a preview / development environment), the
store keeps working in **basic mode**:

- customers can place **unpaid cash orders** only (written by the browser, checked by
  `firestore.rules`: own order, status `new`, no discount, total not below the subtotal,
  and only while the store is accepting orders with cash enabled);
- card payments, promo codes, refunds, loyalty points and sales statistics are off;
- managers see a red "Basic mode" banner in the dashboard.

Give the server credentials (next section) to leave basic mode. Check
`GET /api/health`: `"ordering": "server"` means full mode, `"direct"` means basic mode.

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | server | Card payments and refunds. Without it the store can only take cash orders. |
| `VITE_STRIPE_PUBLIC_KEY` | build | Stripe publishable key for the payment form. |
| `STRIPE_WEBHOOK_SECRET` | server | Recommended. Confirms payments even if the customer closes the page, and syncs refunds made in the Stripe dashboard. Point a webhook at `https://<your-domain>/api/stripe/webhook` with `payment_intent.succeeded` and `charge.refunded`. |
| `FIREBASE_SERVICE_ACCOUNT` | server | Only needed when the server does **not** run on Google Cloud in the same project: the service-account key (the JSON itself, or base64 of it) from Firebase console → Project settings → Service accounts. Keep it secret. |
| `ADMIN_EMAILS` | server | Optional, comma separated. Bootstrap admin(s); defaults to the address in `firestore.rules`. |
| `PORT` | server | Defaults to 3000. |

The server uses the **Firebase Admin SDK** with Application Default Credentials
(automatic on Cloud Run in the same Google Cloud project) or the key in
`FIREBASE_SERVICE_ACCOUNT`. If it cannot use Firestore, `/api/health` reports
`"firestore": "error"`, the dashboard shows a red banner and the store runs in basic
mode (cash orders only) until the service account has Firestore access.

## Deploy the security rules

`firestore.rules` is part of the app: it decides who may change orders, prices,
payments, promo codes and team roles. **Deploy it every time you deploy the app**
(the current version also adds delivery-proof photos and team invitations), e.g.:

```bash
firebase deploy --only firestore:rules
```

## Owner checklist after deploying

1. **Settings → Hours**: confirm the time zone (pre-filled from your device) and save.
   Opening hours are enforced at checkout.
2. **Settings → Payments**: enable cash and/or card payments.
3. **Settings → Ordering**: delivery fee, free-delivery threshold, minimum order, tax and service fee.
4. **Settings → Appearance**: theme, colors, fonts, layout, banner, announcement bar.
5. **Menu**: add option groups (sizes, extras) and mark best sellers as *Featured*.
6. **Orders / Kitchen**: tap **Sound off** once to enable the new-order chime on that device.

## Development

```bash
npm install
npm run dev        # http://localhost:3000
npm run lint       # TypeScript
npm test           # pricing / opening-hours unit tests
npm run test:rules # Firestore security rules in the emulator (needs Java 11+)
```

Run `npm run test:rules` after every change to `firestore.rules`. Besides permissions it
guards a hard Firestore limit: a rule may evaluate at most 1,000 expressions per
request, and a request that goes over it is **denied**, even for the owner's own
managers. The suite saves a fully filled-in settings document to catch that.

### Running fully offline against the Firebase emulators

```bash
npx firebase-tools emulators:start --only firestore,auth --project imager-ai-470613
```

Then, in a second terminal:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 VITE_USE_FIREBASE_EMULATORS=true npm run dev
```
