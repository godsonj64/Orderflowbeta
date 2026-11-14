import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, orderBy, query, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import type { MenuCategory, MenuItem, RestaurantProfile } from '../types';
import { DEFAULT_CATEGORIES, DEFAULT_ITEMS, DEFAULT_RESTAURANT_PROFILE } from '../lib/defaultStore';
import { getStoreStatus, type StoreStatus } from '../lib/storeStatus';
import { ensureFontLoaded, resolveTheme, type ResolvedTheme } from '../lib/theme';
import type { Catalog } from '../lib/pricing';
import { api } from '../lib/api';
import { OperationType, reportError } from '../utils/errorHandling';

interface StoreContextValue {
  profile: RestaurantProfile | null;
  /** True when restaurant/profile exists in Firestore; false when using the starter default profile. */
  profileExists: boolean;
  profileLoading: boolean;
  categories: MenuCategory[];
  items: MenuItem[];
  /** True when categories and items come from the built-in starter catalog because Firestore is empty. */
  usingDefaultCatalog: boolean;
  /** Persists the starter categories and items into Firestore before any item/category mutation. */
  ensureCatalogPersisted: () => Promise<void>;
  /** Clears the starter or current menu so the owner can build their menu from a completely blank slate. */
  clearMenuCatalog: () => Promise<void>;
  menuLoading: boolean;
  /** Menu as seen by customers: active items in active categories (sold-out items included). */
  catalog: Catalog;
  status: StoreStatus;
  theme: ResolvedTheme;
  /** Card payments are configured on the server and in the browser, and enabled by the owner. */
  cardPaymentsAvailable: boolean;
  cashPaymentsAvailable: boolean;
  /** False when the API server could not be reached. */
  serverReachable: boolean;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export const useStore = () => {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>');
  return ctx;
};

const STRIPE_PUBLIC_KEY = import.meta.env.VITE_STRIPE_PUBLIC_KEY as string | undefined;
const PROFILE_CACHE_KEY = 'orderflow_cached_profile_v1';

function readCachedProfile(): RestaurantProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.name === 'string' ? (parsed as RestaurantProfile) : null;
  } catch {
    return null;
  }
}

function writeCachedProfile(profile: RestaurantProfile | null) {
  try {
    if (profile && profile.name) {
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
    }
  } catch {
    // Ignore storage quota errors
  }
}

