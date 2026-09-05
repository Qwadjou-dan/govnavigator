'use client';

import type { Assumption, DirectAnswer, SourceRef } from '@/lib/types';
import { Icon } from './ui';

/**
 * What the answer took as given.
 *
 * Where a service branches, something has to be chosen before there is
 * anything to display. Choosing silently is the dangerous option: a person
 * reading a fee for a situation that is not theirs has no way to tell. So the
 * choice is stated in one line, attributed honestly to either their own words
 * or our default, and undone in one click.
 */
export function AssumptionStrip({
  assumptions,
  onRevise,
}: {
  assumptions: Assumption[];
  onRevise?: (id: string, value: string) => void;
}) {
  if (assumptions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-dashed border-ink-line px-3.5 py-2.5 text-xs dark:border-night-line">
      <Icon.info className="h-3.5 w-3.5 shrink-0 muted" />
      {assumptions.map((a) => (
        <span key={a.id} className="inline-flex flex-wrap items-center gap-1.5">
          <span className="soft">
            {a.origin === 'question' ? 'From your question we took' : 'Showing the usual case,'}{' '}
            <strong className="font-semibold text-ink dark:text-night-text">{a.label}</strong>
          </span>
          {onRevise && (
            <button
              onClick={() => onRevise(a.id, '')}
              className="font-semibold text-brand-600 underline underline-offset-2 dark:text-brand-300"
              title={a.question}
            >
              change
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * The answer to the question, above the answer to the service.
 *
 * A checklist answers "what does this service require". It cannot answer "can
 * I do this for my brother, who is in London" — it can only present steps that
 * quietly assume a different situation, which is how a person ends up at an
 * office they were never eligible to attend. This band answers the sentence
 * that was typed, in at most three cited lines, and is at its most useful when
 * it says the sources do not cover that situation at all.
 *
 * Everything here was written by the model and then checked: text whose
 * citations did not resolve was discarded server-side before it arrived.
 */
export function DirectAnswerBand({
  answer,
  sources,
}: {
  answer: DirectAnswer;
  sources: SourceRef[];
}) {
  const cited = sources.filter((s) => answer.source_ids.includes(s.id));
  const notAddressed = answer.verdict === 'not_addressed';
  const partly = answer.verdict === 'partly_addressed';

  // Nothing survived validation and nothing to explain — say nothing rather
  // than render an empty box with a confident heading on it.
  if (notAddressed && !answer.text && !answer.question_understood) return null;

  const tone = notAddressed
    ? 'border-ochre-300/70 bg-ochre-100/50 dark:border-ochre-700/50 dark:bg-ochre-700/10'
    : 'border-brand-200 bg-brand-50/70 dark:border-brand-800/70 dark:bg-brand-900/20';

  const badge = notAddressed
    ? 'bg-ochre-500 text-white'
    : 'bg-brand-600 text-white shadow-[0_4px_10px_-4px_rgba(79,70,229,.6)]';

  return (
    <section className={`rounded-2xl border p-4 sm:p-5 ${tone}`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${badge}`}>
          {notAddressed ? <Icon.warn className="h-4 w-4" /> : <Icon.spark className="h-4 w-4" />}
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-bold tracking-tight sm:text-base">
            {notAddressed
              ? 'We cannot answer that part'
              : partly
                ? 'Part of what you asked'
                : 'What you asked'}
          </h3>

          {answer.question_understood && (
            <p className="mt-1 text-xs muted text-pretty">
              We read your question as: {answer.question_understood}
            </p>
          )}

          {answer.text ? (
            <p className="mt-2.5 text-[15px] font-medium leading-relaxed text-pretty">
              {answer.text}
            </p>
          ) : (
            <p className="mt-2.5 text-sm leading-relaxed soft text-pretty">
              The official sources we hold set out how this service works, but they do not cover
              your particular situation. The card below is what they do say — treat anything about
              your case as unconfirmed, and check with the institution before you travel or pay.
            </p>
          )}

          {cited.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-black/5 pt-2.5 dark:border-white/10">
              <span className="label">From</span>
              {cited.map((s) => (
                <a
                  key={s.id}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg bg-paper/70 px-2 py-1 text-xs font-medium transition-colors hover:text-brand-600 dark:bg-night/40 dark:hover:text-brand-300"
                >
                  <Icon.link className="h-3 w-3 shrink-0" />
                  {/* The title, not the publisher: two pages from the same
                      agency would otherwise render as identical chips. */}
                  <span className="max-w-[16rem] truncate">{s.title}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
