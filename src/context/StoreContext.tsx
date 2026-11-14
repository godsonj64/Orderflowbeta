import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, orderBy, query, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import type { MenuCategory, MenuItem, RestaurantProfile } from '../types';
import { DEFAULT_CATEGORIES, DEFAULT_ITEMS, DEFAULT_RESTAURANT_PROFILE } from '../lib/defaultStore';
import { getStoreStatus, type StoreStatus } from '../lib/storeStatus';
import { ensureFontLoaded, resolveTheme, type ResolvedTheme } from '../lib/theme';
import type { Catalog } from '../lib/pricing';
import { api, type OrderingMode } from '../lib/api';
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
  /**
   * How orders are placed. "server": priced and created by the server (cards, promos,
   * refunds). "direct": the server has no database access, so only unpaid cash orders
   * can be placed (see SETUP.md). null until the server has answered.
   */
  orderingMode: OrderingMode | null;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export const useStore = () => {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>');
  return ctx;
};

const STRIPE_PUBLIC_KEY = import.meta.env.VITE_STRIPE_PUBLIC_KEY as string | undefined;
const PROFILE_CACHE_KEY = 'orderflow_cached_profile_v1';
const CATALOG_CACHE_KEY = 'orderflow_cached_catalog_v1';

interface CachedCatalog {
  categories: MenuCategory[];
  items: MenuItem[];
}

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

function readCachedCatalog(): CachedCatalog | null {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.categories) && Array.isArray(parsed.items)) {
      return { categories: parsed.categories as MenuCategory[], items: parsed.items as MenuItem[] };
    }
    return null;
  } catch {
    return null;
  }
}

function writeCachedCatalog(categories: MenuCategory[], items: MenuItem[]) {
  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ categories, items }));
  } catch {
    // Ignore storage quota errors
  }
}

export const StoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initialCachedProfile = useMemo(() => readCachedProfile(), []);
  const initialCachedCatalog = useMemo(() => readCachedCatalog(), []);

  const [rawProfile, setRawProfile] = useState<RestaurantProfile | null>(() => initialCachedProfile);
  const [profileExists, setProfileExists] = useState(false);
  const [profileLoading, setProfileLoading] = useState(() => !initialCachedProfile);
  const [rawCategories, setRawCategories] = useState<MenuCategory[]>(() => initialCachedCatalog?.categories ?? []);
  const [rawItems, setRawItems] = useState<MenuItem[]>(() => initialCachedCatalog?.items ?? []);
  const [categoriesLoaded, setCategoriesLoaded] = useState(() => !!initialCachedCatalog);
  const [itemsLoaded, setItemsLoaded] = useState(() => !!initialCachedCatalog);
  const [serverCard, setServerCard] = useState(false);
  const [serverReachable, setServerReachable] = useState(true);
  const [orderingMode, setOrderingMode] = useState<OrderingMode | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Track whether live Firestore listeners have delivered authoritative snapshots yet so
  // /api/config can hydrate cold devices without overwriting live Firestore updates.
  const firestoreCategoriesRef = React.useRef<MenuCategory[] | null>(null);
  const firestoreItemsRef = React.useRef<MenuItem[] | null>(null);

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
        const nextCategories = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MenuCategory);
        firestoreCategoriesRef.current = nextCategories;
        setRawCategories(nextCategories);
        setCategoriesLoaded(true);
        if (firestoreItemsRef.current !== null) {
          writeCachedCatalog(nextCategories, firestoreItemsRef.current);
        }
      },
      (err) => {
        reportError(err, 'store-categories', { toast: false, operationType: OperationType.LIST, path: 'categories' });
        setCategoriesLoaded(true);
      },
    );
    const unsubItems = onSnapshot(
      collection(db, 'items'),
      (snap) => {
        const nextItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MenuItem);
        firestoreItemsRef.current = nextItems;
        setRawItems(nextItems);
        setItemsLoaded(true);
        if (firestoreCategoriesRef.current !== null) {
          writeCachedCatalog(firestoreCategoriesRef.current, nextItems);
        }
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

  // What the server can do right now. Phones drop off the network all the time, so a
  // failed check is retried (with backoff, and immediately when the connection or the
  // tab comes back) instead of leaving checkout blocked until a manual reload.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    let loaded = false;
    let inFlight = false;

    const load = () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      window.clearTimeout(timer);
      api
        .config()
        .then((cfg) => {
          if (cancelled) return;
          loaded = true;
          failures = 0;
          setServerCard(!!cfg.cardPayments);
          setOrderingMode(cfg.ordering === 'direct' ? 'direct' : 'server');
          setServerReachable(true);
          // The server's copy of the profile + catalog lets the first paint happen on
          // brand-new devices before the live Firestore WebChannel connection is up.
          if (cfg.profile?.name) {
            setRawProfile((prev) => prev || cfg.profile || null);
            writeCachedProfile(cfg.profile);
            setProfileLoading(false);
          }
          if (Array.isArray(cfg.categories) && firestoreCategoriesRef.current === null) {
            setRawCategories(cfg.categories);
            setCategoriesLoaded(true);
          }
          if (Array.isArray(cfg.items) && firestoreItemsRef.current === null) {
            setRawItems(cfg.items);
            setItemsLoaded(true);
          }
          if (
            Array.isArray(cfg.categories) &&
            Array.isArray(cfg.items) &&
            firestoreCategoriesRef.current === null &&
            firestoreItemsRef.current === null
          ) {
            writeCachedCatalog(cfg.categories, cfg.items);
          }
        })
        .catch(() => {
          if (cancelled) return;
          loaded = false;
          failures += 1;
          setServerReachable(false);
          timer = window.setTimeout(load, Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)));
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const retryNow = () => {
      if (!loaded && document.visibilityState === 'visible') load();
    };

    load();
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', retryNow);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', retryNow);
    };
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
    const build = (withProfile: boolean) => {
      const batch = writeBatch(db);
      for (const c of categories) {
        const { id, ...data } = c;
        batch.set(doc(db, 'categories', id), data);
      }
      for (const item of items) {
        const { id, rating: _r, ratingCount: _rc, soldCount: _sc, ...data } = item;
        batch.set(doc(db, 'items', id), data);
      }
      if (withProfile) {
        const baseProfile = rawProfile || DEFAULT_RESTAURANT_PROFILE;
        const { averageRating: _ar, totalRatings: _tr, ...safeProfile } = baseProfile;
        batch.set(
          doc(db, 'restaurant', 'profile'),
          { ...safeProfile, name: safeProfile.name || 'Restaurant', isAcceptingOrders: safeProfile.isAcceptingOrders ?? true, starterMenuCleared: true },
          { merge: true },
        );
      }
      return batch;
    };
    try {
      await build(true).commit();
    } catch (err) {
      // Kitchen staff may save the menu (e.g. marking an item sold out) but not the store
      // settings; a batch fails as a whole, so save the menu without the settings flag.
      if ((err as { code?: string })?.code !== 'permission-denied') throw err;
      await build(false).commit();
    }
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
      orderingMode,
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
      orderingMode,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
};
