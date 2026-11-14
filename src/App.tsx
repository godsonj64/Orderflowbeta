import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter as Router, Link, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { StoreProvider } from './context/StoreContext';
import { CartProvider } from './context/CartContext';
import { Layout } from './components/Layout';
import { AdminLayout } from './components/AdminLayout';
import { RequireRole } from './components/RequireRole';
import { ErrorBoundary } from './components/ErrorBoundary';
import { CookieConsent } from './components/CookieConsent';
import { SolidToaster } from './components/StatusBanner';
import { PageSpinner } from './components/ui';
import { Home } from './pages/Home';
import { MANAGER_ROLES, STAFF_ROLES, type UserRole } from './types';

// Secondary storefront screens and admin screens are code-split so new devices on mobile
// networks only download the Home storefront bundle on initial paint.
const RELOAD_KEY = 'orderflow_reloaded_for_update';
function lazyNamed<T extends Record<string, any>>(loader: () => Promise<T>, name: keyof T) {
  return lazy(() =>
    loader().then(
      (m) => {
        try {
          sessionStorage.removeItem(RELOAD_KEY);
        } catch {
          // ignore
        }
        return { default: m[name] as React.ComponentType<any> };
      },
      (err) => {
        // Dashboards stay open for days. After a new version is deployed the old code
        // files are gone, so opening another screen fails: reload once to get the update.
        let alreadyReloaded = true;
        try {
          alreadyReloaded = !!sessionStorage.getItem(RELOAD_KEY);
          sessionStorage.setItem(RELOAD_KEY, '1');
        } catch {
          // ignore
        }
        if (alreadyReloaded) throw err;
        window.location.reload();
        return new Promise<never>(() => undefined);
      },
    ),
  );
}

const Cart = lazyNamed(() => import('./pages/Cart'), 'Cart');
const OrderTracker = lazyNamed(() => import('./pages/OrderTracker'), 'OrderTracker');
const MyOrders = lazyNamed(() => import('./pages/MyOrders'), 'MyOrders');
const OrderSuccess = lazyNamed(() => import('./pages/OrderSuccess'), 'OrderSuccess');
const PrivacyPolicy = lazyNamed(() => import('./pages/PrivacyPolicy'), 'PrivacyPolicy');
const TermsOfService = lazyNamed(() => import('./pages/TermsOfService'), 'TermsOfService');
const CookiePolicy = lazyNamed(() => import('./pages/CookiePolicy'), 'CookiePolicy');

const AdminDashboard = lazyNamed(() => import('./pages/AdminDashboard'), 'AdminDashboard');
const KitchenDashboard = lazyNamed(() => import('./pages/KitchenDashboard'), 'KitchenDashboard');
const AdminMenu = lazyNamed(() => import('./pages/AdminMenu'), 'AdminMenu');
const AdminSettings = lazyNamed(() => import('./pages/AdminSettings'), 'AdminSettings');
const AdminUsers = lazyNamed(() => import('./pages/AdminUsers'), 'AdminUsers');
const AdminPromos = lazyNamed(() => import('./pages/AdminPromos'), 'AdminPromos');
const DriverDashboard = lazyNamed(() => import('./pages/DriverDashboard'), 'DriverDashboard');

const DRIVER_ROLES: UserRole[] = ['driver', ...MANAGER_ROLES];

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const targetId = hash === '#menu' ? 'menu-catalog' : hash.slice(1);
      const timer = window.setTimeout(() => {
        const el = document.getElementById(targetId);
        if (el) {
          const offset = targetId === 'menu-catalog' ? 76 : 96;
          const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset);
          window.scrollTo({ top, behavior: 'smooth' });
        }
      }, 60);
      return () => window.clearTimeout(timer);
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname, hash]);
  return null;
}

function NotFound() {
  return (
    <div className="text-center py-24">
      <h1 className="text-3xl font-extrabold mb-2">Page not found</h1>
      <p className="text-muted mb-6">The page you're looking for doesn't exist.</p>
      <Link to="/" className="inline-block bg-brand text-on-brand px-6 py-3 rounded-btn font-semibold">
        Back to the menu
      </Link>
    </div>
  );
}

const page = (element: React.ReactNode) => <Suspense fallback={<PageSpinner />}>{element}</Suspense>;

const admin = (element: React.ReactNode, roles: UserRole[] = STAFF_ROLES) => (
  <RequireRole roles={roles}>
    <Suspense fallback={<PageSpinner />}>{element}</Suspense>
  </RequireRole>
);

export default function App() {
  // Warm the Cart chunk during browser idle time so opening the cart feels instantaneous.
  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const preload = () => {
      void import('./pages/Cart').catch(() => undefined);
    };
    if (typeof win.requestIdleCallback === 'function') {
      const id = win.requestIdleCallback(preload, { timeout: 2500 });
      return () => win.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(preload, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <ErrorBoundary>
      <AuthProvider>
        <StoreProvider>
          <CartProvider>
            <Router>
              <ScrollToTop />
              <SolidToaster />
              <Routes>
                <Route path="/" element={<Layout />}>
                  <Route index element={<Home />} />
                  <Route path="cart" element={page(<Cart />)} />
                  <Route path="order/:orderId" element={page(<OrderTracker />)} />
                  <Route path="my-orders" element={page(<MyOrders />)} />
                  <Route path="order-success" element={page(<OrderSuccess />)} />
                  <Route path="privacy-policy" element={page(<PrivacyPolicy />)} />
                  <Route path="terms-of-service" element={page(<TermsOfService />)} />
                  <Route path="cookie-policy" element={page(<CookiePolicy />)} />
                  <Route path="*" element={<NotFound />} />
                </Route>

                <Route path="/admin" element={admin(<AdminLayout />)}>
                  <Route index element={admin(<AdminDashboard />)} />
                  <Route path="kitchen" element={admin(<KitchenDashboard />)} />
                  <Route path="menu" element={admin(<AdminMenu />, MANAGER_ROLES)} />
                  <Route path="settings" element={admin(<AdminSettings />, MANAGER_ROLES)} />
                  <Route path="users" element={admin(<AdminUsers />, MANAGER_ROLES)} />
                  <Route path="promos" element={admin(<AdminPromos />, MANAGER_ROLES)} />
                </Route>

                <Route path="/driver" element={admin(<AdminLayout />, DRIVER_ROLES)}>
                  <Route index element={admin(<DriverDashboard />, DRIVER_ROLES)} />
                </Route>
              </Routes>
              <CookieConsent />
            </Router>
          </CartProvider>
        </StoreProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
