'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getSystem } from '@/lib/api';
import type { SystemInfo } from '@/lib/types';
import { Icon } from './ui';

/**
 * Wordmark. Deliberately not a coat of arms and not the national colours.
 *
 * Sized to outrank the navigation: on a page full of official-looking
 * information, the one thing that must never be ambiguous is whose service
 * this is.
 */
function Mark({ size = 'md' }: { size?: 'md' | 'sm' }) {
  const big = size === 'md';
  return (
    <span className="flex items-center gap-2.5">
      <span
        className={`relative flex shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white shadow-[0_5px_14px_-4px_rgba(11,127,107,.85)] ${
          big ? 'h-11 w-11' : 'h-9 w-9'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ height: big ? 25 : 20, width: big ? 25 : 20 }}
        >
          <path d="M12 21s7-5.2 7-10.5A7 7 0 0 0 5 10.5C5 15.8 12 21 12 21Z" />
          <path d="m9.2 10.6 1.9 1.9 3.7-3.9" />
        </svg>
      </span>
      <span className="leading-none">
        <span
          className={`block font-extrabold tracking-tight ${big ? 'text-lg sm:text-xl' : 'text-[15px]'}`}
        >
          GovNavigator
        </span>
        <span
          className={`mt-0.5 block font-bold uppercase tracking-[0.16em] text-brand-600 dark:text-brand-300 ${
            big ? 'text-[11px]' : 'text-2xs'
          }`}
        >
          Ghana
        </span>
      </span>
    </span>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem('gn.theme');
    } catch {
      /* private browsing */
    }
    const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = stored ? stored === 'dark' : prefers;
    setDark(isDark);
    document.documentElement.classList.toggle('dark', isDark);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      window.localStorage.setItem('gn.theme', next ? 'dark' : 'light');
    } catch {
      /* nothing to do */
    }
  }

  return (
    <button onClick={toggle} className="btn-quiet !px-2.5" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
      {dark ? <Icon.sun /> : <Icon.moon />}
    </button>
  );
}

const NAV = [
  { href: '/', label: 'Ask' },
  { href: '/services', label: 'All services' },
  { href: '/institutions', label: 'Institutions' },
  { href: '/saved', label: 'Saved' },
];

export function Header() {
  const pathname = usePathname();
  return (
    <header className="no-print sticky top-0 z-40 border-b hairline bg-paper/85 backdrop-blur-md dark:bg-night/85">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
        <Link href="/" className="shrink-0" aria-label="GovNavigator Ghana — home">
          <Mark />
        </Link>
        <div className="ml-auto order-last w-full sm:order-none sm:w-auto" />
        <nav className="scroll-x order-last -mx-1 flex w-full items-center gap-0.5 px-1 sm:order-none sm:mx-0 sm:w-auto sm:px-0">
          {NAV.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                  active
                    ? 'bg-paper-sunk text-ink dark:bg-night-sunk dark:text-night-text'
                    : 'text-ink-soft hover:text-ink dark:text-night-soft dark:hover:text-night-text'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * The independence marker is persistent and deliberate. A product mistaken
 * for an official channel borrows authority it has not earned and misleads
 * people about who they can hold responsible.
 */
export function IndependenceBar() {
  return (
    <div className="border-b hairline bg-paper-sunk dark:bg-night-sunk">
      <p className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-1.5 text-2xs font-medium muted">
        <Icon.info className="h-3 w-3 shrink-0" />
        <span className="text-pretty">
          Independent public-information service. <strong className="font-semibold">Not a government agency</strong> — always
          confirm at the official source before you travel or pay.
        </span>
      </p>
    </div>
  );
}

export function Footer() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  useEffect(() => {
    getSystem().then(setSystem).catch(() => setSystem(null));
  }, []);

  return (
    <footer className="no-print mt-16 border-t hairline">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <div className="grid gap-6 sm:grid-cols-3">
          <div>
            <Mark size="sm" />
            <p className="mt-2.5 max-w-xs text-xs soft text-pretty">
              Turns what you want to do into the institution, requirements, cost and steps the State
              actually requires — with a citation on every claim.
            </p>
          </div>
          <div>
            <p className="label mb-2">What this is not</p>
            <ul className="space-y-1 text-xs soft">
              <li>Not a government website</li>
              <li>Not legal, tax or immigration advice</li>
              <li>It does not apply or pay on your behalf</li>
              <li>It never stores your Ghana Card or TIN</li>
            </ul>
          </div>
          <div>
            <p className="label mb-2">How it answers</p>
            <ul className="space-y-1 text-xs soft">
              <li>Only from official sources it can cite</li>
              <li>It declines when it cannot cite one</li>
              <li>Fees carry the date they were set</li>
              <li>Every answer is auditable afterwards</li>
            </ul>
          </div>
        </div>

        {system && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t hairline pt-4 font-mono text-2xs muted">
            <span>{system.services_indexed} services indexed</span>
            <span>·</span>
            <span>{system.database}</span>
            <span>·</span>
            <span>retrieval {system.embedder}</span>
            <span>·</span>
            <span title={system.llm_mode}>
              model: {system.llm_provider === 'none' ? 'none — grounded answers only' : `${system.llm_provider}/${system.llm_model}`}
            </span>
            <span>·</span>
            <span>prompts {system.prompt_version}</span>
            <Link href="/admin" className="ml-auto hover:text-brand-500">
              Curator console
            </Link>
          </div>
        )}
      </div>
    </footer>
  );
}
