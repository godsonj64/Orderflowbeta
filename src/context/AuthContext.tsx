import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getRedirectResult,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { deleteDoc, doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { isManagerRole, isStaffRole, type UserProfile, type UserRole } from '../types';
import { reportError } from '../utils/errorHandling';

/** Mirrors the bootstrap admin in firestore.rules. */
export const BOOTSTRAP_ADMIN_EMAILS = new Set(['godsonj64@gmail.com', 'godsonchristy25@gmail.com']);

/** Deterministic Firestore doc ID in `users` for a pre-authorized team member invite. */
export function emailInviteDocId(email: string): string {
  return `invite_${email.trim().toLowerCase()}`;
}

interface AuthContextType {
  user: User | null;
  userProfile: UserProfile | null;
  /** Effective role (the bootstrap admin is always "admin"). */
  role: UserRole | null;
  isStaff: boolean;
  isManager: boolean;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, pass: string) => Promise<void>;
  signUpWithEmail: (email: string, pass: string, name: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updateContactInfo: (data: Partial<Pick<UserProfile, 'name' | 'phone' | 'savedAddresses'>>) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};

const AUTH_ERRORS: Record<string, string> = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'No account found with this email.',
  'auth/email-already-in-use': 'An account with this email already exists. Try signing in instead.',
  'auth/weak-password': 'Please use a password with at least 6 characters.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/missing-password': 'Please enter your password.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network error. Check your connection and try again.',
  'auth/operation-not-allowed': 'This sign-in method is not enabled for this store.',
  'auth/unauthorized-domain': 'Sign-in is not enabled for this website address yet. (Owner: add this domain in Firebase Authentication → Settings → Authorized domains.)',
  'auth/user-disabled': 'This account has been disabled.',
};

