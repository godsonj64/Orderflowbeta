import { useEffect, useRef } from 'react';

export const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

/**
 * Keeps the screen on while `wanted` is true (kitchen displays, drivers sharing GPS -
 * phones stop reporting location when the screen locks). The lock is released by the
 * browser whenever the tab is hidden, so it is re-acquired when the tab is shown again.
 * `onUnavailable` fires when the browser refuses (e.g. battery saver).
 */
export function useWakeLock(wanted: boolean, onUnavailable?: () => void) {
  const lock = useRef<any>(null);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    if (!wanted || !wakeLockSupported) return;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const sentinel = await (navigator as any).wakeLock.request('screen');
        if (cancelled) sentinel.release?.().catch(() => undefined);
        else lock.current = sentinel;
      } catch {
        if (!cancelled) onUnavailableRef.current?.();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock.current?.release?.().catch(() => undefined);
      lock.current = null;
    };
  }, [wanted]);

  return wakeLockSupported;
}
