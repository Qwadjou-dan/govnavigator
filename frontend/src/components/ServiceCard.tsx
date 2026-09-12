'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, getToken, isSignedOut, saveChecklist } from '@/lib/api';
import type { AnswerContract, DocumentItem, FeeItem, SourceRef } from '@/lib/types';
import {
  CaveatCard,
  ConfidenceMeter,
  Empty,
  FreshnessBadge,
  Icon,
  Primary,
  Section,
  Spinner,
  StatusBadge,
  SupportingHeading,
} from './ui';
import { Feedback } from './Feedback';
import { AssumptionStrip, DirectAnswerBand } from './DirectAnswerBand';

const TABS = [
  { id: 'checklist', label: 'What to bring', icon: <Icon.doc className="h-3.5 w-3.5" /> },
  { id: 'steps', label: 'Steps', icon: <Icon.steps className="h-3.5 w-3.5" /> },
  { id: 'cost', label: 'Cost & time', icon: <Icon.cash className="h-3.5 w-3.5" /> },
  { id: 'office', label: 'Where to go', icon: <Icon.pin className="h-3.5 w-3.5" /> },
  { id: 'sources', label: 'Sources', icon: <Icon.link className="h-3.5 w-3.5" /> },
] as const;

type TabId = (typeof TABS)[number]['id'];

function money(fee: FeeItem): string {
  if (fee.amount_text) return fee.amount_text;
  if (fee.amount_ghs === null || fee.amount_ghs === undefined) return '—';
  if (fee.amount_ghs === 0) return 'Free';
  return `GH₵ ${fee.amount_ghs.toLocaleString('en-GH', { minimumFractionDigits: 2 })}`;
}

function SourceLink({ source }: { source: SourceRef }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-start gap-2 rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-paper-sunk dark:hover:bg-night-sunk"
    >
      <Icon.link className="mt-0.5 h-3.5 w-3.5 shrink-0 muted group-hover:text-brand-500" />
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-snug group-hover:text-brand-600 dark:group-hover:text-brand-300">
          {source.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs muted">
          <span>{source.publisher}</span>
          {source.is_official ? (
            <span className="inline-flex items-center gap-1 font-medium text-brand-600 dark:text-brand-300">
              <Icon.shield className="h-3 w-3" /> Official
            </span>
          ) : (
            <span className="font-medium text-ochre-700 dark:text-ochre-300">Secondary source</span>
          )}
          {source.retrieved_at && <span>checked {source.retrieved_at}</span>}
          {source.effective_date && <span>effective {source.effective_date}</span>}
        </span>
        {source.note && <span className="mt-1 block text-xs soft text-pretty">{source.note}</span>}
      </span>
    </a>
  );
}

/** Documents that are "any one of these" are grouped, because listing them
 *  as five separate mandatory rows is how a checklist frightens people. */
function groupDocuments(docs: DocumentItem[]) {
  const groups = new Map<string, DocumentItem[]>();
  const singles: DocumentItem[] = [];
  for (const doc of docs) {
    if (doc.one_of_group) {
      const list = groups.get(doc.one_of_group) ?? [];
      list.push(doc);
      groups.set(doc.one_of_group, list);
    } else singles.push(doc);
  }
  return { groups, singles };
}

/**
 * The service card — the core artifact shown for both a /query answer and a
 * /services/{id} deep link. Anatomy (top to bottom):
 *   header       — institution chip, confidence meter, service name, summary,
 *                  freshness/review badge, and the save / print / copy / email
 *                  / WhatsApp actions;
 *   at-a-glance  — cost, how long, items-to-bring row;
 *   answer band  — the direct answer to the typed question + the assumptions
 *                  it took as given (rendered by DirectAnswerBand);
 *   five tabs    — checklist (tickable, grouped "any one of" documents),
 *                  steps (numbered, channel + where), cost & time, the office,
 *                  and sources (every claim's citation) + validator report;
 *   below the tabs — caveats, related services (onAsk → can re-ask), feedback.
 *
 * Props: contract (the validated Answer Contract), answerId (optional — from
 * the /query path, enables feedback linkage), onAsk (navigates to the related
 * service), onRevise (re-ask with an assumed condition re-opened; present only
 * inside a live conversation, so the deep-link page omits it).
 */