export const StoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [rawProfile, setRawProfile] = useState<RestaurantProfile | null>(() => readCachedProfile());
  const [profileExists, setProfileExists] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [rawCategories, setRawCategories] = useState<MenuCategory[]>([]);
  const [rawItems, setRawItems] = useState<MenuItem[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [serverCard, setServerCard] = useState(false);
  const [serverReachable, setServerReachable] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const unsubProfile = onSnapshot(
      doc(db, 'restaurant', 'profile'),
      (snap) => {
        setProfileExists(snap.exists());
        const next = snap.exists() ? (snap.data() as RestaurantProfile) : null;
        setRawProfile(next);
        if (next) writeCachedProfile(next);
        setProfileLoading(false);
      },
      (err) => {
        reportError(err, 'store-profile', { toast: false, operationType: OperationType.GET, path: 'restaurant/profile' });
        setProfileLoading(false);
      },
    );
    const unsubCategories = onSnapshot(
      query(collection(db, 'categories'), orderBy('displayOrder')),
      (snap) => {
        setRawCategories(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MenuCategory));
        setCategoriesLoaded(true);
      },
      (err) => {
        reportError(err, 'store-categories', { toast: false, operationType: OperationType.LIST, path: 'categories' });
        setCategoriesLoaded(true);
      },
    );
    const unsubItems = onSnapshot(
      collection(db, 'items'),
      (snap) => {
        setRawItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MenuItem));
        setItemsLoaded(true);
      },
      (err) => {
        reportError(err, 'store-items', { toast: false, operationType: OperationType.LIST, path: 'items' });
        setItemsLoaded(true);
      },
    );
    return () => {
      unsubProfile();
      unsubCategories();
      unsubItems();
    };
  }, []);

  const profile = useMemo<RestaurantProfile | null>(() => {
    if (profileLoading) return rawProfile;
    return rawProfile ?? DEFAULT_RESTAURANT_PROFILE;
  }, [rawProfile, profileLoading]);

  const usingDefaultCatalog = useMemo(
    () =>
      categoriesLoaded &&
      itemsLoaded &&
      rawCategories.length === 0 &&
      rawItems.length === 0 &&
      !rawProfile?.starterMenuCleared,
    [categoriesLoaded, itemsLoaded, rawCategories.length, rawItems.length, rawProfile?.starterMenuCleared],
  );

  const categories = useMemo(
    () => (usingDefaultCatalog ? DEFAULT_CATEGORIES : rawCategories),
    [usingDefaultCatalog, rawCategories],
  );

  const items = useMemo(
    () => (usingDefaultCatalog ? DEFAULT_ITEMS : rawItems),
    [usingDefaultCatalog, rawItems],
  );

  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setServerCard(!!cfg.cardPayments);
        setServerReachable(true);
        if (cfg.profile?.name) {
          setRawProfile((prev) => prev || cfg.profile || null);
          writeCachedProfile(cfg.profile);
          setProfileLoading(false);
        }
      })
      .catch(() => setServerReachable(false));
  }, []);

  // Re-evaluate "open now" every 30 seconds.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const theme = useMemo(() => resolveTheme(profile?.theme), [profile?.theme]);
  useEffect(() => ensureFontLoaded(theme.font), [theme.font]);

  const prevStatusRef = React.useRef<StoreStatus | null>(null);
  const status = useMemo(() => {
    const next = getStoreStatus(profile, new Date(now));
    const prev = prevStatusRef.current;
    if (
      prev &&
      prev.state === next.state &&
      prev.canOrderNow === next.canOrderNow &&
      prev.canSchedule === next.canSchedule &&
      prev.badge === next.badge &&
      prev.detail === next.detail &&
      prev.timeZone === next.timeZone &&
      prev.pausedUntil?.getTime() === next.pausedUntil?.getTime() &&
      prev.nextOpenAt?.getTime() === next.nextOpenAt?.getTime()
    ) {
      return prev;
    }
    prevStatusRef.current = next;
    return next;
  }, [profile, now]);

  const ensureCatalogPersisted = useCallback(async () => {
    if (!usingDefaultCatalog) return;
    const batch = writeBatch(db);
    for (const c of categories) {
      const { id, ...data } = c;
      batch.set(doc(db, 'categories', id), data);
    }
    for (const item of items) {
      const { id, rating: _r, ratingCount: _rc, soldCount: _sc, ...data } = item;
      batch.set(doc(db, 'items', id), data);
    }
    const baseProfile = rawProfile || DEFAULT_RESTAURANT_PROFILE;
    const { averageRating: _ar, totalRatings: _tr, ...safeProfile } = baseProfile;
    batch.set(
      doc(db, 'restaurant', 'profile'),
      { ...safeProfile, name: safeProfile.name || 'Restaurant', isAcceptingOrders: safeProfile.isAcceptingOrders ?? true, starterMenuCleared: true },
      { merge: true },
    );
    await batch.commit();
  }, [usingDefaultCatalog, categories, items, rawProfile]);

  const clearMenuCatalog = useCallback(async () => {
    const batch = writeBatch(db);
    for (const c of rawCategories) {
      batch.delete(doc(db, 'categories', c.id));
    }
    for (const item of rawItems) {
      batch.delete(doc(db, 'items', item.id));
    }
    const baseProfile = rawProfile || DEFAULT_RESTAURANT_PROFILE;
    const { averageRating: _ar, totalRatings: _tr, ...safeProfile } = baseProfile;
    batch.set(
      doc(db, 'restaurant', 'profile'),
      { ...safeProfile, name: safeProfile.name || 'Restaurant', isAcceptingOrders: safeProfile.isAcceptingOrders ?? true, starterMenuCleared: true },
      { merge: true },
    );
    await batch.commit();
  }, [rawCategories, rawItems, rawProfile]);

  const catalog = useMemo<Catalog>(() => {
    const activeCategoryIds = new Set(categories.filter((c) => c.active !== false).map((c) => c.id));
    return { items: new Map(items.map((i) => [i.id, i])), activeCategoryIds };
  }, [categories, items]);

  const value = useMemo<StoreContextValue>(
    () => ({
      profile,
      profileExists,
      profileLoading,
      categories,
      items,
      usingDefaultCatalog,
      ensureCatalogPersisted,
      clearMenuCatalog,
      menuLoading: !categoriesLoaded || !itemsLoaded,
      catalog,
      status,
      theme,
      cardPaymentsAvailable: serverCard && !!STRIPE_PUBLIC_KEY && profile?.isCardPaymentEnabled !== false,
      cashPaymentsAvailable: profile?.isCashPaymentEnabled === true,
      serverReachable,
    }),
    [
      profile,
      profileExists,
      profileLoading,
      categories,
      items,
      usingDefaultCatalog,
      ensureCatalogPersisted,
      clearMenuCatalog,
      categoriesLoaded,
      itemsLoaded,
      catalog,
      status,
      theme,
      serverCard,
      serverReachable,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
};
