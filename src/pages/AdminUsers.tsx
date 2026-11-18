import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
   deleteField,
  doc,
  getDocs,
  getDocsFromCache,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { deleteApp, getApps, initializeApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, signOut } from 'firebase/auth';
import toast from 'react-hot-toast';
import { Ban, CheckCircle2, KeyRound, Mail, Search, ShieldAlert, Trash2, UserPlus, X } from 'lucide-react';
import { db } from '../firebase';
import firebaseConfig from '../../firebase-applet-config.json';
import type { PromoCode, UserProfile, UserRole } from '../types';
import { useAuth, authErrorMessage, BOOTSTRAP_ADMIN_EMAILS, emailInviteDocId } from '../context/AuthContext';
import { ConfirmDialog, Field, PageSpinner, Sheet, Spinner, adminInput } from '../components/ui';
import { api, isNoDatabaseError } from '../lib/api';
import { formatMoney } from '../lib/money';
import {
  assignableRoles,
  canManageUser,
  canResetUserPassword,
  validateAdminPasswordInput,
} from '../lib/userManagement';
import { friendlyError, reportError } from '../utils/errorHandling';

const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Admin',
  restaurant_owner: 'Owner',
  manager: 'Manager',
  staff: 'Kitchen staff',
  driver: 'Driver',
  customer: 'Customer',
};

const ROLE_STYLE: Record<UserRole, string> = {
  admin: 'bg-purple-50 text-purple-800 border-purple-200',
  restaurant_owner: 'bg-blue-50 text-blue-800 border-blue-200',
  manager: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  staff: 'bg-amber-50 text-amber-800 border-amber-200',
  driver: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  customer: 'bg-gray-100 text-gray-600 border-gray-200',
};

type Filter = 'all' | 'team' | 'customers' | 'blocked';

