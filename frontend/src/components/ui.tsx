'use client';

import { ReactNode } from 'react';
import type { Caveat, FieldStatus, Freshness } from '@/lib/types';

/* ------------------------------------------------------------------ icons */
/* Hand-rolled so the bundle carries no icon library. NFR-2 caps the initial
   page at 200KB, and our primary users buy data in small bundles. */

type IconProps = { className?: string };
const base = 'h-4 w-4 shrink-0';

export const Icon = {
  search: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={p.className ?? base}>
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  ),
  arrow: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  back: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  ),
  check: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  ),
  info: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={p.className ?? base}>
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.6v.1" />
    </svg>
  ),
  warn: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M10.3 3.7 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17v.1" />
    </svg>
  ),
  doc: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" />
    </svg>
  ),
  steps: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className={p.className ?? base}>
      <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><path d="M6 8.4v7.2M11 6h7M11 18h7" />
    </svg>
  ),
  cash: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className={p.className ?? base}>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" /><circle cx="12" cy="12" r="2.6" />
    </svg>
  ),
  pin: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M20 10c0 5.5-8 12-8 12s-8-6.5-8-12a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.6" />
    </svg>
  ),
  link: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M10 13a5 5 0 0 0 7.1.1l2.8-2.8a5 5 0 0 0-7.1-7.1L11.5 4.5" />
      <path d="M14 11a5 5 0 0 0-7.1-.1L4.1 13.7a5 5 0 0 0 7.1 7.1l1.2-1.2" />
    </svg>
  ),
  clock: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className={p.className ?? base}>
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5.3l3.3 2" />
    </svg>
  ),
  print: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2" />
      <path d="M6 14h12v7H6z" />
    </svg>
  ),
  share: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><path d="M12 15V3M8 7l4-4 4 4" />
    </svg>
  ),
  save: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3h8L19 7.5v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5Z" />
      <path d="M8 3v5h6M8 14h8v7H8z" />
    </svg>
  ),
  sun: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className={p.className ?? base}>
      <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  ),
  moon: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  ),
  spark: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  ),
  shield: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M12 3 4.5 6v6c0 4.6 3.2 8.3 7.5 9 4.3-.7 7.5-4.4 7.5-9V6Z" /><path d="m9 12 2 2 4-4" />
    </svg>
  ),
  chevron: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="m7 9 5 5 5-5" />
    </svg>
  ),
  building: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M4 21V6l8-3 8 3v15" /><path d="M9 21v-5h6v5M9 10h.01M15 10h.01M9 13.5h.01M15 13.5h.01" />
    </svg>
  ),
  chat: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" />
    </svg>
  ),
  refresh: (p: IconProps) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={p.className ?? base}>
      <path d="M20 5v5h-5" /><path d="M4 19v-5h5" /><path d="M20 10a8 8 0 0 0-14-3.5L4 10M4 14a8 8 0 0 0 14 3.5L20 14" />
    </svg>
  ),
};

/* --------------------------------------------------------------- badges */

/**
 * The status badge is the most important piece of UI in the product.
 * It is how "the institution does not publish this" stops looking like a
 * gap in our data and starts looking like the fact it is.
 */
const STATUS_STYLES: Record<FieldStatus, { label: string; cls: string; title: string }> = {
  confirmed: {
    label: 'Official',
    cls: 'bg-brand-50 text-brand-700 border-brand-200 dark:bg-brand-900/40 dark:text-brand-200 dark:border-brand-700',
    title: 'Stated by an official source, which is linked below.',
  },
  secondary: {
    label: 'Reported',
    cls: 'bg-paper-sunk text-ink-soft border-ink-line dark:bg-night-sunk dark:text-night-soft dark:border-night-line',
    title: 'Reported by a credible source, but not published by the institution itself.',
  },
  not_published: {
    label: 'Not published',
    cls: 'bg-paper-sunk text-ink-faint border-dashed border-ink-line dark:bg-night-sunk dark:text-night-faint dark:border-night-line',
    title: 'The institution publishes no figure for this. We will not invent one.',
  },
  varies_by_locality: {
    label: 'Varies locally',
    cls: 'bg-ochre-100 text-ochre-700 border-ochre-300 dark:bg-ochre-700/25 dark:text-ochre-300 dark:border-ochre-700',
    title: 'Each Assembly sets its own rate, so no national figure exists.',
  },
  disputed: {
    label: 'Sources disagree',
    cls: 'bg-red-50 text-flag-bad border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
    title: 'Two official sources give different answers. Both are shown.',
  },
};

