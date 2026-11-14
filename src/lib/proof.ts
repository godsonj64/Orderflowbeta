/**
 * Proof-of-delivery photos.
 *
 * Photos are stored in their own document (orders/{orderId}/proof/photo) instead of
 * inside the order. Order lists (dashboards, "My orders") are loaded and kept live on
 * phones; a 100+ KB photo inside every delivered order made those lists many megabytes.
 * Older orders that still carry the photo inline (order.proofOfDeliveryImage) keep working.
 */
import { doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';

const proofRef = (orderId: string) => doc(db, 'orders', orderId, 'proof', 'photo');

export async function saveProofPhoto(orderId: string, image: string, driver: { uid: string; name: string }): Promise<void> {
  try {
    await setDoc(proofRef(orderId), { image, driverId: driver.uid, driverName: driver.name, createdAt: serverTimestamp() });
  } catch (err) {
    // Security rules that predate the photo sub-collection reject the write above;
    // fall back to the previous storage location so the photo is never lost.
    if ((err as { code?: string })?.code !== 'permission-denied') throw err;
    await updateDoc(doc(db, 'orders', orderId), { proofOfDeliveryImage: image });
  }
}

/** Live photo for an order (null while there is none / it is not readable). Returns the unsubscribe function. */
export function watchProofPhoto(orderId: string, onChange: (image: string | null) => void): () => void {
  return onSnapshot(
    proofRef(orderId),
    (snap) => {
      const image = snap.exists() ? snap.get('image') : null;
      onChange(typeof image === 'string' && image.startsWith('data:image/') ? image : null);
    },
    () => onChange(null),
  );
}
