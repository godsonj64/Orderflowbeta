import React, { useLayoutEffect, useRef } from 'react';
import toast, { Toaster, resolveValue, type Toast } from 'react-hot-toast';
import { AlertTriangle, Check, Info, Sparkles, X } from 'lucide-react';

export type BannerTone = 'emerald' | 'aqua' | 'heat' | 'rust' | 'crimson' | 'cream' | 'iron';
export type BannerPattern = 'waves' | 'checker' | 'slashes' | 'contours';

interface ToneConfig {
  /** Solid left accent block background */
  accentBg: string;
  /** Text color on the left accent block */
  accentText: string;
  /** Main body background */
  bodyBg: string;
  /** Main headline color */
  headlineText: string;
  /** Subtitle / secondary text color */
  subText: string;
  /** Optional kicker color */
  kickerText: string;
  /** Action button classes */
  actionCls: string;
  /** Right strip pattern stroke/fill color */
  patternInk: string;
}

/**
 * Inspired by the Industrial Swatch & Woven Label reference palettes:
 * - Iron Core (#111315 / #222A2A)
 * - Industrial Aqua (#4FBBBC)
 * - Rust Signal (#EC4624)
 * - Heat Marker (#F39120)
 * - Architectural Cream (#E2DAC2)
 * - Cyber Crimson (#D6281B)
 * - Kitchen Emerald (#16A34A)
 */
export const BANNER_TONES: Record<BannerTone, ToneConfig> = {
  emerald: {
    accentBg: 'bg-[#16A34A]',
    accentText: 'text-white',
    bodyBg: 'bg-[#111315]',
    headlineText: 'text-white',
    subText: 'text-neutral-300',
    kickerText: 'text-[#4ADE80]',
    actionCls: 'bg-white/10 hover:bg-white/20 text-white border border-white/15',
    patternInk: 'text-[#111315]',
  },
  aqua: {
    accentBg: 'bg-[#4FBBBC]',
    accentText: 'text-[#111315]',
    bodyBg: 'bg-[#161D1E]',
    headlineText: 'text-white',
    subText: 'text-neutral-300',
    kickerText: 'text-[#4FBBBC]',
    actionCls: 'bg-[#4FBBBC]/15 hover:bg-[#4FBBBC]/25 text-[#4FBBBC] border border-[#4FBBBC]/30',
    patternInk: 'text-[#161D1E]',
  },
  heat: {
    accentBg: 'bg-[#F39120]',
    accentText: 'text-[#111315]',
    bodyBg: 'bg-[#141618]',
    headlineText: 'text-white',
    subText: 'text-neutral-300',
    kickerText: 'text-[#F39120]',
    actionCls: 'bg-[#F39120] hover:opacity-95 text-[#111315] font-extrabold',
    patternInk: 'text-[#141618]',
  },
  rust: {
    accentBg: 'bg-[#EC4624]',
    accentText: 'text-white',
    bodyBg: 'bg-[#111315]',
    headlineText: 'text-white',
    subText: 'text-neutral-300',
    kickerText: 'text-[#FF7A5C]',
    actionCls: 'bg-white/10 hover:bg-white/20 text-white border border-white/15',
    patternInk: 'text-[#111315]',
  },
  crimson: {
    accentBg: 'bg-[#D6281B]',
    accentText: 'text-white',
    bodyBg: 'bg-[#111315]',
    headlineText: 'text-white',
    subText: 'text-neutral-300',
    kickerText: 'text-[#F87171]',
    actionCls: 'bg-white/10 hover:bg-white/20 text-white border border-white/15',
    patternInk: 'text-[#111315]',
  },
  cream: {
    accentBg: 'bg-[#EC4624]',
    accentText: 'text-[#E2DAC2]',
    bodyBg: 'bg-[#E2DAC2]',
    headlineText: 'text-[#181E1E]',
    subText: 'text-[#222A2A]/80',
    kickerText: 'text-[#EC4624]',
    actionCls: 'bg-[#222A2A] hover:opacity-90 text-[#E2DAC2]',
    patternInk: 'text-[#E2DAC2]',
  },
  iron: {
    accentBg: 'bg-[#F39120]',
    accentText: 'text-[#111315]',
    bodyBg: 'bg-[#222A2A]',
    headlineText: 'text-white',
    subText: 'text-neutral-300',
    kickerText: 'text-[#F39120]',
    actionCls: 'bg-white/10 hover:bg-white/20 text-white border border-white/15',
    patternInk: 'text-[#222A2A]',
  },
};

