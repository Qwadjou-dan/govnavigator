'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  adminAnalytics,
  adminAudit,
  adminCorrections,
  adminGaps,
  adminOverview,
  adminRecent,
  adminResolve,
  adminVerify,
  curatorLogin,
  getToken,
  setToken,
} from '@/lib/api';
import { Empty, FreshnessBadge, Icon, MiniBars, Section, Spinner } from '@/components/ui';

/**
 * The curator console. Three jobs: see how the system is actually behaving,
 * mark a service card as checked against the institution, and work the
 * correction queue.
 *
 * The coverage backlog is the interesting screen: it is ranked by what real
 * people asked for and did not get, so what we verify next is decided by
 * demand rather than by our assumptions.
 *
 * Everything is curator-gated: signing in calls /auth/curator-login and the
 * token gates six parallel fetches (/admin/overview, coverage-gaps,
 * corrections, recent-queries, analytics, verification-audit). Sections, in
 * order: headline stats, Analytics (14-day bar chart + outcome/language/top
 * service breakdown from /admin/analytics), Coverage backlog, Corrections,
 * Verification audit (every card scored for needs_action, freshness badge,
 * Verify button that flips reviewed_at), then Recent questions. All six load
 * in one Promise.all — a 403 leaves the page at the sign-in form.
 */
export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  // True while the first load — all six parallel admin feeds — is in flight.
  // authed starts false, so without this the page would show the sign-in form
  // during a slow boot, and a curator watching for five seconds would read
  // "log in" as "login rejected" when nothing had been rejected. The spinner
  // is the honest version of that pause.
  const [boot, setBoot] = useState(true);
  const [contact, setContact] = useState('curator@govnavigator.local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<any>(null);
  const [analytics, setAnalytics] = useState<any>(null);
  const [audit, setAudit] = useState<any>(null);
  const [gaps, setGaps] = useState<any[]>([]);
  const [corrections, setCorrections] = useState<any[]>([]);
  const [recent, setRecent] = useState<any[]>([]);

  const load = useCallback(async () => {
    setBoot(true);
    try {
      const [o, g, c, r, a, au] = await Promise.all([
        adminOverview(),
        adminGaps(),
        adminCorrections(),
        adminRecent(),
        adminAnalytics(),
        adminAudit(),
      ]);
      setOverview(o);
      setGaps(g);
      setCorrections(c);
      setRecent(r);
      setAnalytics(a);
      setAudit(au);
      setAuthed(true);
    } catch (err) {
      // The failure is either a dead token (401 — request() already dropped
      // it) or a 5xx / network error. Say which, so a stale session does not
      // look identical to "the console is down".
      setError(err instanceof Error ? err.message : 'Could not load the console.');
      setAuthed(false);
    } finally {
      setBoot(false);
    }
  }, []);

  useEffect(() => {
    if (getToken()) void load();
    else setBoot(false);
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

  if (boot) {
    return (
      <div className="mx-auto max-w-md space-y-5 py-16 text-center">
        <div className="flex justify-center">
          <Spinner />
        </div>
        <h1 className="text-xl font-extrabold tracking-tight">Loading the curator console</h1>
        <p className="text-sm muted text-pretty">
          Pulling six data feeds — headline stats, analytics, backlog, corrections and the audit.
          This takes a few seconds.
        </p>
      </div>
    );
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

  /* last 14 days of the analytics window for the bar chart */
  const chartWindow = analytics?.daily?.slice(-14) ?? [];

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

      {analytics && (
        <section className="space-y-5">
          <Section title="Analytics" icon={<Icon.spark className="h-4 w-4 text-brand-500" />}>
            <div className="space-y-5">
              <div className="surface-sunk px-4 py-4">
                <p className="label mb-2">Questions per day — last 14 days</p>
                {chartWindow.length ? (
                  <MiniBars
                    data={chartWindow.map((d: any) => ({ label: d.date.slice(5), value: d.queries }))}
                  />
                ) : (
                  <p className="text-sm muted">No data yet.</p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(analytics.outcome_split).filter(([k]) => k !== 'total').map(([k, v]) => (
                  <div key={k} className="surface px-4 py-3.5">
                    <p className="label">{k}</p>
                    <p className="mt-1 text-xl font-extrabold tabular-nums">{v as number}</p>
                  </div>
                ))}
                {analytics.languages?.slice(0, 3).map((l: any) => (
                  <div key={l.language} className="surface px-4 py-3.5">
                    <p className="label">Language: {l.language}</p>
                    <p className="mt-1 text-xl font-extrabold tabular-nums">{l.count}</p>
                  </div>
                ))}
              </div>

              {analytics.top_services?.length > 0 && (
                <div>
                  <p className="label mb-2">Top requested services</p>
                  <div className="flex flex-wrap gap-2">
                    {analytics.top_services.map((s: any) => (
                      <Link key={s.service_id} href={`/service/${s.service_id}`} className="chip">
                        {s.name} <span className="text-2xs muted">×{s.queried}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>
        </section>
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

      {audit && (
        <Section
          title="Verification audit — what needs a human check"
          icon={<Icon.shield className="h-4 w-4 text-brand-500" />}
          count={audit.summary?.needs_action}
        >
          <p className="-mt-1 text-sm soft text-pretty">
            {audit.summary?.verified} of {audit.summary?.total} cards are confirmed with their institution.{' '}
            {audit.summary?.needs_action} need a review. A card needs action if it is unverified,
            carries an old or missing official source, or its freshness is outdated.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-5">
            {stat('Total', audit.summary.total)}
            {stat('Verified', audit.summary.verified)}
            {stat('Unverified', audit.summary.unverified)}
            {stat('Needs action', audit.summary.needs_action)}
          </div>
          <div className="scroll-x">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <thead>
                <tr className="border-b hairline text-left">
                  <th className="label pb-2">Service</th>
                  <th className="label pb-2">Institution</th>
                  <th className="label pb-2">Sources</th>
                  <th className="label pb-2">Freshness</th>
                  <th className="label pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {audit.rows.map((r: any) => (
                  <tr
                    key={r.id}
                    className={`border-b hairline last:border-0 ${r.needs_action ? 'bg-ochre-100/30 dark:bg-ochre-700/10' : ''}`}
                  >
                    <td className="py-2.5 pr-3">
                      <Link href={`/service/${r.id}`} className="font-medium hover:text-brand-600">
                        {r.name}
                      </Link>
                      <span className="text-2xs muted">{r.category}</span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs muted">{r.institution_abbr}</td>
                    <td className="py-2.5 pr-3 text-xs">
                      {r.official_source_count}/{r.source_count} official
                    </td>
                    <td className="py-2.5 pr-3">
                      {r.freshness !== 'none' && (
                        <FreshnessBadge freshness={r.freshness} reviewed={null} />
                      )}
                    </td>
                    <td className="py-2.5">
                      {r.reviewed ? (
                        <span className="inline-flex items-center gap-1 text-2xs font-semibold text-brand-600 dark:text-brand-300">
                          <Icon.check className="h-3 w-3" /> verified {r.reviewed_at && <span className="muted font-normal">· {r.reviewed_at.slice(0,10)}</span>}
                        </span>
                      ) : (
                        <button onClick={() => adminVerify(r.id).then(load)} className="btn-ghost !py-1.5 !text-xs">
                          Verify
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

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
