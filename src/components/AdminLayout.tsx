import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  AlertTriangle,
  ChefHat,
  ClipboardList,
  ExternalLink,
  LogOut,
  MoreHorizontal,
  Settings,
  Tag,
  Truck,
  Users,
  UtensilsCrossed,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useStore } from '../context/StoreContext';
import { useNewOrderAlerts } from '../hooks/useNewOrderAlerts';
import { brandThemeStyle, ensureFontLoaded } from '../lib/theme';
import { LoadingSplash } from './LoadingSplash';
import { Sheet } from './ui';
import { api } from '../lib/api';

type Health = Awaited<ReturnType<typeof api.health>>;

function useApplyAdminBrandTheme() {
  const { theme } = useStore();
  const vars = useMemo(() => brandThemeStyle(theme) as Record<string, string>, [theme]);

  useEffect(() => {
    ensureFontLoaded(theme.font);
  }, [theme.font]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const keys = Object.keys(vars).filter((k) => k.startsWith('--'));
    for (const k of keys) root.style.setProperty(k, String(vars[k]));
    root.style.setProperty('--app-bg', '#F6F7F5');
    root.style.colorScheme = 'light';
    return () => {
      for (const k of keys) root.style.removeProperty(k);
      root.style.removeProperty('--app-bg');
      root.style.colorScheme = '';
    };
  }, [vars]);
}

