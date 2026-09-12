'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  deleteChecklist,
  getToken,
  isSignedOut,
  listChecklists,
  requestCode,
  setToken,
  verifyCode,
} from '@/lib/api';
import type { SavedChecklist } from '@/lib/types';
import { Empty, Icon, Spinner } from '@/components/ui';

/**
 * The only account-requiring page, and the account exists for one reason: so a
 * checklist survives closing the browser. No password — a 6-digit code sent to
 * the contact (echoed back in development); the backend stores a hash of the
 * contact, never the contact. ServiceCard's "Save this checklist" sends
 * people here with ?next=/service/... so that after sign-in they land straight
 * back in front of the card they were keeping; ?expired=1 changes the heading
 * so "session ended" does not read as "nothing saved". Wrapped in <Suspense>
 * because it calls useSearchParams, which is browser-only.
 */
/** Only ever return to a path inside this app. `//evil.com` is a valid URL to a
 *  browser and would turn our own sign-in into someone else's redirect. */
function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

/**
 * Sign-in exists for exactly one reason: so a checklist survives closing the
 * browser. There is no password, and the backend stores a hash of the contact
 * rather than the contact itself — so there is nothing here worth stealing.
 */
function SavedInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));

  const [signedIn, setSignedIn] = useState(false);
  const [items, setItems] = useState<SavedChecklist[]>([]);
  const [loading, setLoading] = useState(false);
  // Set either by whoever sent us here (the token died mid-action) or by our
  // own first load failing. Both mean the same thing to the person.
  const [expired, setExpired] = useState(params.get('expired') === '1');

  const [contact, setContact] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'contact' | 'code'>('contact');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listChecklists());
      setSignedIn(true);
      setExpired(false);
    } catch (err) {
      setSignedIn(false);
      // Say which of the two it was. "Nothing here" and "we no longer know who
      // you are" look identical on screen and need opposite responses.
      setExpired(isSignedOut(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (getToken()) void load();
  }, [load]);

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestCode(contact);
      setDevCode(res.dev_code ?? null);
      setStage('code');
    } catch {
      setError('We could not send a code just now.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await verifyCode(contact, code);
      setToken(res.access_token);
      if (next) {
        // They did not come here to look at a list — they came from a checklist
        // they were trying to keep. Put them back in front of it.
        router.replace(next);
        return;
      }
      await load();
    } catch {
      setError('That code is not right, or it has expired.');
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    setToken(null);
    setSignedIn(false);
    setItems([]);
    setStage('contact');
    setCode('');
    setExpired(false);
  }

  if (!signedIn) {
    return (
      <div className="mx-auto max-w-md space-y-5">
        <header className="text-center">
          <h1 className="text-2xl font-extrabold tracking-tight">
            {expired ? 'Sign in again' : 'Save your checklists'}
          </h1>
          <p className="mt-1.5 text-sm soft text-pretty">
            Asking a question never needs an account. This is only so a checklist is still here when
            you come back — we store a one-way hash of your contact, never your Ghana Card or TIN.
          </p>
        </header>

        {expired && (
          <p className="flex items-start gap-2 rounded-xl border border-ochre-300/60 bg-ochre-100/40 px-3.5 py-2.5 text-xs soft text-pretty dark:border-ochre-700/50 dark:bg-ochre-700/10">
            <Icon.info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Your previous session has ended, so we signed you out. Sign in with the same email or
              phone number and anything you saved before will still be there.
            </span>
          </p>
        )}

        {next && (
          <p className="flex items-start gap-2 text-xs muted text-pretty">
            <Icon.save className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Once you are in we will take you straight back to the checklist you were saving.</span>
          </p>
        )}

        <div className="surface space-y-3 p-5">
          {stage === 'contact' ? (
            <>
              <label htmlFor="contact" className="label block">
                Email or phone number
              </label>
              <input
                id="contact"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && contact.trim() && sendCode()}
                placeholder="you@example.com or 024 000 0000"
                className="w-full rounded-xl border border-ink-line bg-paper px-3 py-2.5 text-sm outline-none focus:border-brand-400 dark:border-night-line dark:bg-night"
              />
              <button onClick={sendCode} disabled={busy || !contact.trim()} className="btn-primary w-full">
                {busy ? <Spinner /> : <Icon.arrow />} Send me a code
              </button>
            </>
          ) : (
            <>
              <label htmlFor="code" className="label block">
                Enter the 6-digit code
              </label>
              <input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && confirm()}
                inputMode="numeric"
                placeholder="000000"
                className="w-full rounded-xl border border-ink-line bg-paper px-3 py-2.5 text-center font-mono text-lg tracking-[0.4em] outline-none focus:border-brand-400 dark:border-night-line dark:bg-night"
              />
              {devCode && (
                <p className="rounded-lg bg-paper-sunk px-3 py-2 text-xs muted dark:bg-night-sunk">
                  Development mode — no SMS or email provider is configured, so your code is{' '}
                  <strong className="font-mono">{devCode}</strong>.
                </p>
              )}
              <button onClick={confirm} disabled={busy || code.length < 6} className="btn-primary w-full">
                {busy ? <Spinner /> : <Icon.check />} Sign in
              </button>
              <button onClick={() => setStage('contact')} className="btn-quiet w-full">
                Use a different contact
              </button>
            </>
          )}
          {error && <p className="text-xs text-flag-bad">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Your saved checklists</h1>
          <p className="mt-1 text-sm soft">Pick up where you left off.</p>
        </div>
        <button onClick={signOut} className="btn-quiet shrink-0">
          Sign out
        </button>
      </header>

      {loading && <div className="skeleton h-24" />}

      {!loading && items.length === 0 && (
        <Empty
          title="Nothing saved yet"
          body="Open any service and use “Save this checklist” — it will wait here for you."
          icon={<Icon.save className="h-5 w-5" />}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.id} className="surface flex flex-col p-4">
            <Link
              href={`/service/${item.service_id}`}
              className="text-sm font-bold hover:text-brand-600 dark:hover:text-brand-300"
            >
              {item.title}
            </Link>
            <p className="mt-1 text-2xs muted">Saved {new Date(item.updated_at).toLocaleDateString()}</p>
            <div className="mt-3 flex gap-2">
              <Link href={`/service/${item.service_id}`} className="btn-ghost !py-1.5 !text-xs">
                Open
              </Link>
              <button
                // Reload either way: on success the row is gone, and on failure
                // load() is what discovers *why* — usually an ended session.
                onClick={() => void deleteChecklist(item.id).then(load, load)}
                className="btn-quiet !py-1.5 !text-xs"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** useSearchParams() reads something that only exists in the browser, so the
 *  page needs a boundary the server can render without it. */
export default function SavedPage() {
  return (
    <Suspense fallback={<div className="skeleton mx-auto h-64 max-w-md" />}>
      <SavedInner />
    </Suspense>
  );
}
