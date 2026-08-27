'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  adminCorrections,
  adminGaps,
  adminOverview,
  adminRecent,
  adminResolve,
  adminVerify,
  curatorLogin,
  getToken,
  listServices,
  setToken,
} from '@/lib/api';
import type { ServiceSummary } from '@/lib/types';
import { Empty, Icon, Section, Spinner } from '@/components/ui';

/**
 * The curator console. Three jobs: see how the system is actually behaving,
 * mark a service card as checked against the institution, and work the
 * correction queue.
 *
 * The coverage backlog is the interesting screen: it is ranked by what real
 * people asked for and did not get, so what we verify next is decided by
 * demand rather than by our assumptions.
 */
export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  const [contact, setContact] = useState('curator@govnavigator.local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<any>(null);
  const [gaps, setGaps] = useState<any[]>([]);
  const [corrections, setCorrections] = useState<any[]>([]);
  const [recent, setRecent] = useState<any[]>([]);
  const [services, setServices] = useState<ServiceSummary[]>([]);

  const load = useCallback(async () => {
    try {
      const [o, g, c, r, s] = await Promise.all([
        adminOverview(),
        adminGaps(),
        adminCorrections(),
        adminRecent(),
        listServices(),
      ]);
      setOverview(o);
      setGaps(g);
      setCorrections(c);
      setRecent(r);
      setServices(s);
      setAuthed(true);
    } catch {
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    if (getToken()) void load();
  }, [load]);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await curatorLogin(contact, password);
      setToken(res.access_token);
      await load();
    } catch {
      setError('Those details are not correct.');
    } finally {
      setBusy(false);
    }
  }

  if (!authed) {
    return (
      <div className="mx-auto max-w-md space-y-5">
        <header className="text-center">
          <h1 className="text-2xl font-extrabold tracking-tight">Curator console</h1>
          <p className="mt-1.5 text-sm soft text-pretty">
            For the people who verify content against institutions. Curators sign in with a password
            because they change what the public is shown, and every verification is recorded against
            their name.
          </p>
        </header>
        <div className="surface space-y-3 p-5">
          <label className="label block" htmlFor="c">Curator email</label>
          <input
            id="c"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            className="w-full rounded-xl border border-ink-line bg-paper px-3 py-2.5 text-sm outline-none focus:border-brand-400 dark:border-night-line dark:bg-night"
          />
          <label className="label block" htmlFor="p">Password</label>
          <input
            id="p"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && signIn()}
            className="w-full rounded-xl border border-ink-line bg-paper px-3 py-2.5 text-sm outline-none focus:border-brand-400 dark:border-night-line dark:bg-night"
          />
          <button onClick={signIn} disabled={busy || !password} className="btn-primary w-full">
            {busy ? <Spinner /> : <Icon.shield />} Sign in
          </button>
          {error && <p className="text-xs text-flag-bad">{error}</p>}
          <p className="text-2xs muted text-pretty">
            The development password is set by ADMIN_PASSWORD in the backend .env. Change it before
            deploying anywhere public.
          </p>
        </div>
      </div>
    );
  }

  const stat = (label: string, value: string | number, hint?: string) => (
    <div className="surface px-4 py-3.5">
      <p className="label">{label}</p>
      <p className="mt-1 text-xl font-extrabold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-2xs muted text-pretty">{hint}</p>}
    </div>
  );

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Curator console</h1>
          <p className="mt-1 text-sm soft">Last {overview?.window_days ?? 30} days.</p>
        </div>
        <button onClick={() => { setToken(null); setAuthed(false); }} className="btn-quiet shrink-0">
          Sign out
        </button>
      </header>

      {overview && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stat('Questions asked', overview.queries.total)}
            {stat('Answered', `${Math.round(overview.queries.answer_rate * 100)}%`, `${overview.queries.answered} of ${overview.queries.total}`)}
            {stat(
              'Declined',
              `${Math.round(overview.queries.refusal_rate * 100)}%`,
              'Refusing when we cannot cite a source is correct behaviour, not a fault',
            )}
            {stat(
              'Unsourced claims blocked',
              overview.quality.unsourced_claims_blocked,
              'Facts the validator removed before anyone saw them',
            )}
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stat('p50 latency', `${overview.quality.p50_latency_ms}ms`)}
            {stat('p95 latency', `${overview.quality.p95_latency_ms}ms`)}
            {stat(
              'Matched at the office',
              `${overview.feedback.matched_at_office}/${overview.feedback.total || 0}`,
              'People who confirmed reality matched our answer',
            )}
            {stat(
              'Cards team-verified',
              `${overview.content.verified_by_team}/${overview.content.services}`,
              `${overview.content.official_sources} of ${overview.content.sources} sources are official`,
            )}
          </section>
        </>
      )}

      <Section
        title="Coverage backlog — what people asked for and did not get"
        icon={<Icon.search className="h-4 w-4 text-brand-500" />}
        count={gaps.length}
      >
        <p className="-mt-1 text-sm soft text-pretty">
          Ranked by how often it was asked. This is the demand signal that decides what to verify
          next — real users rather than our assumptions.
        </p>
        {gaps.length === 0 ? (
          <Empty title="No gaps recorded yet" body="Every question so far has been answerable from the verified corpus." />
        ) : (
          <ul className="space-y-1.5">
            {gaps.map((g, i) => (
              <li key={i} className="surface-sunk flex items-center justify-between gap-3 px-3.5 py-2.5">
                <span className="min-w-0 truncate text-sm">{g.query}</span>
                <span className="shrink-0 text-2xs font-semibold muted">
                  asked {g.times_asked}×{g.likely_institution ? ` · likely ${g.likely_institution}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Corrections from people who went to the office"
        icon={<Icon.warn className="h-4 w-4 text-ochre-500" />}
        count={corrections.length}
      >
        {corrections.length === 0 ? (
          <Empty title="Nothing in the queue" body="No one has reported a mismatch between our answer and what they found." />
        ) : (
          <ul className="space-y-2">
            {corrections.map((c) => (
              <li key={c.id} className="surface-sunk px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-2xs font-bold uppercase ${
                      c.verdict === 'no'
                        ? 'bg-red-100 text-flag-bad dark:bg-red-950/50 dark:text-red-300'
                        : 'bg-ochre-100 text-ochre-700 dark:bg-ochre-700/25 dark:text-ochre-300'
                    }`}
                  >
                    {c.verdict === 'no' ? 'did not match' : 'partly matched'}
                  </span>
                  <span className="text-sm font-semibold">{c.service_name ?? c.service_id}</span>
                  <span className="text-2xs muted">{new Date(c.created_at).toLocaleString()}</span>
                </div>
                {c.comment && <p className="mt-1.5 text-sm soft text-pretty">{c.comment}</p>}
                <button
                  onClick={() => adminResolve(c.id, 'Reviewed against the official source').then(load)}
                  className="btn-ghost mt-2 !py-1.5 !text-xs"
                >
                  <Icon.check /> Mark reviewed
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Verify a service against its institution"
        icon={<Icon.shield className="h-4 w-4 text-brand-500" />}
      >
        <p className="-mt-1 text-sm soft text-pretty">
          Until a person confirms a card with the agency, every answer for it carries a caveat saying
          so. Verifying records who did it and when, and bumps the content version.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {services.map((s) => (
            <div key={s.id} className="surface-sunk flex items-center justify-between gap-3 px-3.5 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                <span className="text-2xs muted">{s.institution.abbreviation}</span>
              </span>
              {s.reviewed ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-semibold text-brand-600 dark:text-brand-300">
                  <Icon.check className="h-3 w-3" /> verified
                </span>
              ) : (
                <button onClick={() => adminVerify(s.id).then(load)} className="btn-ghost shrink-0 !py-1.5 !text-xs">
                  Verify
                </button>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Recent questions" icon={<Icon.clock className="h-4 w-4 text-brand-500" />}>
        <div className="scroll-x">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <thead>
              <tr className="border-b hairline text-left">
                <th className="label pb-2">Question</th>
                <th className="label pb-2">Outcome</th>
                <th className="label pb-2">Service</th>
                <th className="label pb-2">ms</th>
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 25).map((r) => (
                <tr key={r.id} className="border-b hairline last:border-0">
                  <td className="max-w-xs truncate py-2 pr-3">{r.text}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={`rounded px-1.5 py-0.5 text-2xs font-bold uppercase ${
                        r.outcome === 'answered'
                          ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                          : r.outcome === 'refused'
                            ? 'bg-ochre-100 text-ochre-700 dark:bg-ochre-700/25 dark:text-ochre-300'
                            : 'bg-paper-sunk muted dark:bg-night-sunk'
                      }`}
                    >
                      {r.outcome}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs muted">{r.service_id ?? '—'}</td>
                  <td className="py-2 font-mono text-xs muted">{r.latency_ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