export const AdminLayout: React.FC = () => {
  useApplyAdminBrandTheme();
  const { userProfile, isStaff, isManager, role, logout } = useAuth();
  const { profile, status, theme } = useStore();
  const { newOrders, soundOn, toggleSound } = useNewOrderAlerts(isStaff);
  const location = useLocation();
  const [health, setHealth] = useState<Health | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    document.title = `${profile?.name || 'OrderFlow'} · Dashboard`;
  }, [profile?.name]);

  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isManager) return;
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [isManager]);

  const tabs = [
    { to: '/admin', label: 'Orders', icon: ClipboardList, end: true, show: isStaff, badge: newOrders.length, primaryMobile: true },
    { to: '/admin/kitchen', label: 'Kitchen', icon: ChefHat, show: isStaff, badge: newOrders.length, primaryMobile: true },
    { to: '/driver', label: 'Deliveries', icon: Truck, show: role === 'driver' || isManager, primaryMobile: !isManager },
    { to: '/admin/menu', label: 'Menu', icon: UtensilsCrossed, show: isManager, primaryMobile: true },
    { to: '/admin/promos', label: 'Promos', icon: Tag, show: isManager, primaryMobile: false },
    { to: '/admin/users', label: 'People', icon: Users, show: isManager, primaryMobile: false },
    { to: '/admin/settings', label: 'Settings', icon: Settings, show: isManager, primaryMobile: true },
  ].filter((t) => t.show);

  const mobilePrimaryTabs = tabs.length <= 5 ? tabs : tabs.filter((t) => t.primaryMobile);
  const mobileOverflowTabs = tabs.length <= 5 ? [] : tabs.filter((t) => !t.primaryMobile);
  const isOverflowActive = mobileOverflowTabs.some((t) => location.pathname.startsWith(t.to));

  const currentTab =
    tabs.find((t) => (t.end ? location.pathname === t.to : location.pathname.startsWith(t.to))) || tabs[0];

  const fullBleed = location.pathname.startsWith('/admin/kitchen');
  const statusDot =
    status.state === 'open'
      ? 'bg-emerald-500'
      : status.state === 'paused'
        ? 'bg-amber-500'
        : 'bg-red-500';
  const statusTone =
    status.state === 'open'
      ? 'text-brand bg-accent border-brand/20'
      : status.state === 'paused'
        ? 'text-amber-800 bg-amber-50 border-amber-200'
        : 'text-red-700 bg-red-50 border-red-200';

  const banners: { tone: 'red' | 'amber'; text: React.ReactNode }[] = [];
  if (isManager && health?.firestore === 'error') {
    banners.push({
      tone: 'red',
      text: (
        <>
          Basic mode: the server has no access to your database (Firebase Admin credentials), so it cannot price or create orders. Customers can
          only place <strong>cash</strong> orders; card payments, promo codes, refunds and sales statistics are switched off until this is fixed
          (see SETUP.md → Environment variables).
        </>
      ),
    });
  }
  if (isManager && health && health.firestore === 'ok' && profile) {
    const card = health.cardPayments && profile.isCardPaymentEnabled !== false && !!import.meta.env.VITE_STRIPE_PUBLIC_KEY;
    if (!card && !profile.isCashPaymentEnabled) {
      banners.push({
        tone: 'amber',
        text: (
          <>
            Customers can't pay yet. Add your Stripe keys, or turn on cash payments in{' '}
            <Link className="underline font-semibold" to="/admin/settings?tab=payments">
              Settings → Payments
            </Link>
            .
          </>
        ),
      });
    }
  }
  if (isManager && profile && !profile.timezone) {
    banners.push({
      tone: 'amber',
      text: (
        <>
          Set your time zone in{' '}
          <Link className="underline font-semibold" to="/admin/settings?tab=hours">
            Settings → Hours
          </Link>{' '}
          so opening hours are applied correctly.
        </>
      ),
    });
  }

  return (
    <div style={brandThemeStyle(theme)} className="min-h-[100dvh] bg-[#F6F7F5] text-ink font-sans flex flex-col">
      <LoadingSplash waitForMenu={false} />
      {/* Top Bar: Matches the storefront's clean, tactile Kupa brand bar */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-xl border-b border-line shadow-2xs">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-3">
          {/* Zone 1: Brand Lockup & Live Status */}
          <div className="flex items-center gap-2.5 min-w-0">
            <Link to="/" className="flex items-center gap-2.5 min-w-0 group" title="Open storefront">
              {profile?.logoUrl ? (
                <img src={profile.logoUrl} alt="" className="w-9 h-9 rounded-full object-cover border border-line shrink-0 shadow-2xs" />
              ) : (
                <span className="w-9 h-9 rounded-full bg-brand text-on-brand flex items-center justify-center font-display font-extrabold text-sm shrink-0 shadow-2xs">
                  {(profile?.name || 'H').charAt(0)}
                </span>
              )}
              <div className="min-w-0">
                <span className="block font-display font-extrabold text-sm sm:text-base tracking-tight text-ink truncate max-w-[130px] sm:max-w-[200px] leading-tight">
                  {profile?.name || 'Dashboard'}
                </span>
                <span className="hidden sm:flex items-center gap-1.5 text-[11px] font-medium text-muted leading-none mt-0.5">
                  <span>Operations Console</span>
                </span>
              </div>
            </Link>
            <span className={`inline-flex items-center gap-1.5 text-[11px] sm:text-xs font-bold px-2.5 py-1 rounded-full border whitespace-nowrap shrink-0 ${statusTone}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
              <span>{status.badge}</span>
            </span>
          </div>

          {/* Zone 2: Desktop Primary Navigation */}
          <nav className="hidden md:flex items-center gap-1 bg-soft border border-line/80 p-1 rounded-2xl" aria-label="Dashboard sections">
            {tabs.map(({ to, label, end, badge }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `relative whitespace-nowrap shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-btn text-xs sm:text-sm font-bold transition ${
                    isActive
                      ? 'bg-brand text-on-brand shadow-xs'
                      : 'text-muted hover:text-ink hover:bg-white/70'
                  }`
                }
              >
                {label}
                {!!badge && (
                  <span className="min-w-4 h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold tabular-nums flex items-center justify-center">
                    {badge}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

          {/* Zone 3: Utilities */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isStaff && (
              <button
                onClick={toggleSound}
                className={`min-h-[38px] px-3 py-1.5 rounded-btn text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap shrink-0 ${
                  soundOn ? 'bg-accent text-on-accent border border-brand/20' : 'bg-soft text-muted hover:text-ink border border-line'
                }`}
                title={soundOn ? 'New-order alert sound is on' : 'Turn on new-order alert sound'}
                aria-label={soundOn ? 'Sound alerts on' : 'Sound alerts off'}
              >
                {soundOn ? <Volume2 size={15} className="text-brand" /> : <VolumeX size={15} />}
                <span className="hidden sm:inline">{soundOn ? 'Alerts on' : 'Muted'}</span>
              </button>
            )}
            <Link
              to="/"
              className="min-h-[38px] px-3.5 py-1.5 rounded-btn text-xs font-bold text-brand bg-accent hover:opacity-90 border border-brand/15 flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
              title="View customer storefront"
            >
              <span className="hidden sm:inline">Storefront</span>
              <ExternalLink size={13} />
            </Link>
            <button
              onClick={logout}
              className="hidden md:flex min-h-[38px] min-w-[38px] items-center justify-center rounded-btn text-muted hover:bg-red-50 hover:text-red-600 transition"
              title={`Sign out ${userProfile?.email || ''}`}
              aria-label="Sign out"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </header>

      {banners.length > 0 && (
        <div className="max-w-7xl w-full mx-auto px-3 sm:px-6 pt-3 space-y-2">
          {banners.map((b, i) => (
            <div
              key={i}
              className={`flex items-start gap-2.5 rounded-card border px-3.5 py-2.5 text-xs sm:text-sm ${
                b.tone === 'red' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div className="leading-snug">{b.text}</div>
            </div>
          ))}
        </div>
      )}

      <main className={`flex-1 ${fullBleed ? 'pb-20 md:pb-0' : 'max-w-7xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-6 pb-24 md:pb-12'}`}>
        <Outlet />
      </main>

      {/* Mobile Bottom Tab Bar: Matches storefront BottomNav with brand indicator */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur-xl border-t border-line pb-[env(safe-area-inset-bottom)]"
        aria-label="Mobile dashboard navigation"
      >
        <div className="grid items-center h-15" style={{ gridTemplateColumns: `repeat(${mobilePrimaryTabs.length + (mobileOverflowTabs.length ? 1 : 0)}, minmax(0, 1fr))` }}>
          {mobilePrimaryTabs.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `relative flex flex-col items-center justify-center h-full min-h-[48px] gap-0.5 text-[11px] font-bold transition ${
                  isActive ? 'text-brand' : 'text-muted hover:text-ink'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && <span className="absolute top-0 w-8 h-0.5 rounded-full bg-brand" />}
                  <span className="relative">
                    <Icon size={19} strokeWidth={isActive ? 2.4 : 1.9} />
                    {!!badge && (
                      <span className="absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-red-600 text-white text-[9px] font-bold tabular-nums flex items-center justify-center">
                        {badge}
                      </span>
                    )}
                  </span>
                  <span className="truncate max-w-full px-1">{label}</span>
                </>
              )}
            </NavLink>
          ))}

          {mobileOverflowTabs.length > 0 && (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-label="More sections"
              aria-expanded={moreOpen}
              className={`relative flex flex-col items-center justify-center h-full min-h-[48px] gap-0.5 text-[11px] font-bold transition ${
                isOverflowActive || moreOpen ? 'text-brand' : 'text-muted hover:text-ink'
              }`}
            >
              {isOverflowActive && <span className="absolute top-0 w-8 h-0.5 rounded-full bg-brand" />}
              <MoreHorizontal size={19} strokeWidth={isOverflowActive ? 2.4 : 1.9} />
              <span>More</span>
            </button>
          )}
        </div>
      </nav>

      {/* Mobile "More" Drawer for secondary destinations & account actions */}
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} surface="admin" size="sm" title={currentTab?.label ? 'More sections' : 'Menu'}>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 gap-1.5">
            {mobileOverflowTabs.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => setMoreOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-3.5 rounded-btn text-sm font-bold transition ${
                    isActive ? 'bg-brand text-on-brand shadow-xs' : 'bg-soft text-ink hover:bg-gray-100'
                  }`
                }
              >
                <Icon size={18} />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>

          <div className="border-t border-line pt-3 space-y-1.5">
            <Link
              to="/"
              onClick={() => setMoreOpen(false)}
              className="flex items-center justify-between px-4 py-3 rounded-btn text-sm font-semibold text-brand bg-accent/60 hover:bg-accent"
            >
              <span>Open customer storefront</span>
              <ExternalLink size={16} />
            </Link>
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false);
                logout();
              }}
              className="w-full flex items-center justify-between px-4 py-3 rounded-btn text-sm font-semibold text-red-600 hover:bg-red-50"
            >
              <span>Sign out {userProfile?.email ? `(${userProfile.email})` : ''}</span>
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </Sheet>
    </div>
  );
};
