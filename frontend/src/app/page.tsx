'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiError, ask, listCategories, listServices, resetSession } from '@/lib/api';
import type { Category, QueryResponse, ServiceSummary } from '@/lib/types';
import {
  AnswerSkeleton,
  BlockedCard,
  ClarifyCard,
  RefusalCard,
  ThinkingStrip,
  TraceStrip,
} from '@/components/AnswerStates';
import { ServiceCard } from '@/components/ServiceCard';
import { TalkToHuman } from '@/components/TalkToHuman';
import { Icon, Spinner } from '@/components/ui';

/**
 * Every example is a real phrasing from the alias sets in the knowledge base,
 * not invented marketing copy. The empty state should teach people that they
 * can type the way they actually speak.
 */
const EXAMPLES = [
  'I wan make my business proper',
  'my licence don expire, how much I go pay?',
  'I never get passport before — wetin I need?',
  'dem say make I bring digital address',
  'I get workers, I need SSNIT number',
  'how I go get birth certificate for my pikin',
];

export default function Home() {
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  // The visible conversation: every sentence the person has put to us this
  // session, oldest first. The latest result renders below it.
  const [thread, setThread] = useState<Array<{ q: string; id: number }>>([]);
  const [showOtherOptions, setShowOtherOptions] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listServices().then(setServices).catch(() => undefined);
    listCategories().then(setCategories).catch(() => undefined);
  }, []);

  const run = useCallback(
    async (
      question: string,
      opts: {
        answers?: Record<string, string>;
        serviceId?: string;
        skip?: boolean;
        reopen?: string;
      } = {},
    ) => {
      const q = question.trim();
      if (!q) return;
      setLoading(true);
      setError(null);
      setAsked(q);
      try {
        const res = await ask({
          text: q,
          answers: opts.answers ?? {},
          service_id: opts.serviceId,
          skip_clarification: opts.skip,
          reopen: opts.reopen,
        });
        setResult(res);
        if (res.outcome !== 'clarify') setAnswers({});
        requestAnimationFrame(() =>
          resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
      } catch (err) {
        setResult(null);
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  /** Every new question a person types — first or follow-up — passes through
   *  here. It joins the visible thread and carries the same session, so a
   *  follow-up continues the conversation server-side. */
  const submitQuestion = useCallback(
    (question: string, opts: Parameters<typeof run>[1] = {}) => {
      const q = question.trim();
      if (!q) return;
      setThread((t) => [...t, { q, id: Date.now() }]);
      setAsked(q);
      setShowOtherOptions(false);
      void run(q, opts);
    },
    [run],
  );

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setAnswers({});
    setText('');
    submitQuestion(text);
  }

  function useExample(example: string) {
    setAnswers({});
    submitQuestion(example);
    inputRef.current?.focus();
  }

  /** Clear the thread and mint a fresh server session, so the next question
   *  starts over and memory of this conversation stops steering anything. */
  function startOver() {
    resetSession();
    setThread([]);
    setResult(null);
    setAsked('');
    setAnswers({});
    setText('');
    setShowOtherOptions(false);
    inputRef.current?.focus();
  }

  function answerClarifier(id: string, value: string) {
    const next = { ...answers, [id]: value };
    setAnswers(next);
    if (id === 'which_service') void run(asked, { serviceId: value, answers: next });
    else void run(asked, { answers: next });
  }

  const grouped = categories
    .map((cat) => ({ cat, items: services.filter((s) => s.category === cat.id) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="space-y-10">
      {/* --------------------------------------------------------- hero */}
      {!result && !loading && (
        <section className="pt-4 text-center sm:pt-10">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-2xs font-semibold uppercase tracking-[0.09em] text-brand-700 dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-200">
            <Icon.spark className="h-3 w-3" /> AI guide to Ghana&rsquo;s public services
          </span>
          <h1 className="mx-auto mt-4 max-w-2xl text-4xl font-extrabold leading-[1.08] tracking-tight text-balance sm:text-5xl">
            What do you want to do?
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed soft text-pretty">
            Say it however you would say it to a friend. We tell you which office is responsible,
            exactly what to bring, what it costs today and in what order — with the official source
            for every line.
          </p>
        </section>
      )}

      {/* ---------------------------------------------------------- ask */}
      <section className={result || loading ? '' : '-mt-4'}>
        <form onSubmit={submit} className="relative">
          <div className="surface flex items-end gap-2 p-2 shadow-lift transition-shadow focus-within:ring-2 focus-within:ring-brand-400/50">
            <label htmlFor="ask" className="sr-only">
              What do you want to do with a government office?
            </label>
            <textarea
              id="ask"
              ref={inputRef}
              rows={1}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) submit(e as unknown as React.FormEvent);
              }}
              placeholder={thread.length > 0 ? 'Ask a follow-up… it stays on this thread' : 'e.g. I want to register my salon'}
              maxLength={1000}
              className="max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] leading-relaxed outline-none placeholder:text-ink-faint dark:placeholder:text-night-faint"
            />
            <button type="submit" disabled={loading || !text.trim()} className="btn-primary shrink-0">
              {loading ? <Spinner /> : <Icon.search />}
              <span className="hidden sm:inline">{loading ? 'Checking' : 'Get guidance'}</span>
            </button>
          </div>
        </form>

        {!result && !loading && (
          <div className="mt-4">
            <p className="label mb-2 text-center sm:text-left">Real questions people ask</p>
            <div className="flex flex-wrap justify-center gap-2 sm:justify-start">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => useExample(ex)} className="chip">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------- result */}
      <div ref={resultRef} className="scroll-mt-20 space-y-4">
        {/* The conversation, visible. Each sentence the person put to us sits
            in the thread; the guidance beneath it is a transcript, not a
            fresh page each time. */}
        {thread.length > 0 && (
          <div className="flex flex-col items-end gap-2">
            {thread.map((t) => (
              <div
                key={t.id}
                className="inline-flex max-w-[88%] items-center gap-2 rounded-2xl rounded-br-md border hairline bg-paper-sunk px-3.5 py-2 dark:bg-night-sunk sm:max-w-[75%]"
              >
                <span className="shrink-0 text-2xs font-bold uppercase tracking-wider muted">You</span>
                <p className="whitespace-pre-wrap text-sm font-medium text-ink dark:text-night-text">{t.q}</p>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <>
            <ThinkingStrip />
            <AnswerSkeleton />
          </>
        )}

        {error && !loading && (
          <div className="surface flex items-start gap-3 px-5 py-4">
            <Icon.warn className="mt-0.5 h-4 w-4 text-flag-bad" />
            <div>
              <p className="text-sm font-semibold">We could not complete that</p>
              <p className="mt-1 text-sm soft text-pretty">{error}</p>
              <button onClick={() => run(asked)} className="btn-ghost mt-3">
                Try again
              </button>
            </div>
          </div>
        )}

        {result && !loading && (
          <>
            {result.stages.length > 0 && (
              <TraceStrip stages={result.stages} latency={result.latency_ms} />
            )}

            {result.outcome === 'answered' && result.contract && (
              <>
                <ServiceCard
                  contract={result.contract}
                  answerId={result.answer_id}
                  onAsk={(t) => {
                    setAnswers({});
                    submitQuestion(t);
                  }}
                  onRevise={(id) => {
                    // Drop the assumed condition and ask again, so the app puts
                    // the choice back to the person instead of re-guessing it.
                    const next = { ...answers };
                    delete next[id];
                    setAnswers(next);
                    void run(asked, { answers: next, reopen: id });
                  }}
                />

                {/* Wrong-answer recovery: the card above is what we matched, but
                    if it is not what the person meant, the runner-up services
                    from that same search are one tap away. Re-picking keeps the
                    conversation and re-answers with the chosen service. */}
                {result.candidates.length > 0 && (
                  <div className="surface px-4 py-3">
                    <button
                      onClick={() => setShowOtherOptions((v) => !v)}
                      className="flex w-full items-center justify-between gap-3 text-sm"
                      aria-expanded={showOtherOptions}
                    >
                      <span className="font-medium">Not what you meant?</span>
                      <Icon.arrow
                        className={`h-4 w-4 muted transition-transform ${showOtherOptions ? 'rotate-90' : ''}`}
                      />
                    </button>
                    {showOtherOptions && (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {result.candidates.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => {
                              setShowOtherOptions(false);
                              void run(asked, { serviceId: c.id });
                            }}
                            className="surface-sunk group px-3.5 py-3 text-left transition-colors hover:border-brand-300"
                          >
                            <span className="block truncate text-sm font-semibold group-hover:text-brand-600 dark:group-hover:text-brand-300">
                              {c.name}
                            </span>
                            <span className="mt-0.5 block text-xs muted">{c.institution}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {result.outcome === 'clarify' && result.clarify && (
              <ClarifyCard
                clarify={result.clarify}
                serviceName={result.service_name}
                candidates={result.candidates}
                onAnswer={answerClarifier}
                onSkip={() => run(asked, { answers, skip: true })}
              />
            )}

            {result.outcome === 'refused' && (
              <RefusalCard
                message={result.message}
                institution={result.suggested_institution}
                candidates={result.candidates}
                queryText={asked}
                onPick={(id) => run(asked, { serviceId: id })}
              />
            )}

            {result.outcome === 'blocked' && <BlockedCard message={result.message} queryText={asked} />}

            {/* A card we built may still not cover the person's situation —
                the named way off is to a human. Logged as a coverage request. */}
            {result.outcome === 'answered' && result.contract && (
              <TalkToHuman
                queryText={asked}
                institution={result.contract.institution}
                serviceId={result.contract.service_id}
                outcome="answered"
              />
            )}

            {/* Keep the conversation going on the same screen. The ask box at
                the top is the persistent "ask a follow-up" — same session, so
                branch choices and the service carry forward. Start over mints
                a fresh session instead. */}
            <div className="flex flex-wrap items-center gap-2 border-t hairline pt-4">
              <span
                className="inline-flex items-center gap-1.5 text-xs muted"
              >
                <Icon.chat className="h-3.5 w-3.5" />
                Ask a follow-up above — it stays on the same thread
              </span>
              <button
                onClick={startOver}
                className="btn-ghost ml-auto !px-3 !py-1.5 text-xs"
              >
                <Icon.refresh /> Start over
              </button>
            </div>
          </>
        )}
      </div>

      {/* ----------------------------------------------------- browse */}
      {!result && !loading && grouped.length > 0 && (
        <section className="space-y-5 border-t hairline pt-8">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold tracking-tight">Or browse what we have verified</h2>
              <p className="mt-1 text-sm soft text-pretty">
                {services.length} services checked against official sources. Anything outside this
                list, we will say so rather than guess.
              </p>
            </div>
            <Link href="/services" className="btn-quiet shrink-0 !px-2">
              See all <Icon.arrow />
            </Link>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {grouped.slice(0, 4).map(({ cat, items }) => (
              <div key={cat.id} className="surface p-4">
                <p className="label">{cat.label}</p>
                <ul className="mt-2 space-y-0.5">
                  {items.slice(0, 4).map((s) => (
                    <li key={s.id}>
                      <button
                        onClick={() => useExample(s.short_name || s.name)}
                        className="group flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 -mx-2 text-left transition-colors hover:bg-paper-sunk dark:hover:bg-night-sunk"
                      >
                        <span className="min-w-0 truncate text-sm font-medium group-hover:text-brand-600 dark:group-hover:text-brand-300">
                          {s.short_name || s.name}
                        </span>
                        <span className="shrink-0 text-2xs font-semibold muted">
                          {s.institution.abbreviation}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---------------------------------------------------- how it works */}
      {!result && !loading && (
        <section className="grid gap-3 border-t hairline pt-8 sm:grid-cols-3">
          {[
            {
              icon: <Icon.search className="h-4 w-4" />,
              title: 'It reads your goal, not keywords',
              body: 'The State organises information by institution and procedure. You arrive with a goal. Translating one into the other is the whole job.',
            },
            {
              icon: <Icon.shield className="h-4 w-4" />,
              title: 'Every fact carries its source',
              body: 'Fees, documents and timelines are checked against the official page they came from. Anything that cannot be traced is removed before you see it.',
            },
            {
              icon: <Icon.warn className="h-4 w-4" />,
              title: 'It says no rather than guess',
              body: 'A confidently wrong requirement costs you a wasted trip. When we cannot cite a source, we say so and point you at who can.',
            },
          ].map((c) => (
            <div key={c.title} className="surface p-4">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500/12 text-brand-600 dark:text-brand-300">
                {c.icon}
              </span>
              <p className="mt-3 text-sm font-bold leading-snug">{c.title}</p>
              <p className="mt-1.5 text-sm soft text-pretty">{c.body}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
