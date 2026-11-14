import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  clearIndexedDbPersistence,
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

/**
 * Firestore keeps a copy of what this device has loaded (menu, orders) in IndexedDB:
 *  - returning customers see the menu instantly instead of waiting for the network,
 *  - kitchen tablets and driver phones keep working through short connection drops
 *    (changes made offline are sent when the connection returns),
 *  - all tabs share one cache and one connection.
 * Where IndexedDB is unavailable (some private-browsing modes) the SDK falls back to
 * its in-memory cache on its own.
 */
export const db = initializeFirestore(
  app,
  {
    ignoreUndefinedProperties: true,
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  },
  firebaseConfig.firestoreDatabaseId,
);

// Opt-in for local development and automated tests against the Firebase emulators.
// (Run the server with FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST set as well.)
if (import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true') {
  connectAuthEmulator(auth, `http://${import.meta.env.VITE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`, { disableWarnings: true });
  const [host, port] = String(import.meta.env.VITE_FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  connectFirestoreEmulator(db, host, Number(port));
}

/**
 * Removes everything this browser cached from Firestore. Called on sign-out so the next
 * person using the device (a shared kitchen tablet, a borrowed phone) cannot read the
 * previous account's orders from local storage. The page must be reloaded afterwards:
 * a terminated Firestore instance cannot be used again.
 */
export async function clearLocalData(): Promise<void> {
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch {
    // Another tab still has the database open, or there is no persistent cache: nothing to clear here.
  }
}
