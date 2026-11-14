import fs from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, getDocs, collection, query, where, Timestamp, serverTimestamp, deleteField, setLogLevel } from 'firebase/firestore';

// Denied writes are expected here; keep the output to the ok / FAIL lines.
setLogLevel('silent');

const RULES = fs.readFileSync(process.env.RULES_PATH || new URL('../../firestore.rules', import.meta.url), 'utf8');
const env = await initializeTestEnvironment({
  projectId: 'demo-orderflow',
  firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
});

// Start from an empty database so the suite can be re-run against an emulator that is already running.
await env.clearFirestore();

const now = Timestamp.now();
const baseOrder = (over) => ({
  customerId: 'cust1',
  customerName: 'Cara',
  items: [{ cartItemId: 'L1', itemId: 'burger', name: 'Burger', price: 10, quantity: 1, selectedModifiers: [] }],
  status: 'new',
  total: 10,
  subtotal: 10,
  type: 'pickup',
  createdAt: now,
  ...over,
});

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const user = (uid, role) => setDoc(doc(db, 'users', uid), { uid, email: `${uid}@example.com`, role, totalOrders: 1, totalSpent: 10, createdAt: now });
  await Promise.all([
    user('admin1', 'admin'),
    user('mgr1', 'manager'),
    user('staff1', 'staff'),
    user('driver1', 'driver'),
    user('cust1', 'customer'),
    user('cust2', 'customer'),
    user('cust3', 'customer'),
  ]);
  await setDoc(doc(db, 'restaurant', 'profile'), { name: 'Huddle', isAcceptingOrders: true, isCashPaymentEnabled: true, averageRating: 4.5, totalRatings: 10 });
  await setDoc(doc(db, 'categories', 'mains'), { name: 'Mains', displayOrder: 0, active: true });
  await setDoc(doc(db, 'items', 'burger'), { categoryId: 'mains', name: 'Burger', basePrice: 10, active: true, rating: 4.2, ratingCount: 3, soldCount: 5 });
  await setDoc(doc(db, 'orders', 'CARD01'), baseOrder({ paymentMethod: 'card', paymentStatus: 'paid', paymentIntentId: 'pi_1' }));
  await setDoc(doc(db, 'orders', 'PEND01'), baseOrder({ status: 'payment_pending', paymentMethod: 'card', paymentStatus: 'pending', paymentIntentId: 'pi_2' }));
  await setDoc(doc(db, 'orders', 'CASH01'), baseOrder({ type: 'delivery', deliveryAddress: '1 Main St', paymentMethod: 'cash', paymentStatus: 'pending', status: 'ready' }));
  await setDoc(doc(db, 'orders', 'CASH02'), baseOrder({ paymentMethod: 'cash', paymentStatus: 'pending' }));
  await setDoc(doc(db, 'orders', 'LEGACY'), baseOrder({ paymentStatus: 'paid', paymentIntentId: 'pi_legacy' })); // no paymentMethod field
  await setDoc(doc(db, 'orders', 'CASH03'), baseOrder({ paymentMethod: 'cash', paymentStatus: 'pending' }));
  await setDoc(doc(db, 'orders', 'CASHPAID'), baseOrder({ paymentMethod: 'cash', paymentStatus: 'paid' }));
  await setDoc(doc(db, 'orders', 'NEWDEL'), baseOrder({ type: 'delivery', deliveryAddress: '2 Main St', paymentMethod: 'card', paymentStatus: 'paid' }));
  await setDoc(doc(db, 'orders', 'PENDDEL'), baseOrder({ type: 'delivery', deliveryAddress: '3 Main St', status: 'payment_pending', paymentMethod: 'card', paymentStatus: 'pending' }));
  await setDoc(doc(db, 'orders', 'DONE01'), baseOrder({ status: 'completed', paymentMethod: 'card', paymentStatus: 'paid' }));
  await setDoc(doc(db, 'orders', 'DELIV1'), baseOrder({ type: 'delivery', deliveryAddress: '4 Main St', status: 'out_for_delivery', driverId: 'driver1', paymentMethod: 'card', paymentStatus: 'paid' }));
  await setDoc(doc(db, 'promos', 'SAVE5'), { id: 'SAVE5', discountType: 'fixed', discountValue: 5, active: true, usedCount: 0, usedBy: [], createdAt: now });
});

