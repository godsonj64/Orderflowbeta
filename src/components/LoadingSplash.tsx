import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../context/StoreContext';
import { SURFACES, themeStyle } from '../lib/theme';
import Logo from './Logo';

interface LoadingSplashProps {
  /** Whether to wait for the menu catalog in addition to the restaurant profile. */
  waitForMenu?: boolean;
}

/**
 * Auto-scaling display title for the splash screen so short names ("TRIO") and long
 * names ("Huddle Snack Stop") always fit cleanly at hero scale.
 */
function AutoFitSplashTitle({ name }: { name: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    const fit = () => {
      const availableWidth = container.clientWidth;
      if (!availableWidth) return;
      const maxPx = Math.min(92, Math.max(42, Math.floor(availableWidth * 0.2)));
      const minPx = 28;
      text.style.whiteSpace = 'nowrap';
      text.style.fontSize = `${maxPx}px`;
      const measured = text.scrollWidth;
      if (measured > availableWidth && measured > 0) {
        const scaled = Math.floor(maxPx * (availableWidth / measured) * 0.96);
        if (scaled < minPx) {
          text.style.fontSize = `${minPx}px`;
          text.style.whiteSpace = 'normal';
        } else {
          text.style.fontSize = `${scaled}px`;
        }
      }
    };

    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(container);
    if (document.fonts?.ready) {
      document.fonts.ready.then(fit).catch(() => undefined);
    }
    return () => ro?.disconnect();
  }, [name]);

  return (
    <div ref={containerRef} className="w-full overflow-hidden text-center px-2">
      <h1
        ref={textRef}
        className="font-display font-extrabold tracking-tight leading-[0.95] text-ink inline-block max-w-full select-none text-5xl sm:text-7xl"
      >
        {name}
      </h1>
    </div>
  );
}

let initialSplashCompleted = false;

/**
 * Full-viewport branded loading splash screen that displays the Restaurant Name,
 * subtitles (tagline / description), and "Powered by OrderFlow" while the live
 * store profile and menu catalog finish loading—preventing any flash of the
 * unpopulated base template.
 */
export const LoadingSplash: React.FC<LoadingSplashProps> = ({ waitForMenu = true }) => {
  const { profile, profileLoading, menuLoading, status, theme } = useStore();
  const hasProfile = !!profile?.name;
  const dataReady = !profileLoading && (!waitForMenu || !menuLoading) && hasProfile;

  // When profile + menu are already ready on mount (from localStorage cache or pre-fetched
  // /api/config), skip the splash immediately for an instant, zero-delay storefront render.
  const [minTimeReached, setMinTimeReached] = useState(() => initialSplashCompleted || dataReady);
  const [safetyTimeoutReached, setSafetyTimeoutReached] = useState(false);
  const [fadingOut, setFadingOut] = useState(false);
  const [unmounted, setUnmounted] = useState(() => {
    if (dataReady) {
      initialSplashCompleted = true;
      return true;
    }
    return false;
  });

  // Once the restaurant profile is available on a cold visit, hold for a crisp 120ms beat
  // so the Restaurant Name and subtitles read cleanly without flickering.
  useEffect(() => {
    if (!hasProfile || minTimeReached) return;
    const timer = window.setTimeout(() => {
      setMinTimeReached(true);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [hasProfile, minTimeReached]);

  // Safety ceiling so slow or offline networks never block the user indefinitely.
  useEffect(() => {
    if (unmounted) return;
    const timer = window.setTimeout(() => {
      setSafetyTimeoutReached(true);
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [unmounted]);

  const readyToDismiss = (dataReady && minTimeReached) || safetyTimeoutReached;

  useEffect(() => {
    if (!readyToDismiss || unmounted) return;
    initialSplashCompleted = true;
    setFadingOut(true);
    const timer = window.setTimeout(() => {
      setUnmounted(true);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [readyToDismiss, unmounted]);

  if (unmounted) return null;

  const restaurantName = profile?.name?.trim() || '';
  const primarySubtitle =
    theme.tagline?.trim() ||
    profile?.description?.trim() ||
    profile?.marqueeText?.trim() ||
    '';
  const secondarySubtitle =
    profile?.address?.trim() ||
    (hasProfile && status.badge ? `${status.badge}${status.detail ? ` · ${status.detail}` : ''}` : '');

  const surface = SURFACES[theme.mode] || SURFACES.light;

  return (
    <div
      style={themeStyle(theme)}
      role="status"
      aria-live="polite"
      aria-label={restaurantName ? `Loading ${restaurantName}` : 'Loading store'}
      className={`fixed inset-0 z-[100] bg-page text-ink font-sans flex flex-col justify-between px-6 py-8 sm:py-12 select-none transition-all duration-200 ease-out ${
        fadingOut ? 'opacity-0 scale-[1.01] pointer-events-none' : 'opacity-100 scale-100'
      }`}
    >
      {/* Top spacer to keep the brand lockup optically centered */}
      <div className="h-8 shrink-0" aria-hidden="true" />

      {/* Center Brand Lockup: Logo, Restaurant Name, Subtitles & Progress Line */}
      <div className="my-auto max-w-2xl w-full mx-auto text-center flex flex-col items-center space-y-4">
        {hasProfile ? (
          <>
            {profile?.logoUrl ? (
              <img
                src={profile.logoUrl}
                alt={restaurantName}
                referrerPolicy="no-referrer"
                className="w-20 h-20 sm:w-24 sm:h-24 rounded-full object-cover border border-line shadow-ios mb-1"
              />
            ) : (
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-brand text-on-brand flex items-center justify-center font-display font-extrabold text-2xl sm:text-3xl shadow-ios mb-1">
                {restaurantName.charAt(0).toUpperCase()}
              </div>
            )}

            <AutoFitSplashTitle name={restaurantName} />

            {primarySubtitle && (
              <p className="text-sm sm:text-base text-muted max-w-md mx-auto leading-relaxed line-clamp-3">
                {primarySubtitle}
              </p>
            )}

            {secondarySubtitle && (
              <p className="text-xs font-semibold text-brand/90 tracking-wide">
                {secondarySubtitle}
              </p>
            )}
          </>
        ) : (
          <div className="h-28 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full border-2 border-line border-t-brand animate-spin" />
          </div>
        )}

        {/* Smooth Brand Loading Bar */}
        <div className="pt-3 w-40 sm:w-48 mx-auto">
          <div className="h-1 w-full rounded-full bg-soft overflow-hidden relative">
            <div className="h-full w-1/2 rounded-full bg-brand animate-splash-progress" />
          </div>
        </div>
      </div>

      {/* Bottom Attribution: Powered by OrderFlow */}
      <div className="shrink-0 pt-6 pb-[env(safe-area-inset-bottom)] flex flex-col items-center justify-center gap-1.5 text-muted">
        <div className="inline-flex items-center gap-2 text-xs sm:text-sm font-semibold tracking-wide">
          <span>Powered by</span>
          <Logo
            className="h-5 sm:h-6 w-auto text-ink"
            textFill="currentColor"
            cutoutFill={surface.page}
          />
        </div>
      </div>
    </div>
  );
};