export function BannerPatternGraphic({
  pattern = 'waves',
  className = '',
}: {
  pattern?: BannerPattern;
  className?: string;
}) {
  if (pattern === 'checker') {
    return (
      <svg viewBox="0 0 48 160" preserveAspectRatio="none" className={`w-full h-full ${className}`} fill="currentColor">
        {Array.from({ length: 10 }).map((_, row) =>
          Array.from({ length: 3 }).map((__, col) => {
            if ((row + col) % 2 !== 0) return null;
            return <rect key={`${row}-${col}`} x={col * 16} y={row * 16} width="16" height="16" />;
          }),
        )}
      </svg>
    );
  }

  if (pattern === 'slashes') {
    return (
      <svg viewBox="0 0 60 160" preserveAspectRatio="none" className={`w-full h-full ${className}`} fill="none">
        <path d="M-10 20 L70 -10 M-10 44 L70 14 M-10 68 L70 38 M-10 92 L70 62 M-10 116 L70 86 M-10 140 L70 110 M-10 164 L70 134 M-10 188 L70 158" stroke="currentColor" strokeWidth="4.5" />
      </svg>
    );
  }

  if (pattern === 'contours') {
    return (
      <svg viewBox="0 0 60 160" preserveAspectRatio="none" className={`w-full h-full ${className}`} fill="none">
        <path d="M8 -10 C 42 25, 10 65, 44 100 C 65 122, 18 145, 38 170" stroke="currentColor" strokeWidth="3.2" />
        <path d="M22 -10 C 56 25, 24 65, 58 100 C 75 122, 32 145, 52 170" stroke="currentColor" strokeWidth="2.4" />
        <path d="M-6 -10 C 28 25, -4 65, 30 100 C 50 122, 4 145, 24 170" stroke="currentColor" strokeWidth="2.4" />
      </svg>
    );
  }

  // Default: topographic waves (matching the Restaurant Closed banner)
  return (
    <svg viewBox="0 0 60 160" preserveAspectRatio="none" className={`w-full h-full ${className}`} fill="none">
      <path d="M-10 12 C 15 0, 25 32, 45 22 C 55 17, 62 28, 70 25" stroke="currentColor" strokeWidth="2.4" />
      <path d="M-10 28 C 12 14, 24 50, 44 38 C 54 32, 62 44, 70 40" stroke="currentColor" strokeWidth="2.4" />
      <path d="M-10 46 C 14 28, 22 68, 42 56 C 54 48, 60 62, 70 58" stroke="currentColor" strokeWidth="2.8" />
      <path d="M-10 66 C 12 46, 20 88, 40 76 C 52 68, 60 82, 70 78" stroke="currentColor" strokeWidth="2.4" />
      <path d="M-10 86 C 10 68, 22 108, 42 96 C 54 88, 62 102, 70 98" stroke="currentColor" strokeWidth="3.0" />
      <path d="M-10 106 C 12 88, 24 128, 44 116 C 54 108, 62 122, 70 118" stroke="currentColor" strokeWidth="2.4" />
      <path d="M-10 126 C 14 110, 26 146, 46 136 C 56 130, 62 142, 70 138" stroke="currentColor" strokeWidth="2.4" />
      <path d="M-10 146 C 16 132, 28 164, 48 154 C 58 148, 64 158, 70 156" stroke="currentColor" strokeWidth="2.4" />
    </svg>
  );
}

/**
 * Automatically scales a metric/code string (like `#UG6YNY`, `$1,240.00`, or `OFF`)
 * so it always fits inside its solid accent block with zero clipping or overflow.
 */