export const AdminUsers: React.FC = () => {
  const { userProfile, role, resetPassword } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [promos, setPromos] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<UserProfile | null>(null);
  const [roleChange, setRoleChange] = useState<{ user: UserProfile; role: UserRole } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', password: '', name: '', role: 'staff' as UserRole });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const assigningPromoRef = useRef<Set<string>>(new Set());

  // Password reset state inside the selected user sheet
  const [sendingResetEmail, setSendingResetEmail] = useState(false);
  const [showDirectPassword, setShowDirectPassword] = useState(false);
  const [directPassword, setDirectPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Remove / Block confirmation dialogs
  const [removeTarget, setRemoveTarget] = useState<UserProfile | null>(null);
  const [blockTarget, setBlockTarget] = useState<UserProfile | null>(null);
  const [blockReason, setBlockReason] = useState('Fraudulent / abusive activity');

  useEffect(() => {
    let cancelled = false;
    const usersCol = collection(db, 'users');
    const promosCol = collection(db, 'promos');

    const mapUsers = (docs: { id: string; data: () => unknown }[]) =>
      docs.map((d) => {
        const data = d.data() as UserProfile;
        if (BOOTSTRAP_ADMIN_EMAILS.has((data.email || '').toLowerCase()) && data.role !== 'admin') {
          if (role === 'admin') {
            updateDoc(doc(db, 'users', d.id), { role: 'admin' }).catch(() => undefined);
          }
          return { ...data, uid: data.uid || d.id, role: 'admin' as const };
        }
        return { ...data, uid: data.uid || d.id };
      });

    getDocsFromCache(usersCol)
      .then((cacheSnap) => {
        if (cancelled || cacheSnap.empty) return;
        setUsers(mapUsers(cacheSnap.docs));
        setLoading(false);
      })
      .catch(() => undefined);

    getDocs(usersCol)
      .then((snap) => {
        if (cancelled) return;
        setUsers(mapUsers(snap.docs));
        setLoading(false);
      })
      .catch(() => undefined);

    getDocsFromCache(promosCol)
      .then((cacheSnap) => {
        if (cancelled || cacheSnap.empty) return;
        setPromos(cacheSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as PromoCode));
      })
      .catch(() => undefined);

    const safetyTimer = window.setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 1800);

    const unsubUsers = onSnapshot(
      usersCol,
      { includeMetadataChanges: true },
      (snap) => {
        if (cancelled) return;
        const list = mapUsers(snap.docs);
        setUsers(list);
        if (list.length > 0 || !snap.metadata.fromCache) {
          window.clearTimeout(safetyTimer);
          setLoading(false);
        }
      },
      (err) => {
        if (cancelled) return;
        window.clearTimeout(safetyTimer);
        reportError(err, 'users');
        setLoading(false);
      },
    );
    const unsubPromos = onSnapshot(
      promosCol,
      { includeMetadataChanges: true },
      (snap) => {
        if (cancelled) return;
        setPromos(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PromoCode));
      },
      (err) => reportError(err, 'users-promos', { toast: false }),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(safetyTimer);
      unsubUsers();
      unsubPromos();
    };
  }, [role]);

  const grantable = assignableRoles(role);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter((u) => {
        if (filter === 'blocked') return !!u.disabled;
        if (filter === 'team') return u.role !== 'customer' && !u.disabled;
        if (filter === 'customers') return u.role === 'customer' && !u.disabled;
        return true;
      })
      .filter(
        (u) =>
          !q ||
          u.name?.toLowerCase().includes(q) ||
          u.email?.toLowerCase().includes(q) ||
          u.phone?.includes(q) ||
          u.role.includes(q) ||
          (u.disabled && 'blocked suspended fraud'.includes(q)),
      )
      .sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0) || (a.name || a.email).localeCompare(b.name || b.email));
  }, [users, search, filter]);

  // Keep the open sheet in sync with live data.
  const current = selected ? users.find((u) => u.uid === selected.uid) || selected : null;

  useEffect(() => {
    setShowDirectPassword(false);
    setDirectPassword('');
  }, [selected?.uid]);

  const confirmRole = async () => {
    if (!roleChange || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'users', roleChange.user.uid), { role: roleChange.role });
      toast.success(`${roleChange.user.name || roleChange.user.email} is now ${ROLE_LABEL[roleChange.role]}`);
      setRoleChange(null);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const setPromoAssignment = async (promo: PromoCode, user: UserProfile, assign: boolean) => {
    const lockKey = `${promo.id}:${user.uid}`;
    if (assigningPromoRef.current.has(lockKey)) return;
    assigningPromoRef.current.add(lockKey);
    try {
      await updateDoc(doc(db, 'promos', promo.id), { assignedTo: assign ? arrayUnion(user.uid) : arrayRemove(user.uid) });
      toast.success(assign ? `${promo.id} sent to ${user.name || user.email}` : `${promo.id} removed`);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      assigningPromoRef.current.delete(lockKey);
    }
  };

  const handleSendPasswordResetEmail = async (u: UserProfile) => {
    const email = (u.email || '').trim();
    if (!email || sendingResetEmail) return;
    setSendingResetEmail(true);
    try {
      await resetPassword(email);
      toast.success(`Password reset email sent to ${email}`, { duration: 5000 });
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/user-not-found') {
        toast.error('This person has not set a password yet (they sign in with Google or have a pending invite).');
      } else {
        toast.error(code.startsWith('auth/') ? authErrorMessage(err) : friendlyError(err, 'Could not send password reset email.'));
      }
    } finally {
      setSendingResetEmail(false);
    }
  };

  const handleSetDirectPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || savingPassword) return;
    const validationErr = validateAdminPasswordInput(directPassword);
    if (validationErr) {
      toast.error(validationErr);
      return;
    }
    setSavingPassword(true);
    try {
      await api.resetUserPassword(current.uid, {
        password: directPassword.trim(),
        email: current.email,
        role: current.role,
        name: current.name,
      });
      toast.success(`Password updated for ${current.name || current.email}`);
      setDirectPassword('');
      setShowDirectPassword(false);
    } catch (err) {
      if (isNoDatabaseError(err)) {
        // Fallback in preview / basic mode: if this is an invite or uncreated email/password user,
        // try creating their login via SecondaryApp or send a password reset email.
        try {
          await resetPassword(current.email);
          toast.success(`Sent password reset link to ${current.email} (direct password override requires server credentials).`, {
            duration: 6000,
          });
          setDirectPassword('');
          setShowDirectPassword(false);
        } catch {
          toast.error(err instanceof Error ? err.message : 'Could not update password.');
        }
      } else {
        toast.error(err instanceof Error ? err.message : friendlyError(err, 'Could not update password.'));
      }
    } finally {
      setSavingPassword(false);
    }
  };

  const handleBlockOrUnblock = async (u: UserProfile, block: boolean, reasonText?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const cleanReason = (reasonText || '').trim().slice(0, 200) || 'Account suspended by admin';
      if (block) {
        await updateDoc(doc(db, 'users', u.uid), {
          disabled: true,
          disabledReason: cleanReason,
          ...(u.role !== 'customer' && grantable.includes('customer') ? { role: 'customer' } : {}),
        });
        if (u.email) {
          await deleteDoc(doc(db, 'users', emailInviteDocId(u.email))).catch(() => undefined);
        }
      } else {
        await updateDoc(doc(db, 'users', u.uid), {
          disabled: false,
          disabledReason: deleteField(),
        });
      }
      // Best-effort server sync to disable/enable Firebase Auth user & revoke refresh tokens
      await api
        .removeUser(u.uid, {
          mode: block ? 'block' : 'unblock',
          reason: block ? cleanReason : undefined,
          email: u.email,
          role: u.role,
        })
        .catch(() => undefined);

      toast.success(block ? `Blocked ${u.name || u.email}` : `Unblocked ${u.name || u.email}`);
      setBlockTarget(null);
    } catch (err) {
      toast.error(friendlyError(err, block ? 'Could not block user.' : 'Could not unblock user.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleRemovePerson = async () => {
    if (!removeTarget || busyRef.current) return;
    const u = removeTarget;
    busyRef.current = true;
    setBusy(true);
    try {
      // 1. Delete user document from Firestore
      await deleteDoc(doc(db, 'users', u.uid));
      // 2. Also delete any pending email invite document for this email
      if (u.email && !u.uid.startsWith('invite_')) {
        await deleteDoc(doc(db, 'users', emailInviteDocId(u.email))).catch(() => undefined);
      }
      // 3. Remove user from any private promos assigned to them
      const assignedPromos = promos.filter((p) => p.assignedTo?.includes(u.uid));
      if (assignedPromos.length > 0) {
        await Promise.all(
          assignedPromos.map((p) => updateDoc(doc(db, 'promos', p.id), { assignedTo: arrayRemove(u.uid) }).catch(() => undefined)),
        );
      }
      // 4. Best-effort server call to also remove their Firebase Auth account
      await api
        .removeUser(u.uid, {
          mode: 'delete',
          email: u.email,
          role: u.role,
        })
        .catch(() => undefined);

      toast.success(`Removed ${u.name || u.email}`);
      setRemoveTarget(null);
      setSelected(null);
    } catch (err) {
      toast.error(friendlyError(err, 'Could not remove person.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = newUser.email.trim().toLowerCase();
    const name = newUser.name.trim().slice(0, 100);
    const password = newUser.password;
    if (!email || !name) return;

    setBusy(true);
    try {
      // 1. If a user with this email already exists in `users`, update their role directly.
      const existing = users.find((u) => (u.email || '').trim().toLowerCase() === email);
      if (existing) {
        await updateDoc(doc(db, 'users', existing.uid), {
          role: newUser.role,
          disabled: false,
          disabledReason: deleteField(),
          ...(name && !existing.name ? { name } : {}),
        });
        toast.success(`${name || email} is now ${ROLE_LABEL[newUser.role]}`);
        setCreating(false);
        setNewUser({ email: '', password: '', name: '', role: 'staff' });
        return;
      }

      // 2. If a password was entered, attempt to create a Firebase Email/Password account.
      //    If no password was entered OR if Email/Password sign-in is not enabled in Firebase
      //    Console (auth/operation-not-allowed), pre-authorize their email in Firestore so
      //    their role activates automatically when they sign in with Google.
      let createdUid: string | null = null;
      if (password.trim().length >= 6) {
        const app = getApps().find((a) => a.name === 'SecondaryApp') || initializeApp(firebaseConfig, 'SecondaryApp');
        const secondaryAuth = getAuth(app);
        try {
          const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
          createdUid = cred.user.uid;
        } catch (authErr) {
          const code = (authErr as { code?: string })?.code || '';
          if (code !== 'auth/operation-not-allowed' && code !== 'auth/email-already-in-use') {
            throw authErr;
          }
        } finally {
          await signOut(secondaryAuth).catch(() => undefined);
          await deleteApp(app).catch(() => undefined);
        }
      }

      const targetDocId = createdUid || emailInviteDocId(email);
      await setDoc(doc(db, 'users', targetDocId), {
        uid: targetDocId,
        email,
        name,
        role: newUser.role,
        totalOrders: 0,
        totalSpent: 0,
        createdAt: serverTimestamp(),
      });

      toast.success(
        createdUid
          ? `Account created for ${email} (${ROLE_LABEL[newUser.role]})`
          : `Added ${email} as ${ROLE_LABEL[newUser.role]}. They can sign in with Google using this email.`,
        { duration: 5000 },
      );
      setCreating(false);
      setNewUser({ email: '', password: '', name: '', role: 'staff' });
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      toast.error(code.startsWith('auth/') ? authErrorMessage(err) : friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <PageSpinner label="Loading people…" />;

  const blockedCount = users.filter((u) => !!u.disabled).length;
  const team = users.filter((u) => u.role !== 'customer' && !u.disabled).length;
  const customersCount = users.filter((u) => u.role === 'customer' && !u.disabled).length;

  const canManageCurrent = current ? canManageUser(role, userProfile?.uid, current, BOOTSTRAP_ADMIN_EMAILS) : false;
  const canResetCurrentPassword = current ? canResetUserPassword(role, current, BOOTSTRAP_ADMIN_EMAILS) : false;

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-ink">People</h1>
          <p className="text-xs sm:text-sm text-muted tabular-nums mt-0.5">
            {customersCount} customers · {team} team members{blockedCount > 0 ? ` · ${blockedCount} blocked` : ''}
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="min-h-[38px] px-3.5 py-1.5 rounded-btn bg-brand hover:opacity-95 text-on-brand font-bold text-xs sm:text-sm shadow-xs flex items-center gap-1.5 whitespace-nowrap shrink-0 transition"
        >
          <UserPlus size={16} /> Add team member
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-2.5 sm:items-center">
        <div className="flex items-center gap-1 p-1 bg-white border border-line shadow-2xs rounded-btn self-start overflow-x-auto max-w-full">
          {(['all', 'team', 'customers', 'blocked'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`min-h-[34px] px-3.5 py-1.5 rounded-btn text-xs sm:text-sm font-bold capitalize transition whitespace-nowrap flex items-center gap-1.5 ${
                filter === f ? 'bg-brand text-on-brand shadow-xs' : 'text-muted hover:text-ink'
              }`}
            >
              {f}
              {f === 'blocked' && blockedCount > 0 && (
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono tabular-nums ${
                    filter === 'blocked' ? 'bg-white/20 text-white' : 'bg-red-100 text-red-700'
                  }`}
                >
                  {blockedCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:w-72">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, phone…" className={`${adminInput} pl-9`} />
        </div>
      </div>

      <ul className="bg-white rounded-card border border-line shadow-ios-sm divide-y divide-line overflow-hidden">
        {visible.map((u) => (
          <li key={u.uid}>
            <button
              onClick={() => setSelected(u)}
              className={`w-full min-h-[60px] flex items-center gap-3 px-4 py-3 text-left hover:bg-soft/70 transition ${
                u.disabled ? 'bg-red-50/30' : ''
              }`}
            >
              <span
                className={`w-10 h-10 rounded-full border flex items-center justify-center font-display font-extrabold text-sm shrink-0 ${
                  u.disabled
                    ? 'bg-red-50 border-red-200 text-red-700'
                    : 'bg-accent border-brand/20 text-brand'
                }`}
              >
                {(u.name || u.email).charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 flex-wrap">
                  <span className={`font-semibold text-sm sm:text-base truncate ${u.disabled ? 'line-through text-muted' : 'text-ink'}`}>
                    {u.name || u.email}
                  </span>
                  <span className={`shrink-0 px-2 py-0.5 rounded-md border text-[10px] font-bold uppercase ${ROLE_STYLE[u.role]}`}>
                    {ROLE_LABEL[u.role]}
                  </span>
                  {u.disabled && (
                    <span className="shrink-0 px-2 py-0.5 rounded-md border bg-red-50 text-red-700 border-red-200 text-[10px] font-bold uppercase">
                      Blocked
                    </span>
                  )}
                  {u.uid.startsWith('invite_') && (
                    <span className="shrink-0 text-[11px] font-medium text-muted">· Invited</span>
                  )}
                </span>
                <span className="block text-xs text-muted truncate mt-0.5">
                  {u.email}
                  {u.disabled && u.disabledReason ? ` · ${u.disabledReason}` : ''}
                </span>
              </span>
              {u.role === 'customer' && (
                <span className="text-right text-xs text-muted shrink-0 tabular-nums">
                  <span className="block font-display font-bold text-ink">{formatMoney(u.totalSpent || 0)}</span>
                  <span>{u.totalOrders || 0} orders</span>
                </span>
              )}
            </button>
          </li>
        ))}
        {visible.length === 0 && <li className="p-8 text-center text-sm text-muted">No one matches that search.</li>}
      </ul>

      <Sheet open={!!current} onClose={() => setSelected(null)} surface="admin" size="sm" title={current?.name || current?.email}>
        {current && (
          <div className="p-5 space-y-5">
            {current.disabled && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-3.5 flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <ShieldAlert size={18} className="text-red-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-red-900 min-w-0">
                    <p className="font-bold text-red-800">Account is blocked</p>
                    <p className="mt-0.5 text-red-700 break-words">
                      {current.disabledReason || 'Suspended by admin — cannot place orders or access staff views.'}
                    </p>
                  </div>
                </div>
                {canManageCurrent && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleBlockOrUnblock(current, false)}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-white border border-red-200 text-red-700 hover:bg-red-100 text-xs font-bold transition"
                  >
                    Unblock
                  </button>
                )}
              </div>
            )}

            <div className="text-sm space-y-1 text-gray-600">
              <p className="font-medium text-gray-900">{current.email}</p>
              {current.phone && (
                <a href={`tel:${current.phone}`} className="inline-block text-gray-600 hover:text-gray-900 underline underline-offset-2 tabular-nums">
                  {current.phone}
                </a>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ['Orders', String(current.totalOrders || 0)],
                ['Spent', formatMoney(current.totalSpent || 0)],
                ['Points', String(current.loyaltyPoints || 0)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-gray-50 border border-gray-100 p-3">
                  <p className="font-extrabold font-mono tabular-nums text-gray-900">{value}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            {current.uid !== userProfile?.uid && grantable.length > 0 && (
              <Field label="Role">
                <select
                  value={current.role}
                  disabled={!grantable.includes(current.role) || !canManageCurrent}
                  onChange={(e) => setRoleChange({ user: current, role: e.target.value as UserRole })}
                  className={adminInput}
                >
                  {(grantable.includes(current.role) ? grantable : [current.role]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {/* Admin Password Reset Tool */}
            {canResetCurrentPassword && (
              <div className="space-y-2.5 pt-1 border-t border-gray-100">
                <p className="text-sm font-semibold text-gray-900">Password & sign-in</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={sendingResetEmail || busy}
                    onClick={() => handleSendPasswordResetEmail(current)}
                    className="py-2.5 px-3 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 text-xs font-bold text-gray-800 flex items-center justify-center gap-1.5 transition disabled:opacity-50"
                  >
                    {sendingResetEmail ? <Spinner size={14} /> : <Mail size={14} className="text-brand" />}
                    Send reset email
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setShowDirectPassword((v) => !v)}
                    className={`py-2.5 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                      showDirectPassword
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-gray-200 bg-white hover:bg-gray-50 text-gray-800'
                    }`}
                  >
                    <KeyRound size={14} className="text-brand" />
                    Set new password
                  </button>
                </div>

                {showDirectPassword && (
                  <form onSubmit={handleSetDirectPassword} className="rounded-xl bg-gray-50 border border-gray-200 p-3 space-y-2.5">
                    <label className="block text-xs font-semibold text-gray-700">
                      New password for {current.name || current.email}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        minLength={6}
                        maxLength={128}
                        value={directPassword}
                        onChange={(e) => setDirectPassword(e.target.value)}
                        placeholder="At least 6 characters"
                        aria-label="New password"
                        className={`${adminInput} flex-1 bg-white`}
                        required
                      />
                      <button
                        type="submit"
                        disabled={savingPassword || directPassword.trim().length < 6}
                        className="shrink-0 px-4 py-2 rounded-btn bg-brand text-on-brand text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {savingPassword && <Spinner size={13} />}
                        Save
                      </button>
                    </div>
                    <p className="text-[11px] text-gray-500">
                      Updates their password immediately or sends a reset link if they sign in via email.
                    </p>
                  </form>
                )}
              </div>
            )}

            <div className="pt-1 border-t border-gray-100">
              <p className="text-sm font-semibold mb-2 text-gray-900">Private promo codes</p>
              <div className="space-y-2">
                {promos.filter((p) => p.assignedTo?.includes(current.uid)).map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-xl bg-gray-50 border border-gray-100 px-3 py-2 text-sm">
                    <span className="font-mono font-bold">{p.id}</span>
                    <button onClick={() => setPromoAssignment(p, current, false)} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Remove ${p.id}`}>
                      <X size={16} />
                    </button>
                  </div>
                ))}
                <select
                  value=""
                  onChange={(e) => {
                    const promo = promos.find((p) => p.id === e.target.value);
                    if (promo) setPromoAssignment(promo, current, true);
                  }}
                  className={adminInput}
                >
                  <option value="">Send a promo code…</option>
                  {promos
                    .filter((p) => p.active && !p.assignedTo?.includes(current.uid))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id} ({p.discountType === 'percentage' ? `${p.discountValue}%` : formatMoney(p.discountValue)} off)
                      </option>
                    ))}
                </select>
                <p className="text-xs text-gray-500">
                  Once a code is assigned to someone, only assigned customers can use it. It appears in their account under “Your offers”.
                </p>
              </div>
            </div>

            {/* Remove / Block Person Controls (Ex-employee, Fraud User, or Pending Invite) */}
            {canManageCurrent && (
              <div className="pt-3 border-t border-gray-100 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Account actions</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {current.disabled ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleBlockOrUnblock(current, false)}
                      className="w-full py-2.5 px-3 rounded-xl border border-emerald-200 text-emerald-700 hover:bg-emerald-50 text-xs font-bold flex items-center justify-center gap-1.5 transition"
                    >
                      <CheckCircle2 size={14} /> Unblock account
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setBlockReason(current.role !== 'customer' ? 'Ex-employee access revoked' : 'Fraudulent / unpaid orders');
                        setBlockTarget(current);
                      }}
                      className="w-full py-2.5 px-3 rounded-xl border border-amber-200 text-amber-800 hover:bg-amber-50 text-xs font-bold flex items-center justify-center gap-1.5 transition"
                    >
                      <Ban size={14} /> Block account
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setRemoveTarget(current)}
                    className="w-full py-2.5 px-3 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 text-xs font-bold flex items-center justify-center gap-1.5 transition"
                  >
                    <Trash2 size={14} /> {current.uid.startsWith('invite_') ? 'Remove invite' : 'Remove person'}
                  </button>
                </div>
                <p className="text-[11px] text-gray-500">
                  <strong>Block</strong> keeps their email on the blocklist so they cannot place orders or use staff tools.{' '}
                  <strong>Remove</strong> deletes their profile and revokes team roles.
                </p>
              </div>
            )}
          </div>
        )}
      </Sheet>

      <Sheet
        open={creating}
        onClose={() => !busy && setCreating(false)}
        surface="admin"
        size="sm"
        title="Add team member"
        footer={
          <button form="new-user" type="submit" disabled={busy} className="w-full py-3 rounded-btn bg-brand hover:opacity-95 text-on-brand font-bold flex items-center justify-center gap-2">
            {busy && <Spinner size={16} />} Add team member
          </button>
        }
      >
        <form id="new-user" onSubmit={createUser} className="p-5 space-y-4">
          <Field label="Name">
            <input value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} placeholder="Full name" className={adminInput} required />
          </Field>
          <Field label="Email" hint="They can sign in with Google using this email address to access their role immediately.">
            <input type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} placeholder="team@example.com" className={adminInput} required />
          </Field>
          <Field label="Role">
            <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as UserRole })} className={adminInput}>
              {grantable
                .filter((r) => r !== 'customer')
                .map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label="Temporary password (optional)"
            hint="Leave blank if they sign in with Google. Only used when Email/Password sign-in is enabled in Firebase Authentication."
          >
            <input
              type="password"
              minLength={6}
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              placeholder="Optional (Google sign-in works without a password)"
              className={adminInput}
            />
          </Field>
        </form>
      </Sheet>

      <ConfirmDialog
        open={!!roleChange}
        busy={busy}
        title="Change role?"
        message={roleChange && `${roleChange.user.name || roleChange.user.email} will become ${ROLE_LABEL[roleChange.role]}.`}
        onCancel={() => setRoleChange(null)}
        onConfirm={confirmRole}
      />

      {/* Block Person Dialog */}
      <ConfirmDialog
        open={!!blockTarget}
        busy={busy}
        danger
        title={`Block ${blockTarget?.name || blockTarget?.email}?`}
        confirmLabel="Block account"
        message={
          blockTarget && (
            <div className="space-y-3">
              <p>
                This immediately revokes any team role ({ROLE_LABEL[blockTarget.role]}) and blocks{' '}
                <strong className="text-gray-900">{blockTarget.email}</strong> from placing orders.
              </p>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Reason (shown to staff)</label>
                <input
                  value={blockReason}
                  onChange={(e) => setBlockReason(e.target.value.slice(0, 200))}
                  placeholder="e.g. Fraudulent order / Ex-employee"
                  aria-label="Block reason"
                  className={adminInput}
                />
              </div>
            </div>
          )
        }
        onCancel={() => setBlockTarget(null)}
        onConfirm={() => blockTarget && handleBlockOrUnblock(blockTarget, true, blockReason)}
      />

      {/* Remove Person Permanently Dialog */}
      <ConfirmDialog
        open={!!removeTarget}
        busy={busy}
        danger
        title={`Remove ${removeTarget?.name || removeTarget?.email}?`}
        confirmLabel="Remove person"
        message={
          removeTarget && (
            <>
              This removes <strong className="text-gray-900">{removeTarget.name || removeTarget.email}</strong> from People and revokes any{' '}
              {removeTarget.role !== 'customer' ? `${ROLE_LABEL[removeTarget.role]} access` : 'account profile'} or assigned promo codes.
            </>
          )
        }
        onCancel={() => setRemoveTarget(null)}
        onConfirm={handleRemovePerson}
      />
    </div>
  );
};
