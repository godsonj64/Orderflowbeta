import toast from 'react-hot-toast';
import { auth } from '../firebase';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

/** Turns Firestore / network errors into messages a restaurant owner or customer can act on. */
export function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const err = error as { code?: string; message?: string } | null;
  const code = err?.code || '';
  const message = err?.message || '';
  if (/maximum allowed size|exceeds the maximum/i.test(message)) {
    return 'This is too large to save. Try fewer or smaller images.';
  }
  switch (code) {
    case 'permission-denied':
      return "You don't have permission to do that.";
    case 'unavailable':
      return 'You appear to be offline. Please check your connection.';
    case 'not-found':
      return 'That record no longer exists.';
    case 'failed-precondition':
      return 'This action is not allowed right now.';
    case 'resource-exhausted':
      return 'Too many requests. Please try again shortly.';
    case 'invalid-argument':
      return 'Some of the data is invalid. Please check your input.';
    case 'unauthenticated':
      return 'Please sign in again.';
  }
  return message && message.length < 200 && !message.startsWith('{') ? message : fallback;
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

function buildFirestoreErrorInfo(error: unknown, operationType: OperationType, path: string | null): FirestoreErrorInfo {
  return {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
}

/**
 * Logs an error with context and (by default) shows a toast. Unlike
 * handleFirestoreError it never throws, so it is safe inside onSnapshot callbacks,
 * where a throw would escape as an uncaught error and leave loading spinners forever.
 */
export function reportError(
  error: unknown,
  context: string,
  options: { toast?: boolean; message?: string; operationType?: OperationType; path?: string | null } = {},
) {
  const { toast: showToast = true, message, operationType = OperationType.GET, path = context } = options;
  const info = buildFirestoreErrorInfo(error, operationType, path);
  console.error(`[${context}]`, JSON.stringify(info));
  if (showToast) toast.error(message || friendlyError(error), { id: `err-${context}` });
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo = buildFirestoreErrorInfo(error, operationType, path);
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