export const AutoFitBadgeText: React.FC<{
  children: React.ReactNode;
  maxPx?: number;
  minPx?: number;
  className?: string;
}> = ({ children, maxPx = 24, minPx = 10, className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  const flatText = React.Children.toArray(children)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('')
    .trim();
  const strLen = flatText.length || 5;

  const initialPx =
    strLen <= 4
      ? maxPx
      : strLen <= 6
        ? Math.max(minPx, Math.round(maxPx * 0.78))
        : strLen <= 8
          ? Math.max(minPx, Math.round(maxPx * 0.64))
          : Math.max(minPx, Math.round(maxPx * 0.52));

  useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    const fit = () => {
      const available = container.clientWidth;
      if (!available) return;
      let currentPx = initialPx;
      text.style.fontSize = `${currentPx}px`;
      const measured = text.scrollWidth;
      if (measured > available && measured > 0) {
        currentPx = Math.max(minPx, Math.floor(initialPx * (available / measured) * 0.92));
        text.style.fontSize = `${currentPx}px`;
        while (text.scrollWidth > available && currentPx > minPx) {
          currentPx -= 1;
          text.style.fontSize = `${currentPx}px`;
        }
      }
    };

    fit();
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(fit).catch(() => undefined);
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(container);
    return () => ro?.disconnect();
  }, [children, flatText, initialPx, minPx]);

  return (
    <div ref={containerRef} className="w-full overflow-hidden flex items-center justify-center">
      <span
        ref={textRef}
        style={{ fontSize: `${initialPx}px` }}
        className={`font-display font-black tracking-tight leading-none whitespace-nowrap tabular-nums inline-block ${className}`}
      >
        {children}
      </span>
    </div>
  );
};

export interface StatusBannerProps {
  tone?: BannerTone;
  pattern?: BannerPattern;
  /** Bold metric / short code in the left solid block (e.g. "#1042", "SENT", "LIVE", "HOLD") */
  metric: React.ReactNode;
  /** Tracked micro-label below the metric in the left solid block (e.g. "KITCHEN", "DRIVER GPS", "CASH DUE") */
  metricLabel?: string;
  /** Optional small uppercase kicker above the main title */
  kicker?: string;
  /** Primary bold headline */
  title: React.ReactNode;
  /** Optional descriptive subtext */
  subtitle?: React.ReactNode;
  /** Optional right-side interactive control or link */
  action?: React.ReactNode;
  /** Compact density for tight cards / drawers */
  compact?: boolean;
  className?: string;
  role?: 'status' | 'alert';
}

/**
 * Solid architectural split-block banner inspired by the Restaurant Closed banner
 * and the Industrial Swatch / Woven Label reference cards.
 */
export const StatusBanner: React.FC<StatusBannerProps> = ({
  tone = 'emerald',
  pattern = 'waves',
  metric,
  metricLabel,
  kicker,
  title,
  subtitle,
  action,
  compact = false,
  className = '',
  role = 'status',
}) => {
  const cfg = BANNER_TONES[tone];

  return (
    <div
      role={role}
      className={`flex items-stretch overflow-hidden rounded-card ${cfg.bodyBg} shadow-lg ${className}`}
    >
      {/* Left Solid Metric / Code Block (auto-fits codes like #UG6YNY without clipping) */}
      <div
        className={`${
          compact ? 'w-24 sm:w-28 px-2.5 py-3' : 'w-28 sm:w-34 px-3 sm:px-3.5 py-4 sm:py-5'
        } shrink-0 ${cfg.accentBg} ${cfg.accentText} flex flex-col items-center justify-center text-center select-none overflow-hidden`}
      >
        <AutoFitBadgeText maxPx={compact ? 19 : 26} minPx={11}>
          {metric}
        </AutoFitBadgeText>
        {metricLabel && (
          <span className="mt-1.5 text-[8.5px] sm:text-[9.5px] font-extrabold uppercase tracking-[0.14em] opacity-95 leading-tight max-w-full truncate">
            {metricLabel}
          </span>
        )}
      </div>

      {/* Center Solid Message & Action Block */}
      <div
        className={`flex-1 min-w-0 ${
          compact ? 'px-3.5 sm:px-5 py-3' : 'px-4 sm:px-6 py-3.5 sm:py-4.5'
        } flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-5 ${cfg.bodyBg}`}
      >
        <div className="min-w-0 space-y-0.5">
          {kicker && (
            <p className={`text-[10px] font-extrabold uppercase tracking-[0.16em] ${cfg.kickerText}`}>
              {kicker}
            </p>
          )}
          <div
            className={`font-display ${
              compact ? 'text-xs sm:text-sm' : 'text-sm sm:text-lg'
            } font-extrabold ${cfg.headlineText} leading-snug tracking-tight break-words`}
          >
            {title}
          </div>
          {subtitle && (
            <div className={`text-xs sm:text-sm ${cfg.subText} leading-relaxed max-w-2xl break-words`}>
              {subtitle}
            </div>
          )}
        </div>

        {action && <div className="shrink-0 self-start sm:self-center">{action}</div>}
      </div>

      {/* Right Decorative Pattern Strip */}
      <div
        className={`hidden sm:block ${compact ? 'w-6 sm:w-8' : 'w-8 sm:w-12'} shrink-0 ${cfg.accentBg} relative overflow-hidden`}
        aria-hidden="true"
      >
        <div className={`absolute inset-0 ${cfg.patternInk}`}>
          <BannerPatternGraphic pattern={pattern} />
        </div>
      </div>
    </div>
  );
};