export function StatusBadge({ status }: { status: FieldStatus }) {
  if (status === 'confirmed') return null; // the default needs no decoration
  const s = STATUS_STYLES[status];
  return (
    <span
      title={s.title}
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-2xs font-semibold ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

export function FreshnessBadge({
  freshness,
  reviewed,
}: {
  freshness: Freshness;
  reviewed: string | null;
}) {
  const map = {
    fresh: { text: 'Checked recently', cls: 'text-brand-700 dark:text-brand-300', dot: 'bg-brand-500' },
    verify: { text: 'Verify before you travel', cls: 'text-ochre-700 dark:text-ochre-300', dot: 'bg-ochre-500' },
    stale: { text: 'Out of date — confirm at source', cls: 'text-flag-bad dark:text-red-300', dot: 'bg-flag-bad' },
  }[freshness];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${map.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${map.dot}`} />
      {map.text}
      {reviewed && <span className="muted font-normal">· team-verified {reviewed}</span>}
    </span>
  );
}

export function ConfidenceMeter({ level }: { level: 'high' | 'medium' | 'low' }) {
  const filled = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
  const colour =
    level === 'high' ? 'bg-brand-500' : level === 'medium' ? 'bg-ochre-500' : 'bg-flag-mute';
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`Confidence is derived from coverage, citation checks and freshness — it is never asserted by a model.`}
    >
      <span className="label">Confidence</span>
      <span className="flex gap-0.5" aria-label={`${level} confidence`}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-3 w-1.5 rounded-sm ${i < filled ? colour : 'bg-ink-line dark:bg-night-line'}`}
          />
        ))}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------- callouts */

const CAVEAT_STYLE: Record<Caveat['kind'], { cls: string; label: string }> = {
  freshness: { cls: 'border-ochre-300 bg-ochre-100/60 dark:bg-ochre-700/15 dark:border-ochre-700', label: 'Check the date' },
  dispute: { cls: 'border-red-200 bg-red-50/70 dark:bg-red-950/25 dark:border-red-900', label: 'Sources disagree' },
  locality: { cls: 'border-ochre-300 bg-ochre-100/60 dark:bg-ochre-700/15 dark:border-ochre-700', label: 'Depends on your Assembly' },
  coverage: { cls: 'border-ink-line bg-paper-sunk dark:bg-night-sunk dark:border-night-line', label: 'What we could not confirm' },
  eligibility: { cls: 'border-ink-line bg-paper-sunk dark:bg-night-sunk dark:border-night-line', label: 'Depends on your situation' },
  scope: { cls: 'border-ink-line bg-paper-sunk dark:bg-night-sunk dark:border-night-line', label: 'Worth knowing' },
};

export function CaveatCard({ caveat, showLabel = true }: { caveat: Caveat; showLabel?: boolean }) {
  const s = CAVEAT_STYLE[caveat.kind] ?? CAVEAT_STYLE.scope;
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${s.cls}`}>
      {showLabel && (
        <div className="mb-1 flex items-center gap-1.5">
          <Icon.warn className="h-3.5 w-3.5 opacity-70" />
          <span className="label !text-ink-soft dark:!text-night-soft">{s.label}</span>
        </div>
      )}
      <p className="text-sm leading-relaxed soft text-pretty">{caveat.text}</p>
    </div>
  );
}

export function Section({
  title,
  icon,
  count,
  children,
  action,
  variant = 'plain',
}: {
  title: string;
  icon?: ReactNode;
  count?: number;
  children: ReactNode;
  action?: ReactNode;
  /** "primary" = this is the thing the person actually asked for. */
  variant?: 'plain' | 'primary';
}) {
  if (variant === 'primary') {
    return (
      <Primary title={title} icon={icon} count={count} action={action}>
        {children}
      </Primary>
    );
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-bold tracking-tight">
          {icon}
          {title}
          {count !== undefined && (
            <span className="rounded-full bg-paper-sunk px-2 py-0.5 text-2xs font-semibold muted dark:bg-night-sunk">
              {count}
            </span>
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The answer itself, as opposed to everything that surrounds it.
 *
 * A service card carries two very different kinds of content: what you must
 * actually DO (bring these documents, follow these steps, pay this, go here),
 * and the material that qualifies it (caveats, sources, validator report,
 * related services). All of it matters, but only the first kind is what the
 * person asked for. Giving it a tinted panel with a filled icon and white
 * rows inside makes it findable in one glance; everything else stays on the
 * plain background and reads as supporting.
 */
export function Primary({
  title,
  icon,
  count,
  children,
  action,
}: {
  title: string;
  icon?: ReactNode;
  count?: number;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-brand-200 bg-brand-50/70 p-4 dark:border-brand-800/70 dark:bg-brand-900/20 sm:p-5">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className="flex items-center gap-2.5 text-[15px] font-bold tracking-tight sm:text-base">
          {icon && (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white shadow-[0_4px_10px_-4px_rgba(79,70,229,.6)]">
              {icon}
            </span>
          )}
          {title}
          {count !== undefined && (
            <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-2xs font-bold text-brand-700 dark:text-brand-200">
              {count}
            </span>
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A heading for the supporting material, so the boundary is explicit. */
export function SupportingHeading({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="label whitespace-nowrap">{text}</span>
      <span className="h-px flex-1 bg-ink-line dark:bg-night-line" />
    </div>
  );
}

export function Empty({ title, body, icon }: { title: string; body: string; icon?: ReactNode }) {
  return (
    <div className="surface-sunk flex flex-col items-center gap-2 px-6 py-10 text-center">
      {icon && <div className="muted">{icon}</div>}
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-sm text-sm soft text-pretty">{body}</p>
    </div>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
