import type { DocumentData, QuerySnapshot } from 'firebase/firestore';
import type { Order } from '../types';

/**
 * Turns a live query snapshot into Order objects, re-using the previous object for every
 * order that did not change. Dashboards render one memoized card per order; with stable
 * objects a snapshot that touches one order re-renders one card instead of the whole
 * board - that is what keeps the kitchen display responsive during a rush.
 *
 * `cache` is owned by the caller (one Map per listener, e.g. in a ref).
 */
export function ordersFromSnapshot(snap: QuerySnapshot<DocumentData>, cache: Map<string, Order>): Order[] {
  for (const change of snap.docChanges()) {
    if (change.type === 'removed') cache.delete(change.doc.id);
    else cache.set(change.doc.id, { id: change.doc.id, ...change.doc.data() } as Order);
  }
  return snap.docs.map((d) => {
    let order = cache.get(d.id);
    if (!order) {
      order = { id: d.id, ...d.data() } as Order;
      cache.set(d.id, order);
    }
    return order;
  });
}
