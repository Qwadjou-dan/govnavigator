'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { CandidateService, ClarifyQuestion, Institution, TraceStage } from '@/lib/types';
import { Icon } from './ui';
import { TalkToHuman } from './TalkToHuman';

/* ------------------------------------------------------------- trace */

const STAGE_LABEL: Record<string, string> = {
  intake: 'Read your question',
  scope: 'Checked what we may answer',
  retrieval: 'Searched official sources',
  intent: 'Worked out what you meant',
  clarify: 'Needed one more detail',
  assembly: 'Assembled from verified content',
  validation: 'Checked every fact against its source',
  freshness: 'Checked how recent it is',
  refusal: 'Declined rather than guessed',
};

/**
 * Showing the pipeline is not a debug panel. It is the trust mechanism: a
 * person deciding whether to travel on the strength of this answer can see
 * that it was retrieved and checked rather than composed.
 */
export function TraceStrip({ stages, latency }: { stages: TraceStage[]; latency: number }) {
  const [open, setOpen] = useState(false);
  if (!stages.length) return null;

  return (
    <div className="no-print">
      <button
        onClick={() => setOpen((o) => !o)}
        className="group inline-flex items-center gap-2 rounded-lg px-2 py-1.5 -mx-2 text-xs font-medium muted transition-colors hover:text-ink dark:hover:text-night-text"
        aria-expanded={open}
      >
        <Icon.shield className="h-3.5 w-3.5 text-brand-500" />
        <span>How we got this answer</span>
        <span className="rounded bg-paper-sunk px-1.5 py-0.5 font-mono text-2xs dark:bg-night-sunk">
          {stages.length} checks · {latency}ms
        </span>
        <Icon.chevron className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <ol className="mt-2 space-y-1.5 animate-rise">
          {stages.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 text-xs">
              <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-500/12 font-mono text-[9px] font-bold text-brand-600 dark:text-brand-300">
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="font-semibold">{STAGE_LABEL[s.stage] ?? s.stage}</span>
                <span className="soft"> — {s.detail}</span>
                {Array.isArray(s.dropped) && (s.dropped as string[]).length > 0 && (
                  <ul className="mt-0.5 space-y-0.5 muted">
                    {(s.dropped as string[]).map((d, di) => (
                      <li key={di}>· removed {d}</li>
                    ))}
                  </ul>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- clarify */

export function ClarifyCard({
  clarify,
  serviceName,
  candidates,
  onAnswer,
  onSkip,
}: {
  clarify: ClarifyQuestion;
  serviceName: string | null;
  candidates: CandidateService[];
  onAnswer: (id: string, value: string) => void;
  onSkip: () => void;
}) {
  const isServicePicker = clarify.id === 'which_service';
  return (
    <div className="surface animate-rise px-5 py-5 sm:px-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500/12">
          <Icon.info className="h-4 w-4 text-brand-600 dark:text-brand-300" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold leading-snug text-balance">{clarify.question}</h2>
          <p className="mt-1 text-sm soft text-pretty">
            {isServicePicker
              ? 'More than one service fits what you described, and the requirements differ. Rather than pick for you, we would rather ask.'
              : serviceName
                ? `We think you mean ${serviceName}. This one detail changes what you need to bring.`
                : 'This one detail changes what you need to bring.'}
          </p>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {clarify.options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onAnswer(clarify.id, opt.value)}
                className="surface-sunk group flex items-center justify-between gap-3 px-4 py-3 text-left transition-all hover:border-brand-400 hover:shadow-card"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold group-hover:text-brand-600 dark:group-hover:text-brand-300">
                    {opt.label}
                  </span>
                  {opt.hint && <span className="mt-0.5 block text-xs muted">{opt.hint}</span>}
                </span>
                <Icon.arrow className="h-4 w-4 shrink-0 muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand-500" />
              </button>
            ))}
          </div>

          {clarify.allow_skip && (
            <button onClick={onSkip} className="btn-quiet mt-3 !px-0">
              Not sure — show me the most common case
            </button>
          )}

          {isServicePicker && candidates.length > 0 && (
            <p className="mt-3 text-xs muted">
              Ranked by how closely each matched: {candidates.map((c) => `${c.name} (${Math.round(c.score * 100)}%)`).join(', ')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- refusal */

export function RefusalCard({
  message,
  institution,
  candidates,
  onPick,
  queryText,
}: {
  message: string;
  institution: Institution | null;
  candidates: CandidateService[];
  onPick: (id: string) => void;
  /** The question that led here — the escalation log ranks on it. */
  queryText?: string;
}) {
  return (
    <div className="surface animate-rise px-5 py-5 sm:px-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ochre-100 dark:bg-ochre-700/25">
          <Icon.warn className="h-4 w-4 text-ochre-700 dark:text-ochre-300" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold">We would rather not guess</h2>
          <p className="mt-1.5 text-sm leading-relaxed soft text-pretty">{message}</p>

          {institution && (
            <div className="surface-sunk mt-4 px-4 py-3.5">
              <p className="label">Most likely responsible</p>
              <p className="mt-1 text-sm font-bold">{institution.name}</p>
              {institution.mandate && <p className="mt-1 text-xs soft text-pretty">{institution.mandate}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {institution.official_url && (
                  <a href={institution.official_url} target="_blank" rel="noopener noreferrer" className="btn-primary">
                    <Icon.link /> Their official page
                  </a>
                )}
                <Link href={`/institutions/${institution.id}`} className="btn-ghost">
                  Contact details
                </Link>
              </div>
            </div>
          )}

          {candidates.length > 0 && (
            <div className="mt-4">
              <p className="label mb-2">Did you mean one of these instead?</p>
              <div className="flex flex-wrap gap-2">
                {candidates.map((c) => (
                  <button key={c.id} onClick={() => onPick(c.id)} className="chip">
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* With nothing close enough to suggest honestly, the card would
              otherwise be a dead end. Offer the two doors that are always
              true — the verified list, and the institution directory —
              rather than inventing a third that is not. */}
          {!institution && candidates.length === 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/services" className="btn-ghost">
                <Icon.doc /> See what we do cover
              </Link>
              <Link href="/institutions" className="btn-ghost">
                <Icon.building /> Find the right institution
              </Link>
            </div>
          )}

          <p className="mt-4 text-xs muted text-pretty">
            Your question has been logged. The services people ask for most are the ones we verify next —
            refusing today is how we decide what to cover tomorrow.
          </p>

          <div className="mt-3 border-t hairline pt-3">
            <TalkToHuman
              queryText={queryText ?? message}
              institution={institution}
              outcome="refused"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- blocked */

export function BlockedCard({ message, queryText }: { message: string; queryText?: string }) {
  return (
    <div className="surface animate-rise px-5 py-5 sm:px-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-paper-sunk dark:bg-night-sunk">
          <Icon.shield className="h-4 w-4 muted" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold">That is outside what we do</h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed soft text-pretty">{message}</p>

          <div className="mt-3 border-t hairline pt-3">
            <TalkToHuman queryText={queryText ?? message} institution={null} outcome="blocked" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- loading */

export function AnswerSkeleton() {
  return (
    <div className="surface animate-rise overflow-hidden" aria-busy="true" aria-live="polite">
      <div className="space-y-3 border-b hairline px-5 py-5 sm:px-6">
        <div className="skeleton h-4 w-28" />
        <div className="skeleton h-6 w-3/4" />
        <div className="skeleton h-3 w-full max-w-lg" />
        <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
          <div className="skeleton h-14" />
          <div className="skeleton h-14" />
          <div className="skeleton h-14 col-span-2 sm:col-span-1" />
        </div>
      </div>
      <div className="space-y-3 px-5 py-5 sm:px-6">
        <div className="skeleton h-3 w-40" />
        <div className="skeleton h-12" />
        <div className="skeleton h-12" />
        <div className="skeleton h-12" />
      </div>
    </div>
  );
}

/**
 * The loading sequence names each stage as it happens. Watching the system
 * find sources is itself a trust signal: it makes the mechanism legible
 * instead of magical.
 */
export function ThinkingStrip() {
  const steps = ['Reading your question', 'Searching official sources', 'Checking every fact against its source'];
  return (
    <div className="no-print flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs muted">
      {steps.map((s, i) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulseDot"
            style={{ animationDelay: `${i * 0.22}s` }}
          />
          {s}
        </span>
      ))}
    </div>
  );
}