export function authErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code || '';
  if (code === 'auth/unauthorized-domain' && typeof window !== 'undefined' && window.location?.hostname) {
    return `Google sign-in is not enabled for "${window.location.hostname}" yet. Add "${window.location.hostname}" in Firebase Console → Authentication → Settings → Authorized domains.`;
  }
  return AUTH_ERRORS[code] || 'Something went wrong. Please try again.';
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const pendingName = useRef<string>('');
  const creatingFor = useRef<string | null>(null);

  useEffect(() => {
    // Surface errors from a redirect-based Google sign-in (used when popups are blocked).
    getRedirectResult(auth).catch((err) => reportError(err, 'auth-redirect', { message: authErrorMessage(err) }));

    let unsubProfile: (() => void) | null = null;
    const unsubAuth = onAuthStateChanged(auth, (currentUser) => {
      unsubProfile?.();
      unsubProfile = null;
      setUser(currentUser);

      if (!currentUser) {
        setUserProfile(null);
        setLoading(false);
        return;
      }

      const ref = doc(db, 'users', currentUser.uid);
      unsubProfile = onSnapshot(
        ref,
        (snap) => {
          const fromCache = snap.metadata.fromCache;
          if (snap.exists()) {
            const data = snap.data() as UserProfile;
            const emailLower = (currentUser.email || data.email || '').toLowerCase();
            const isBootstrapAdmin = BOOTSTRAP_ADMIN_EMAILS.has(emailLower);
            if (isBootstrapAdmin && data.role !== 'admin') {
              updateDoc(ref, { role: 'admin' }).catch(() => undefined);
              setUserProfile({ ...data, role: 'admin' });
              setLoading(false);
              return;
            }
            setUserProfile(data);
            setLoading(false);

            // Check if an admin pre-authorized a team role for this user's email
            if (emailLower && data.role === 'customer' && !fromCache) {
              const inviteRef = doc(db, 'users', emailInviteDocId(emailLower));
              getDoc(inviteRef)
                .then(async (inviteSnap) => {
                  if (!inviteSnap.exists()) return;
                  const inviteData = inviteSnap.data() as UserProfile;
                  if (inviteData.role && inviteData.role !== 'customer') {
                    await updateDoc(ref, {
                      role: inviteData.role,
                      ...(inviteData.name && !data.name ? { name: inviteData.name } : {}),
                    });
                    await deleteDoc(inviteRef).catch(() => undefined);
                  }
                })
                .catch(() => undefined);
            }
            return;
          }
          // Only create the profile once we know (from the server) that it does not exist.
          if (fromCache || creatingFor.current === currentUser.uid) return;
          creatingFor.current = currentUser.uid;
          const emailLower = (currentUser.email || '').toLowerCase();
          const isBootstrapAdmin = BOOTSTRAP_ADMIN_EMAILS.has(emailLower);

          const bootstrapProfile = async () => {
            let assignedRole: UserRole = isBootstrapAdmin ? 'admin' : 'customer';
            let invitedName = '';
            const inviteRef = emailLower ? doc(db, 'users', emailInviteDocId(emailLower)) : null;
            if (inviteRef && !isBootstrapAdmin) {
              try {
                const inviteSnap = await getDoc(inviteRef);
                if (inviteSnap.exists()) {
                  const inviteData = inviteSnap.data() as UserProfile;
                  if (inviteData.role) assignedRole = inviteData.role;
                  if (inviteData.name) invitedName = inviteData.name;
                }
              } catch {
                // Ignore if offline or no invite exists
              }
            }
            const profile: UserProfile = {
              uid: currentUser.uid,
              email: currentUser.email || '',
              role: assignedRole,
              name: (currentUser.displayName || pendingName.current || invitedName || '').slice(0, 100),
              totalOrders: 0,
              totalSpent: 0,
            };
            try {
              await setDoc(ref, { ...profile, createdAt: serverTimestamp() });
              if (inviteRef && assignedRole !== 'customer') {
                await deleteDoc(inviteRef).catch(() => undefined);
              }
            } catch (err) {
              reportError(err, 'create-profile', { toast: false });
            } finally {
              creatingFor.current = null;
            }
            setUserProfile(profile);
            setLoading(false);
          };

          bootstrapProfile();
        },
        (err) => {
          reportError(err, 'load-profile', { toast: false });
          setUserProfile(null);
          setLoading(false);
        },
      );
    });

    return () => {
      unsubProfile?.();
      unsubAuth();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      if (error?.code === 'auth/popup-closed-by-user' || error?.code === 'auth/cancelled-popup-request') return;
      // In-app browsers (Instagram, TikTok, ...) and some mobile browsers block popups.
      if (error?.code === 'auth/popup-blocked' || error?.code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, provider);
        return;
      }
      throw error;
    }
  }, []);

  const signInWithEmail = useCallback(async (email: string, pass: string) => {
    await signInWithEmailAndPassword(auth, email.trim(), pass);
  }, []);

  const signUpWithEmail = useCallback(async (email: string, pass: string, name: string) => {
    pendingName.current = name.trim();
    const credential = await createUserWithEmailAndPassword(auth, email.trim(), pass);
    if (name.trim()) {
      await updateProfile(credential.user, { displayName: name.trim() }).catch(() => undefined);
    }
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim());
  }, []);

  const updateContactInfo = useCallback(
    async (data: Partial<Pick<UserProfile, 'name' | 'phone' | 'savedAddresses'>>) => {
      if (!user) throw new Error('Please sign in first.');
      await updateDoc(doc(db, 'users', user.uid), data);
    },
    [user],
  );

  const logout = useCallback(async () => {
    try {
      await signOut(auth);
    } catch (error) {
      reportError(error, 'logout');
    }
  }, []);

  const value = useMemo<AuthContextType>(() => {
    const isBootstrapAdmin = !!user && BOOTSTRAP_ADMIN_EMAILS.has((user.email || userProfile?.email || '').toLowerCase());
    const role: UserRole | null = isBootstrapAdmin ? 'admin' : userProfile ? userProfile.role : null;
    return {
      user,
      userProfile,
      role,
      isStaff: isStaffRole(role),
      isManager: isManagerRole(role),
      loading,
      signInWithGoogle,
      signInWithEmail,
      signUpWithEmail,
      resetPassword,
      updateContactInfo,
      logout,
    };
  }, [user, userProfile, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, resetPassword, updateContactInfo, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