export function ServiceCard({
  contract,
  answerId,
  onAsk,
  onRevise,
}: {
  contract: AnswerContract;
  answerId?: string | null;
  onAsk?: (text: string) => void;
  /** Re-ask with a condition re-opened. Absent on the static service page. */
  onRevise?: (id: string, value: string) => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>('checklist');
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { groups, singles } = useMemo(() => groupDocuments(contract.documents), [contract.documents]);

  const sourceById = useMemo(
    () => Object.fromEntries(contract.sources.map((s) => [s.id, s])),
    [contract.sources],
  );

  // Back from /saved?next=… after a sign-in: the person pressed "Save this
  // checklist" before they were asked to sign in, so complete that save now —
  // one tap, sign in, return, and it is saved. The flag is cleared on first
  // consumption so a later remount of the same card does not re-save.
  useEffect(() => {
    if (!getToken()) return;
    let pending: string | null = null;
    try {
      pending = window.localStorage.getItem('gn.pending_save');
    } catch {
      /* private browsing */
    }
    if (pending === contract.service_id) {
      window.localStorage.removeItem('gn.pending_save');
      void save();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save() closes over
    // live state; this effect is deliberately one-shot per service card.
  }, [contract.service_id]);

  const headlineFee = contract.fees.find((f) => f.amount_ghs !== null || f.amount_text) ?? null;
  const totalTickable = singles.length + groups.size;
  const doneCount = Object.values(ticked).filter(Boolean).length;

  /** Send them to sign in, then straight back to this service card.
   *  `expired` distinguishes "you never signed in" from "you did, and it has
   *  since lapsed" — the second needs explaining or it reads as a bug. */
  function signInThenReturn(expired = false) {
    const sid = contract.service_id;
    if (!sid) return;
    // Remember which card the person was keeping. Once they have signed in on
    // /saved and been returned here, the card completes the save it promised —
    // otherwise the round-trip ends with the button back at "Save this
    // checklist" and the sign-in trip did nothing.
    try {
      window.localStorage.setItem('gn.pending_save', sid);
    } catch {
      /* private browsing */
    }
    const next = encodeURIComponent(`/service/${sid}`);
    router.push(`/saved?next=${next}${expired ? '&expired=1' : ''}`);
  }

  /** Save is offered wherever an answer is shown, not only on the deep-link
   *  page — asking a question is the main way people get here. */
  async function save() {
    if (!contract.service_id) return;
    if (!getToken()) {
      signInThenReturn();
      return;
    }
    setSaveState('saving');
    setSaveError(null);
    try {
      await saveChecklist({
        service_id: contract.service_id,
        title: contract.service_name ?? contract.service_id,
        payload: { documents: contract.documents.map((d) => d.name) },
        progress: ticked,
      });
      setSaveState('saved');
    } catch (err) {
      // A dead token is not an error the person can act on — it is simply the
      // no-token case discovered late. Take the same road: sign in, come back.
      // (api.ts has already dropped the token, so this cannot loop.)
      if (isSignedOut(err)) {
        setSaveState('idle');
        signInThenReturn(true);
        return;
      }
      setSaveState('error');
      // A connection failure deserves its own words. Anything else keeps the
      // reassurance that matters most: nothing on screen has been lost.
      setSaveError(
        err instanceof ApiError && err.status === 0
          ? 'We cannot reach the service right now. Your checklist is still on screen — print it or send it to yourself on WhatsApp.'
          : 'We could not save that just now. Your checklist is still on screen.',
      );
    }
  }

  function shareToWhatsApp() {
    const lines = [
      `*${contract.service_name}* — ${contract.institution?.name ?? ''}`,
      '',
      'What to bring:',
      ...singles.map((d) => `• ${d.name}`),
      ...[...groups.values()].map((g) => `• Any one of: ${g.map((d) => d.name).join(' / ')}`),
      '',
      headlineFee ? `Cost: ${money(headlineFee)} (${headlineFee.label})` : '',
      contract.timeline?.standard ? `Time: ${contract.timeline.standard}` : '',
      '',
      contract.institution?.official_url ? `Official page: ${contract.institution.official_url}` : '',
      'Shared from GovNavigator Ghana — an independent guide, not a government service.',
    ].filter(Boolean);
    const url = `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
    window.open(url, '_blank', 'noopener');
  }

  /** One payload, three exits: WhatsApp, clipboard, email. Kept in one place
   *  so the three buttons cannot drift apart. */
  function shareText(): string {
    return [
      `${contract.service_name} — ${contract.institution?.name ?? ''}`,
      '',
      'What to bring:',
      ...singles.map((d) => `• ${d.name}`),
      ...[...groups.values()].map((g) => `• Any one of: ${g.map((d) => d.name).join(' / ')}`),
      '',
      headlineFee ? `Cost: ${money(headlineFee)} (${headlineFee.label})` : '',
      contract.timeline?.standard ? `Time: ${contract.timeline.standard}` : '',
      '',
      contract.institution?.official_url ?? '',
      'Shared from GovNavigator Ghana — an independent guide, not a government service.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async function copyChecklist() {
    try {
      await navigator.clipboard.writeText(shareText());
    } catch {
      // Clipboard is a permission-gated API; a tiny fallback keeps the button
      // honest on browsers that refuse it.
      const ta = document.createElement('textarea');
      ta.value = shareText();
      ta.className = 'sr-only';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  function emailChecklist() {
    const subject = encodeURIComponent(`${contract.service_name} — what to bring`);
    const body = encodeURIComponent(shareText());
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank', 'noopener');
  }

  return (
    <article className="surface animate-rise overflow-hidden">
      {/* ------------------------------------------------------- header */}
      <header className="border-b hairline bg-paper-raised px-5 py-5 dark:bg-night-raised sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-500/10 px-2.5 py-1 text-2xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-300">
            <Icon.building className="h-3 w-3" />
            {contract.institution?.abbreviation || contract.institution?.name}
          </span>
          <ConfidenceMeter level={contract.confidence} />
        </div>

        <h2 className="mt-2.5 text-xl font-bold leading-tight tracking-tight text-balance sm:text-2xl">
          {contract.service_name}
        </h2>
        {contract.summary && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed soft text-pretty">{contract.summary}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <FreshnessBadge freshness={contract.freshness} reviewed={contract.last_reviewed_by_team} />
        </div>

        <div className="no-print mt-4 flex flex-wrap gap-2">
          <button onClick={save} disabled={saveState === 'saving' || saveState === 'saved'} className="btn-primary">
            {saveState === 'saving' ? <Spinner /> : saveState === 'saved' ? <Icon.check /> : <Icon.save />}
            {saveState === 'saved' ? 'Saved to your list' : 'Save this checklist'}
          </button>
          <button onClick={() => window.print()} className="btn-ghost">
            <Icon.print /> Print / PDF
          </button>
          <button onClick={copyChecklist} className="btn-ghost">
            {copied ? <Icon.check /> : <Icon.doc />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={emailChecklist} className="btn-ghost">
            <Icon.share /> Email
          </button>
          <button onClick={shareToWhatsApp} className="btn-ghost">
            <Icon.chat /> WhatsApp
          </button>
        </div>
        {saveState === 'error' && saveError && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-flag-bad text-pretty">
            <Icon.warn className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {saveError}{' '}
              <button onClick={save} className="font-semibold underline underline-offset-2">
                Try again
              </button>
            </span>
          </p>
        )}

        {/* at-a-glance */}
        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="surface-sunk px-3 py-2.5">
            <dt className="label">Cost</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold">
              {headlineFee ? money(headlineFee) : 'Not published'}
              {/* Don't repeat the badge when the value already says the same thing. */}
              {headlineFee && headlineFee.status !== 'not_published' && (
                <StatusBadge status={headlineFee.status} />
              )}
            </dd>
          </div>
          <div className="surface-sunk px-3 py-2.5">
            <dt className="label">How long</dt>
            <dd className="mt-0.5 flex items-start gap-1.5 text-sm font-semibold">
              {/* Two lines rather than an ellipsis: "Membership l..." tells the
                  person nothing, and this tile is one of three things they read. */}
              <span className="line-clamp-2 leading-snug">{contract.timeline?.standard ?? 'Not published'}</span>
              {contract.timeline?.standard && contract.timeline.status !== 'confirmed' && (
                <StatusBadge status={contract.timeline.status} />
              )}
            </dd>
          </div>
          <div className="surface-sunk col-span-2 px-3 py-2.5 sm:col-span-1">
            <dt className="label">You need</dt>
            <dd className="mt-0.5 text-sm font-semibold">
              {totalTickable} {totalTickable === 1 ? 'item' : 'items'} · {contract.steps.length} steps
            </dd>
          </div>
        </dl>
      </header>

      {/* The question first, the service second. Above the tabs, because a
          person who asked "can I do this for my brother" needs the answer to
          that before they need a choice of checklists. */}
      {(contract.direct_answer || contract.assumptions.length > 0) && (
        <div className="space-y-3 border-b hairline px-5 py-5 sm:px-6">
          {contract.direct_answer && (
            <DirectAnswerBand answer={contract.direct_answer} sources={contract.sources} />
          )}
          <AssumptionStrip assumptions={contract.assumptions} onRevise={onRevise} />
        </div>
      )}

      {/* --------------------------------------------------------- tabs */}
      <div className="no-print scroll-x border-b hairline px-2">
        <div className="flex min-w-max gap-1 py-2">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand-500 text-white shadow-sm'
                    : 'text-ink-soft hover:bg-paper-sunk dark:text-night-soft dark:hover:bg-night-sunk'
                }`}
                aria-current={active}
              >
                {t.icon}
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-6 px-5 py-5 sm:px-6">

        {/* -------------------------------------------------- checklist */}
        {tab === 'checklist' && (
          <div className="space-y-6">
            <Section
              variant="primary"
              title="Tick these off before you go"
              icon={<Icon.doc className="h-4 w-4" />}
              count={totalTickable}
              action={
                totalTickable > 0 ? (
                  <span className="text-xs font-semibold muted">
                    {doneCount}/{totalTickable} ready
                  </span>
                ) : undefined
              }
            >
              {totalTickable > 0 && (
                <div className="no-print h-1.5 w-full overflow-hidden rounded-full bg-brand-500/15">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-all duration-300"
                    style={{ width: `${(doneCount / totalTickable) * 100}%` }}
                  />
                </div>
              )}

              <ul className="space-y-2">
                {singles.map((doc, i) => {
                  const key = `s${i}`;
                  return (
                    <li key={key}>
                      <label className="tile flex cursor-pointer items-start gap-3 px-3.5 py-3 transition-colors hover:border-brand-400">
                        <input
                          type="checkbox"
                          checked={!!ticked[key]}
                          onChange={(e) => setTicked((t) => ({ ...t, [key]: e.target.checked }))}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[#4F46E5]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className={`text-sm font-medium ${ticked[key] ? 'line-through opacity-55' : ''}`}>
                              {doc.name}
                            </span>
                            {!doc.mandatory && (
                              <span className="rounded bg-paper px-1.5 py-0.5 text-2xs font-semibold muted dark:bg-night">
                                only if it applies
                              </span>
                            )}
                            <StatusBadge status={doc.status} />
                          </span>
                          {doc.where_to_obtain && (
                            <span className="mt-1 block text-xs soft">
                              Get it from: {doc.where_to_obtain}
                            </span>
                          )}
                          {doc.note && <span className="mt-1 block text-xs muted text-pretty">{doc.note}</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}

                {[...groups.entries()].map(([name, docs], gi) => {
                  const key = `g${gi}`;
                  return (
                    <li key={key}>
                      <label className="tile flex cursor-pointer items-start gap-3 px-3.5 py-3">
                        <input
                          type="checkbox"
                          checked={!!ticked[key]}
                          onChange={(e) => setTicked((t) => ({ ...t, [key]: e.target.checked }))}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[#4F46E5]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className={`text-sm font-semibold ${ticked[key] ? 'line-through opacity-55' : ''}`}>
                            Any <span className="text-brand-600 dark:text-brand-300">one</span> of these ({name})
                          </span>
                          <ul className="mt-1.5 space-y-1">
                            {docs.map((d, di) => (
                              <li key={di} className="text-xs soft">
                                <span className="mr-1.5 text-brand-500">▪</span>
                                {d.name}
                                {d.where_to_obtain && <span className="muted"> — from {d.where_to_obtain}</span>}
                                {d.note && <span className="mt-0.5 block pl-4 muted text-pretty">{d.note}</span>}
                              </li>
                            ))}
                          </ul>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              {totalTickable === 0 && (
                <Empty
                  title="No documents to bring"
                  body="Nothing needs to be produced or proved for this one."
                  icon={<Icon.doc className="h-5 w-5" />}
                />
              )}
            </Section>

            {contract.eligibility.length > 0 && (
              <Section title="Who this applies to" icon={<Icon.info className="h-4 w-4 text-brand-500" />}>
                <ul className="space-y-1.5">
                  {contract.eligibility.map((e, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm soft">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                      <span className="text-pretty">
                        {e.text} <StatusBadge status={e.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {contract.common_rejection_causes.length > 0 && (
              <Section
                title="What commonly goes wrong"
                icon={<Icon.warn className="h-4 w-4 text-ochre-500" />}
              >
                <ul className="space-y-2">
                  {contract.common_rejection_causes.map((r, i) => (
                    <li
                      key={i}
                      className="rounded-xl border border-ochre-300/60 bg-ochre-100/40 px-3.5 py-2.5 text-sm soft dark:border-ochre-700/50 dark:bg-ochre-700/10"
                    >
                      <span className="text-pretty">{r.text}</span>
                      {r.evidence_level !== 'official' && (
                        <span className="ml-1.5 text-2xs font-semibold uppercase tracking-wide muted">
                          {r.evidence_level === 'secondary' ? 'reported, not official' : 'our reading, not an official list'}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

          </div>
        )}

        {/* ------------------------------------------------------ steps */}
        {tab === 'steps' && (
          <Section variant="primary" title="The order to do things in" icon={<Icon.steps className="h-4 w-4" />}>
            <ol className="relative space-y-4 pl-7">
              <span className="absolute left-[11px] top-2 bottom-2 w-px bg-ink-line dark:bg-night-line" />
              {contract.steps.map((step) => (
                <li key={step.order} className="relative">
                  <span className="absolute -left-7 top-0 flex h-6 w-6 items-center justify-center rounded-full border border-brand-200 bg-paper-raised text-2xs font-bold text-brand-600 dark:border-brand-700 dark:bg-night-raised dark:text-brand-300">
                    {step.order}
                  </span>
                  <p className="text-sm font-medium leading-snug text-pretty">{step.action}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs muted">
                    <span className="inline-flex items-center gap-1">
                      {step.channel === 'online' ? '🌐 Online' : step.channel === 'in_person' ? '🏛 In person' : step.channel === 'ussd' ? '📱 USSD' : step.channel === 'phone' ? '📞 By phone' : '↔ Either way'}
                    </span>
                    {step.location && <span>{step.location}</span>}
                    <StatusBadge status={step.status} />
                  </div>
                  {step.note && <p className="mt-1 text-xs soft text-pretty">{step.note}</p>}
                </li>
              ))}
            </ol>
            {contract.steps.length === 0 && (
              <Empty title="No steps recorded" body="We have not verified a step-by-step process for this service yet." />
            )}
          </Section>
        )}

        {/* ------------------------------------------------------- cost */}
        {tab === 'cost' && (
          <div className="space-y-6">
            <Section variant="primary" title="What it costs" icon={<Icon.cash className="h-4 w-4" />} count={contract.fees.length}>
              <div className="scroll-x -mx-1 px-1">
                <table className="w-full min-w-[26rem] table-fixed border-collapse text-sm">
                  {/* Explicit proportions. Left to itself the browser gave the
                      short "Amount" strings as much room as the long item
                      labels, which squeezed the column that carries meaning. */}
                  <colgroup>
                    <col className="w-[54%]" />
                    <col className="w-[27%]" />
                    <col className="w-[19%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b hairline text-left">
                      <th className="label pb-2 font-semibold">Item</th>
                      <th className="label pb-2 font-semibold">Amount</th>
                      <th className="label pb-2 font-semibold">Set on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contract.fees.map((fee, i) => (
                      <tr key={i} className="border-b hairline last:border-0 align-top">
                        <td className="py-2.5 pr-3 align-top">
                          <span className="font-medium text-pretty">{fee.label}</span>
                          {fee.note && <span className="mt-0.5 block text-xs muted text-pretty">{fee.note}</span>}
                        </td>
                        <td className="py-2.5 pr-3 align-top">
                          <span className="block font-mono font-semibold leading-snug">{money(fee)}</span>
                          <span className="mt-1 inline-block">
                            <StatusBadge status={fee.status} />
                          </span>
                        </td>
                        <td className="py-2.5 align-top text-xs muted">
                          {fee.effective_date ?? '— no date published'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {contract.fees.length === 0 && (
                <Empty title="No fees published" body="This institution does not publish a fee for this service. Ask at the office." />
              )}
            </Section>

            {contract.timeline && (
              <Section variant="primary" title="How long it takes" icon={<Icon.clock className="h-4 w-4" />}>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="tile px-3.5 py-3">
                    <p className="label">Standard</p>
                    <p className="mt-1 text-sm font-semibold">{contract.timeline.standard ?? 'Not published'}</p>
                  </div>
                  <div className="tile px-3.5 py-3">
                    <p className="label">Faster option</p>
                    <p className="mt-1 text-sm font-semibold">{contract.timeline.expedited ?? 'None published'}</p>
                  </div>
                </div>
                {contract.timeline.note && (
                  <p className="text-xs soft text-pretty">{contract.timeline.note}</p>
                )}
              </Section>
            )}
          </div>
        )}

        {/* ----------------------------------------------------- office */}
        {tab === 'office' && contract.institution && (
          <div className="space-y-6">
            <Section variant="primary" title="Who is responsible" icon={<Icon.building className="h-4 w-4" />}>
              <div className="tile space-y-3 px-4 py-4">
                <div>
                  <p className="text-base font-bold">{contract.institution.name}</p>
                  {contract.institution.mandate && (
                    <p className="mt-1 text-sm soft text-pretty">{contract.institution.mandate}</p>
                  )}
                </div>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  {contract.institution.head_office && (
                    <div><dt className="label">Head office</dt><dd className="mt-0.5 soft">{contract.institution.head_office}</dd></div>
                  )}
                  {contract.institution.digital_address && (
                    <div><dt className="label">Digital address</dt><dd className="mt-0.5 font-mono">{contract.institution.digital_address}</dd></div>
                  )}
                  {contract.institution.phone && (
                    <div><dt className="label">Phone</dt><dd className="mt-0.5 soft">{contract.institution.phone}</dd></div>
                  )}
                  {contract.institution.email && (
                    <div><dt className="label">Email</dt><dd className="mt-0.5 soft break-all">{contract.institution.email}</dd></div>
                  )}
                  {contract.institution.opening_hours && (
                    <div><dt className="label">Opening hours</dt><dd className="mt-0.5 soft">{contract.institution.opening_hours}</dd></div>
                  )}
                </dl>
                <div className="flex flex-wrap gap-2 pt-1">
                  {contract.institution.official_url && (
                    <a href={contract.institution.official_url} target="_blank" rel="noopener noreferrer" className="btn-primary">
                      <Icon.link /> Official website
                    </a>
                  )}
                  {contract.institution.portal_url && (
                    <a href={contract.institution.portal_url} target="_blank" rel="noopener noreferrer" className="btn-ghost">
                      Online portal
                    </a>
                  )}
                </div>
                {contract.institution.offices.length > 0 && (
                  <div className="pt-1">
                    <p className="label mb-1.5">Where you can go</p>
                    <ul className="space-y-1">
                      {contract.institution.offices.map((o, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm soft">
                          <Icon.pin className="mt-0.5 h-3.5 w-3.5 shrink-0 muted" />
                          <span className="text-pretty">{o}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Section>

            {contract.dependent_institutions.length > 0 && (
              <Section title="Other institutions involved" count={contract.dependent_institutions.length}>
                <p className="-mt-1 text-sm soft text-pretty">
                  Most goals touch more than one office. These are the others you are likely to deal with.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {contract.dependent_institutions.map((inst) => (
                    <Link
                      key={inst.id}
                      href={`/institutions/${inst.id}`}
                      className="surface-sunk group px-3.5 py-3 transition-colors hover:border-brand-300"
                    >
                      <p className="text-sm font-semibold group-hover:text-brand-600 dark:group-hover:text-brand-300">
                        {inst.abbreviation || inst.name}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-xs soft">{inst.mandate || inst.name}</p>
                    </Link>
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}

        {/* ---------------------------------------------------- sources */}
        {tab === 'sources' && (
          <div className="space-y-6">
            <Section
              title="Every claim above comes from one of these"
              icon={<Icon.shield className="h-4 w-4 text-brand-500" />}
              count={contract.sources.length}
            >
              <div className="space-y-0.5">
                {contract.sources.map((s) => (
                  <SourceLink key={s.id} source={s} />
                ))}
              </div>
            </Section>

            <Section title="What our checks did" icon={<Icon.spark className="h-4 w-4 text-brand-500" />}>
              <div className="surface-sunk space-y-2 px-4 py-3.5 text-sm">
                <p className="soft">
                  We checked <strong>{contract.validator.fields_checked}</strong> individual facts against the
                  source each one cites, and removed <strong>{contract.validator.fields_dropped}</strong> that
                  could not be traced.
                </p>
                {contract.validator.dropped.length > 0 && (
                  <ul className="space-y-1 text-xs muted">
                    {contract.validator.dropped.map((d, i) => (
                      <li key={i}>• {d}</li>
                    ))}
                  </ul>
                )}
                <p className="text-xs muted">
                  Built by <span className="font-mono">{contract.generated_by}</span>
                  {contract.prompt_version && <> · prompts <span className="font-mono">{contract.prompt_version}</span></>}
                  {' '}· content version {contract.content_version}
                </p>
              </div>
            </Section>
          </div>
        )}

        {/* ------------------------- supporting material, clearly separated */}
        {contract.caveats.length > 0 && (
          <div className="space-y-2">
            <SupportingHeading text="Before you rely on this" />
            {contract.caveats.map((c, i) => (
              // Repeating the same heading twice in a row reads as a bug.
              <CaveatCard key={i} caveat={c} showLabel={i === 0 || contract.caveats[i - 1].kind !== c.kind} />
            ))}
          </div>
        )}

        {/* ------------------------------------------- related services */}
        {contract.related_services.length > 0 && (
          <Section title="You will probably need these too" count={contract.related_services.length}>
            <p className="-mt-1 text-sm soft text-pretty">
              The thing people most often do not know is what else the same goal requires.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {contract.related_services.map((rel) => (
                <button
                  key={rel.id}
                  onClick={() => onAsk?.(rel.name)}
                  className="surface-sunk group flex items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors hover:border-brand-300"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold group-hover:text-brand-600 dark:group-hover:text-brand-300">
                      {rel.name}
                    </span>
                    <span className="mt-0.5 block text-xs muted">{rel.institution}</span>
                  </span>
                  <Icon.arrow className="h-4 w-4 shrink-0 muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500" />
                </button>
              ))}
            </div>
          </Section>
        )}

        <Feedback answerId={answerId ?? null} serviceId={contract.service_id} />
      </div>
    </article>
  );
}
