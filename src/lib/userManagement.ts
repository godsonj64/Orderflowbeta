import { isManagerRole, type UserProfile, type UserRole } from '../types';

export const DEFAULT_BOOTSTRAP_ADMINS: ReadonlySet<string> = new Set([
  'godsonj64@gmail.com',
  'godsonchristy25@gmail.com',
]);

/** Roles the current user may grant (mirrors canUpdateRole in firestore.rules). */
export function assignableRoles(myRole: UserRole | null | undefined): UserRole[] {
  if (myRole === 'admin') return ['customer', 'driver', 'staff', 'manager', 'restaurant_owner', 'admin'];
  if (myRole === 'restaurant_owner') return ['customer', 'driver', 'staff', 'manager'];
  if (myRole === 'manager') return ['customer', 'driver', 'staff'];
  return [];
}

/**
 * Whether `actorRole` (with `actorUid`) is allowed to remove, block/unblock, or change the
 * role of `target`. Mirrors the role hierarchy in `firestore.rules` and prevents self-removal
 * or removing a bootstrap admin.
 */
export function canManageUser(
  actorRole: UserRole | null | undefined,
  actorUid: string | null | undefined,
  target: Pick<UserProfile, 'uid' | 'email' | 'role'>,
  bootstrapAdmins: ReadonlySet<string> = DEFAULT_BOOTSTRAP_ADMINS,
): boolean {
  if (!actorRole || !isManagerRole(actorRole)) return false;
  if (actorUid && target.uid === actorUid) return false;
  const emailLower = (target.email || '').trim().toLowerCase();
  if (emailLower && bootstrapAdmins.has(emailLower)) return false;
  if (actorRole === 'admin') return true;
  if (actorRole === 'restaurant_owner') {
    return ['manager', 'staff', 'driver', 'customer'].includes(target.role);
  }
  if (actorRole === 'manager') {
    return ['staff', 'driver', 'customer'].includes(target.role);
  }
  return false;
}

/**
 * Whether `actorRole` is allowed to trigger a password reset email or set a new password
 * for `target`.
 */
export function canResetUserPassword(
  actorRole: UserRole | null | undefined,
  target: Pick<UserProfile, 'uid' | 'email' | 'role'>,
  bootstrapAdmins: ReadonlySet<string> = DEFAULT_BOOTSTRAP_ADMINS,
): boolean {
  if (!actorRole || !isManagerRole(actorRole)) return false;
  const emailLower = (target.email || '').trim().toLowerCase();
  if (!emailLower || !emailLower.includes('@')) return false;
  if (bootstrapAdmins.has(emailLower)) {
    return actorRole === 'admin';
  }
  if (actorRole === 'admin') return true;
  if (actorRole === 'restaurant_owner') {
    return ['restaurant_owner', 'manager', 'staff', 'driver', 'customer'].includes(target.role);
  }
  if (actorRole === 'manager') {
    return ['manager', 'staff', 'driver', 'customer'].includes(target.role);
  }
  return false;
}

/** Validates a direct password set by an admin/manager. Returns an error string or null if valid. */
export function validateAdminPasswordInput(password: string): string | null {
  const trimmed = password.trim();
  if (!trimmed) return 'Please enter a new password.';
  if (trimmed.length < 6) return 'Password must be at least 6 characters.';
  if (trimmed.length > 128) return 'Password must be 128 characters or fewer.';
  return null;
}