const as = (uid, extra = {}) => env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true, ...extra }).firestore();
const anon = env.unauthenticatedContext().firestore();
const customer = as('cust1');
const other = as('cust2');
const staff = as('staff1');
const manager = as('mgr1');
const driver = as('driver1');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err?.message?.split('\n')[0]}`);
  }
}

console.log('\nStorefront reads');
await check('anyone can read the menu and profile', async () => {
  await assertSucceeds(getDoc(doc(anon, 'restaurant', 'profile')));
  await assertSucceeds(getDoc(doc(anon, 'items', 'burger')));
  await assertSucceeds(getDocs(collection(anon, 'categories')));
});

console.log('\nOrders: customers');
// Basic mode (server without database access): unpaid cash orders only.
const directOrder = (over = {}) => {
  const { createdAt: _c, ...rest } = baseOrder({ customerId: 'cust1', status: 'new', paymentMethod: 'cash', paymentStatus: 'pending' });
  return { ...rest, createdAt: serverTimestamp(), ...over };
};
await check('customer can place an unpaid cash order directly (basic mode)', () =>
  assertSucceeds(setDoc(doc(customer, 'orders', 'NEW01'), directOrder())));
await check('customer cannot create order for someone else', () =>
  assertFails(setDoc(doc(customer, 'orders', 'HACK01'), directOrder({ customerId: 'cust2' }))));
await check('customer cannot create an order that is already paid', () =>
  assertFails(setDoc(doc(customer, 'orders', 'HACK02'), directOrder({ paymentStatus: 'paid' }))));
await check('customer cannot create a card order directly (no payment was taken)', () =>
  assertFails(setDoc(doc(customer, 'orders', 'HACK03'), directOrder({ paymentMethod: 'card', paymentStatus: 'paid', paymentIntentId: 'pi_fake' }))));
await check('customer cannot create an unpaid card checkout directly', () =>
  assertFails(setDoc(doc(customer, 'orders', 'HACK04'), directOrder({ paymentMethod: 'card', status: 'payment_pending' }))));
await check('customer cannot give themselves a discount', () =>
  assertFails(setDoc(doc(customer, 'orders', 'HACK05'), directOrder({ discountAmount: 9, promoCode: 'SAVE5', total: 1 }))));
await check('customer cannot undercut the subtotal', () =>
  assertFails(setDoc(doc(customer, 'orders', 'HACK06'), directOrder({ total: 0.01 }))));
await check('customer cannot smuggle extra fields into an order', () =>
  assertFails(setDoc(doc(customer, 'orders', 'HACK07'), directOrder({ driverId: 'cust1', rating: 5, refundAmount: 10 }))));
await check('customer cannot backdate an order', () =>
  assertFails(setDoc(doc(customer, 'orders', 'HACK08'), directOrder({ createdAt: Timestamp.fromMillis(Date.now() - 86400000) }))));
await check('customer can read own order', () => assertSucceeds(getDoc(doc(customer, 'orders', 'CARD01'))));
await check('customer cannot read someone else\'s order', () => assertFails(getDoc(doc(other, 'orders', 'CARD01'))));
await check('customer can list own orders (no composite index needed)', () =>
  assertSucceeds(getDocs(query(collection(customer, 'orders'), where('customerId', '==', 'cust1')))));
await check('customer cannot mark a pending order as paid', () =>
  assertFails(updateDoc(doc(customer, 'orders', 'PEND01'), { status: 'new', paymentStatus: 'paid', updatedAt: serverTimestamp() })));
await check('customer cannot push an unpaid card checkout to the kitchen', () =>
  assertFails(updateDoc(doc(customer, 'orders', 'PEND01'), { status: 'new', updatedAt: serverTimestamp() })));
await check('customer cannot mark their cash order as paid', () =>
  assertFails(updateDoc(doc(customer, 'orders', 'CASH03'), { paymentStatus: 'paid', paidAt: serverTimestamp() })));
await check('customer cannot change the total of their order', () =>
  assertFails(updateDoc(doc(customer, 'orders', 'CASH03'), { total: 1 })));
await check('customer cannot cancel directly (refunds happen on the server)', () =>
  assertFails(updateDoc(doc(customer, 'orders', 'CARD01'), { status: 'cancelled' })));
await check('customer cannot cancel a cash order that was already paid', () =>
  assertFails(updateDoc(doc(customer, 'orders', 'CASHPAID'), { status: 'cancelled', cancelledBy: 'customer' })));
await check('customer cannot cancel someone else\'s order', () =>
  assertFails(updateDoc(doc(other, 'orders', 'CASH03'), { status: 'cancelled', cancelledBy: 'customer' })));
await check('customer cannot pose as staff when cancelling', () =>
  assertFails(updateDoc(doc(customer, 'orders', 'CASH03'), { status: 'cancelled', cancelledBy: 'staff' })));
await check('customer can cancel an unpaid cash order before it is accepted', () =>
  assertSucceeds(updateDoc(doc(customer, 'orders', 'CASH03'), { status: 'cancelled', cancelledBy: 'customer', cancelReason: 'Changed my mind', updatedAt: serverTimestamp() })));
await check('customer can move the delivery pin on an active delivery', () =>
  assertSucceeds(updateDoc(doc(customer, 'orders', 'NEWDEL'), { deliveryLocation: { lat: 30.26, lng: -97.74, updatedAt: Date.now() }, updatedAt: serverTimestamp() })));
await check('customer cannot fake the driver position', () =>
  assertFails(updateDoc(doc(customer, 'orders', 'NEWDEL'), { driverLocation: { lat: 30.26, lng: -97.74 } })));
await check('customer can rate a completed order once', async () => {
  await assertSucceeds(updateDoc(doc(customer, 'orders', 'DONE01'), { rating: 5, ratingComment: 'Great', ratedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(customer, 'orders', 'DONE01'), { rating: 1 }));
});
await check('customer cannot rate an order that is not finished', () =>
  assertFails(updateDoc(doc(customer, 'orders', 'CARD01'), { rating: 5 })));

console.log('\nOrders: staff');
await check('staff can move an order through the kitchen', () =>
  assertSucceeds(updateDoc(doc(staff, 'orders', 'CARD01'), { status: 'confirmed', updatedAt: serverTimestamp() })));
await check('staff cannot change the order total', () =>
  assertFails(updateDoc(doc(staff, 'orders', 'CARD01'), { total: 1 })));
await check('staff cannot change items', () =>
  assertFails(updateDoc(doc(staff, 'orders', 'CARD01'), { items: [{ itemId: 'x', name: 'x', price: 0, quantity: 1 }] })));
await check('staff cannot cancel a paid card order without a refund', () =>
  assertFails(updateDoc(doc(staff, 'orders', 'CARD01'), { status: 'cancelled' })));
await check('staff cannot mark a card order as paid / refunded', () =>
  assertFails(updateDoc(doc(staff, 'orders', 'PEND01'), { paymentStatus: 'paid' })));
await check('staff can record a cash payment', () =>
  assertSucceeds(updateDoc(doc(staff, 'orders', 'CASH02'), { paymentStatus: 'paid', paidAt: serverTimestamp(), paymentCollectedBy: 'Sam' })));
await check('staff can undo a mistaken cash payment', () =>
  assertSucceeds(updateDoc(doc(staff, 'orders', 'CASH02'), { paymentStatus: 'pending', paidAt: deleteField(), paymentCollectedBy: deleteField() })));
await check('staff cannot mark cash orders as refunded', () =>
  assertFails(updateDoc(doc(staff, 'orders', 'CASH02'), { paymentStatus: 'refunded' })));
await check('staff can cancel an unpaid cash order', () =>
  assertSucceeds(updateDoc(doc(staff, 'orders', 'CASH02'), { status: 'cancelled', cancelledBy: 'staff' })));
await check('cancelled orders cannot be revived', () =>
  assertFails(updateDoc(doc(staff, 'orders', 'CASH02'), { status: 'new' })));
await check('staff cannot cancel paid legacy orders (no paymentMethod field)', () =>
  assertFails(updateDoc(doc(staff, 'orders', 'LEGACY'), { status: 'cancelled' })));
await check('staff can still progress legacy orders', () =>
  assertSucceeds(updateDoc(doc(staff, 'orders', 'LEGACY'), { status: 'preparing' })));

console.log('\nOrders: drivers');
await check('driver can list delivery orders', () =>
  assertSucceeds(getDocs(query(collection(driver, 'orders'), where('type', '==', 'delivery'), where('status', 'in', ['ready', 'preparing'])))));
await check('driver cannot read pickup orders', () => assertFails(getDoc(doc(driver, 'orders', 'CARD01'))));
await check('driver can claim a delivery', () =>
  assertSucceeds(updateDoc(doc(driver, 'orders', 'CASH01'), { driverId: 'driver1', driverName: 'Dee', deliveryStatus: 'assigned', updatedAt: serverTimestamp() })));
await check('driver can record cash collected', () =>
  assertSucceeds(updateDoc(doc(driver, 'orders', 'CASH01'), { paymentStatus: 'paid', paidAt: serverTimestamp(), paymentCollectedBy: 'Dee' })));
await check('driver cannot change the total', () => assertFails(updateDoc(doc(driver, 'orders', 'CASH01'), { total: 0 })));
await check('driver cannot cancel orders', () => assertFails(updateDoc(doc(driver, 'orders', 'CASH01'), { status: 'cancelled' })));
await check('driver cannot pull an order the kitchen has not started', () =>
  assertFails(updateDoc(doc(driver, 'orders', 'NEWDEL'), { status: 'preparing', driverId: 'driver1', driverName: 'Dee' })));
await check('driver cannot push an unpaid checkout to the kitchen', () =>
  assertFails(updateDoc(doc(driver, 'orders', 'PENDDEL'), { status: 'preparing', driverId: 'driver1', driverName: 'Dee' })));
await check('driver can share live GPS on their delivery', () =>
  assertSucceeds(updateDoc(doc(driver, 'orders', 'DELIV1'), { driverLocation: { lat: 30.27, lng: -97.74, accuracy: 12, heading: null, speed: 4.2, updatedAt: Date.now() } })));
await check('another driver cannot take over a claimed delivery', () =>
  assertFails(updateDoc(doc(as('driver2'), 'orders', 'DELIV1'), { driverId: 'driver2', driverName: 'Eve' })));
await check('driver can complete with a large proof-of-delivery photo', () =>
  assertSucceeds(updateDoc(doc(driver, 'orders', 'CASH01'), {
    status: 'completed', deliveryStatus: 'delivered', proofOfDeliveryImage: 'data:image/jpeg;base64,' + 'A'.repeat(400000), updatedAt: serverTimestamp(),
  })));

await check('driver cannot reopen a completed delivery', () =>
  assertFails(updateDoc(doc(driver, 'orders', 'CASH01'), { status: 'out_for_delivery' })));

console.log('\nProof of delivery photos');
const photo = 'data:image/webp;base64,' + 'A'.repeat(2000);
await check('assigned driver can save a proof photo', () =>
  assertSucceeds(setDoc(doc(driver, 'orders', 'DELIV1', 'proof', 'photo'), { image: photo, driverId: 'driver1', driverName: 'Dee', createdAt: serverTimestamp() })));
await check('a driver cannot attach photos to deliveries that are not theirs', () =>
  assertFails(setDoc(doc(as('driver2'), 'orders', 'DELIV1', 'proof', 'photo'), { image: photo, driverId: 'driver2' })));
await check('customers cannot upload proof photos', () =>
  assertFails(setDoc(doc(customer, 'orders', 'DELIV1', 'proof', 'photo'), { image: photo })));
await check('proof must be an image', () =>
  assertFails(setDoc(doc(driver, 'orders', 'DELIV1', 'proof', 'photo'), { image: 'javascript:alert(1)' })));
await check('the customer and staff can see the proof photo', async () => {
  await assertSucceeds(getDoc(doc(customer, 'orders', 'DELIV1', 'proof', 'photo')));
  await assertSucceeds(getDoc(doc(staff, 'orders', 'DELIV1', 'proof', 'photo')));
});
await check('other customers cannot see the proof photo', () =>
  assertFails(getDoc(doc(other, 'orders', 'DELIV1', 'proof', 'photo'))));

console.log('\nOrders: payment bypass attempts');
await check('staff cannot push an unpaid checkout to the kitchen', () =>
  assertFails(updateDoc(doc(staff, 'orders', 'PEND01'), { status: 'new' })));
await check('staff cannot add unexpected fields (allowlist)', () =>
  assertFails(updateDoc(doc(staff, 'orders', 'CARD01'), { notes: 'free food please' })));
await check('staff can clean up an abandoned checkout', () =>
  assertSucceeds(updateDoc(doc(staff, 'orders', 'PEND01'), { status: 'cancelled', cancelledBy: 'staff' })));

console.log('\nUsers');
await check('self sign-up as customer with zeroed stats', () =>
  assertSucceeds(setDoc(doc(as('newbie'), 'users', 'newbie'), { uid: 'newbie', email: 'newbie@example.com', role: 'customer', name: 'New', totalOrders: 0, totalSpent: 0, createdAt: serverTimestamp() })));
await check('self sign-up cannot start with fake spend', () =>
  assertFails(setDoc(doc(as('faker'), 'users', 'faker'), { uid: 'faker', email: 'faker@example.com', role: 'customer', totalOrders: 0, totalSpent: 5000 })));
await check('self sign-up cannot be admin', () =>
  assertFails(setDoc(doc(as('sneaky'), 'users', 'sneaky'), { uid: 'sneaky', email: 'sneaky@example.com', role: 'admin' })));
await check('customer can edit name, phone and addresses', () =>
  assertSucceeds(updateDoc(doc(customer, 'users', 'cust1'), { name: 'Cara B', phone: '555-123-4567', savedAddresses: ['1 Main St'] })));
await check('customer cannot inflate totalSpent (promo segmentation)', () =>
  assertFails(updateDoc(doc(customer, 'users', 'cust1'), { totalSpent: 99999 })));
await check('customer cannot give themselves loyalty points', () =>
  assertFails(updateDoc(doc(customer, 'users', 'cust1'), { loyaltyPoints: 500 })));
await check('customer cannot change their role', () => assertFails(updateDoc(doc(customer, 'users', 'cust1'), { role: 'manager' })));
await check('customer cannot read other users', () => assertFails(getDoc(doc(customer, 'users', 'cust2'))));
await check('manager can promote a customer to staff', () => assertSucceeds(updateDoc(doc(manager, 'users', 'cust2'), { role: 'staff' })));
await check('manager cannot create an admin', () => assertFails(updateDoc(doc(manager, 'users', 'cust2'), { role: 'admin' })));

console.log('\nTeam invitations');
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'users', 'invite_newcook@example.com'), { uid: 'invite_newcook@example.com', email: 'newcook@example.com', role: 'staff', name: 'New Cook' });
  await setDoc(doc(db, 'users', 'invite_cust3@example.com'), { uid: 'invite_cust3@example.com', email: 'cust3@example.com', role: 'driver' });
});
const invited = as('cookuid', { email: 'newcook@example.com' });
const unverified = env.authenticatedContext('fakeuid', { email: 'newcook@example.com', email_verified: false }).firestore();
await check('manager can invite a team member by email', () =>
  assertSucceeds(setDoc(doc(manager, 'users', 'invite_driver9@example.com'), { uid: 'invite_driver9@example.com', email: 'driver9@example.com', role: 'driver', name: 'Nine' })));
await check('manager cannot invite an admin', () =>
  assertFails(setDoc(doc(manager, 'users', 'invite_boss@example.com'), { uid: 'invite_boss@example.com', email: 'boss@example.com', role: 'admin' })));
await check('customers cannot invite themselves', () =>
  assertFails(setDoc(doc(customer, 'users', 'invite_cust1@example.com'), { uid: 'invite_cust1@example.com', email: 'cust1@example.com', role: 'manager' })));
await check('an unverified email cannot read or claim an invite', async () => {
  await assertFails(getDoc(doc(unverified, 'users', 'invite_newcook@example.com')));
  await assertFails(setDoc(doc(unverified, 'users', 'fakeuid'), { uid: 'fakeuid', email: 'newcook@example.com', role: 'staff', totalOrders: 0, totalSpent: 0 }));
});
await check('invited person can read their invite and sign up with the invited role', async () => {
  await assertSucceeds(getDoc(doc(invited, 'users', 'invite_newcook@example.com')));
  await assertSucceeds(setDoc(doc(invited, 'users', 'cookuid'), { uid: 'cookuid', email: 'newcook@example.com', role: 'staff', name: 'New Cook', totalOrders: 0, totalSpent: 0, createdAt: serverTimestamp() }));
});
await check('invited person cannot take a higher role than invited', () =>
  assertFails(setDoc(doc(as('x1', { email: 'driver9@example.com' }), 'users', 'x1'), { uid: 'x1', email: 'driver9@example.com', role: 'manager', totalOrders: 0, totalSpent: 0 })));
await check('existing customer can claim an invited role, nothing more', async () => {
  await assertFails(updateDoc(doc(as('cust3'), 'users', 'cust3'), { role: 'manager' }));
  await assertSucceeds(updateDoc(doc(as('cust3'), 'users', 'cust3'), { role: 'driver' }));
});
await check('a person without an invite stays a customer', () =>
  assertFails(updateDoc(doc(customer, 'users', 'cust1'), { role: 'staff' })));

console.log('\nRestaurant profile');
await check('staff can pause ordering', () =>
  assertSucceeds(updateDoc(doc(staff, 'restaurant', 'profile'), { pausedUntil: Timestamp.fromMillis(Date.now() + 900000), estimatedPrepMinutes: 35 })));
await check('staff cannot change store settings', () => assertFails(updateDoc(doc(staff, 'restaurant', 'profile'), { name: 'Hacked' })));
await check('manager can update settings and theme', () =>
  assertSucceeds(updateDoc(doc(manager, 'restaurant', 'profile'), { name: 'Huddle Snack Stop', theme: { preset: 'midnight' }, taxRate: 8.25 })));
await check('manager cannot fake the average rating', () => assertFails(updateDoc(doc(manager, 'restaurant', 'profile'), { averageRating: 5 })));
await check('tax rate must be sane', () => assertFails(updateDoc(doc(manager, 'restaurant', 'profile'), { taxRate: 80 })));
await check('customers cannot change the profile', () => assertFails(updateDoc(doc(customer, 'restaurant', 'profile'), { isAcceptingOrders: false })));
await check('manager can save a fully filled-in settings document (stays inside the rules evaluation limit)', () =>
  assertSucceeds(updateDoc(doc(manager, 'restaurant', 'profile'), {
    name: 'Huddle Snack Stop', description: 'Burgers', address: '408 Congress Ave', phone: '(512) 555-0194', email: 'orders@example.com',
    deliveryFee: 3.99, freeDeliveryThreshold: 30, minimumOrder: 10, serviceFeePercent: 5, taxRate: 8.25, promotionalZeroFee: false,
    isDeliveryEnabled: true, isPickupEnabled: true, isSchedulePickupEnabled: true, isCardPaymentEnabled: true, isCashPaymentEnabled: true, isTippingEnabled: true,
    scheduleDaysAhead: 7, estimatedPrepMinutes: 20, timezone: 'America/Chicago', logoUrl: 'data:image/webp;base64,AAAA', bannerUrl: 'https://example.com/b.jpg',
    businessHours: { Monday: { open: '09:00', close: '17:00', closed: false } }, isMarqueeEnabled: true, marqueeText: 'FREE DELIVERY', marqueeImageUrl: '',
    marqueeImageUrls: [], isGalleryEnabled: false, galleryImageUrls: [], theme: { preset: 'forest' }, social: { instagram: 'https://instagram.com/x' },
    location: { lat: 30.2672, lng: -97.7431, label: 'Trailer' }, starterMenuCleared: true,
  })));
await check('settings reject unknown fields and wrong types', async () => {
  await assertFails(updateDoc(doc(manager, 'restaurant', 'profile'), { hacked: true }));
  await assertFails(updateDoc(doc(manager, 'restaurant', 'profile'), { deliveryFee: 'free' }));
  await assertFails(updateDoc(doc(manager, 'restaurant', 'profile'), { isCashPaymentEnabled: 'yes' }));
  await assertFails(updateDoc(doc(manager, 'restaurant', 'profile'), { location: { lat: 500, lng: 0 } }));
  await assertFails(updateDoc(doc(manager, 'restaurant', 'profile'), { description: 'x'.repeat(1001) }));
});

console.log('\nBasic mode follows the store settings');
await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'restaurant', 'profile'), { isCashPaymentEnabled: false }));
await check('no direct cash orders when the owner turned cash off', () =>
  assertFails(setDoc(doc(customer, 'orders', 'NEW02'), directOrder())));
await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'restaurant', 'profile'), { isCashPaymentEnabled: true, isAcceptingOrders: false }));
await check('no direct orders while ordering is switched off', () =>
  assertFails(setDoc(doc(customer, 'orders', 'NEW03'), directOrder())));
await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'restaurant', 'profile'), { isAcceptingOrders: true }));

console.log('\nMenu');
await check('staff can mark an item sold out', () => assertSucceeds(updateDoc(doc(staff, 'items', 'burger'), { isSoldOut: true })));
await check('staff cannot change prices', () => assertFails(updateDoc(doc(staff, 'items', 'burger'), { basePrice: 1 })));
await check('manager can edit an item', () => assertSucceeds(updateDoc(doc(manager, 'items', 'burger'), { basePrice: 11.5, isFeatured: true })));
await check('manager cannot fake item ratings', () => assertFails(updateDoc(doc(manager, 'items', 'burger'), { rating: 5 })));
await check('manager cannot create items with fake sales', () =>
  assertFails(setDoc(doc(manager, 'items', 'fries'), { categoryId: 'mains', name: 'Fries', basePrice: 3, active: true, ratingCount: 50 })));
await check('customers cannot edit the menu', () => assertFails(updateDoc(doc(customer, 'items', 'burger'), { basePrice: 0 })));

console.log('\nPromos');
await check('signed-in customers can read promos', () => assertSucceeds(getDoc(doc(customer, 'promos', 'SAVE5'))));
await check('customers cannot mark promos as used', () =>
  assertFails(updateDoc(doc(customer, 'promos', 'SAVE5'), { usedCount: 1, usedBy: ['cust1'] })));
await check('customers cannot reset their own promo usage', () =>
  assertFails(updateDoc(doc(customer, 'promos', 'SAVE5'), { usedBy: [] })));
await check('customers cannot exhaust a promo for everyone', () =>
  assertFails(updateDoc(doc(customer, 'promos', 'SAVE5'), { usedCount: 100000 })));
await check('manager can create a promo', () =>
  assertSucceeds(setDoc(doc(manager, 'promos', 'TEN'), { id: 'TEN', discountType: 'percentage', discountValue: 10, active: true, usedCount: 0, usedBy: [], minSubtotal: 20, createdAt: serverTimestamp() })));
await check('percentage promos cannot exceed 100%', () =>
  assertFails(setDoc(doc(manager, 'promos', 'BIG'), { id: 'BIG', discountType: 'percentage', discountValue: 150, active: true, usedCount: 0, usedBy: [], createdAt: serverTimestamp() })));
await check('promo id must match the document id', () =>
  assertFails(setDoc(doc(manager, 'promos', 'AAA'), { id: 'BBB', discountType: 'fixed', discountValue: 5, active: true, usedCount: 0, usedBy: [], createdAt: serverTimestamp() })));

await env.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