/**
 * Custom global Toaster that transforms every `toast.success`, `toast.error`,
 * `toast(...)`, and `undoToast` notification into a solid split-block banner.
 */
export const SolidToaster: React.FC = () => {
  return (
    <Toaster
      position="top-center"
      gutter={10}
      containerStyle={{ top: 'max(14px, env(safe-area-inset-top))' }}
      toastOptions={{ duration: 4000 }}
    >
      {(t: Toast) => {
        const isError = t.type === 'error';
        const isSuccess = t.type === 'success';
        const isLoading = t.type === 'loading';

        const accentBg = isError
          ? 'bg-[#EC4624]'
          : isSuccess
            ? 'bg-[#16A34A]'
            : isLoading
              ? 'bg-[#F39120]'
              : 'bg-[#4FBBBC]';

        const accentText = isError || isSuccess ? 'text-white' : 'text-[#111315]';
        const badgeLabel = isError ? 'ALERT' : isSuccess ? 'DONE' : isLoading ? 'WAIT' : 'NOTICE';
        const pattern: BannerPattern = isError ? 'slashes' : isSuccess ? 'waves' : 'checker';

        return (
          <div
            className={`${
              t.visible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-2 scale-95'
            } transition-all duration-150 max-w-md w-full flex items-stretch overflow-hidden rounded-card bg-[#111315] text-white shadow-2xl border border-white/10 pointer-events-auto`}
            role={isError ? 'alert' : 'status'}
          >
            {/* Left Solid Status Block */}
            <div
              className={`w-16 sm:w-20 shrink-0 ${accentBg} ${accentText} px-2 py-2.5 flex flex-col items-center justify-center text-center select-none`}
            >
              {isError ? (
                <AlertTriangle size={16} strokeWidth={2.6} />
              ) : isSuccess ? (
                <Check size={16} strokeWidth={3} />
              ) : isLoading ? (
                <Sparkles size={16} strokeWidth={2.4} />
              ) : (
                <Info size={16} strokeWidth={2.5} />
              )}
              <span className="mt-1 text-[9px] font-black uppercase tracking-[0.16em] leading-none">
                {badgeLabel}
              </span>
            </div>

            {/* Center Solid Message Block */}
            <div className="flex-1 min-w-0 px-3.5 py-2.5 flex items-center justify-between gap-2 bg-[#111315]">
              <div className="flex-1 text-xs sm:text-sm font-bold text-white leading-snug break-words min-w-0">
                {resolveValue(t.message, t)}
              </div>
              <button
                type="button"
                onClick={() => toast.dismiss(t.id)}
                className="shrink-0 w-7 h-7 rounded-lg text-neutral-400 hover:text-white hover:bg-white/10 flex items-center justify-center transition"
                aria-label="Dismiss notification"
              >
                <X size={14} />
              </button>
            </div>

            {/* Right Pattern Strip */}
            <div className={`w-4 sm:w-5 shrink-0 ${accentBg} relative overflow-hidden`} aria-hidden="true">
              <div className="absolute inset-0 text-[#111315]">
                <BannerPatternGraphic pattern={pattern} />
              </div>
            </div>
          </div>
        );
      }}
    </Toaster>
  );
};
