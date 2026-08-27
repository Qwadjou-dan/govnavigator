'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiError, ask, listCategories, listServices } from '@/lib/api';
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

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setAnswers({});
    void run(text);
  }

  function useExample(example: string) {
    setText(example);
    setAnswers({});
    void run(example);
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
          <p className="label">Ghana · public services</p>
          <h1 className="mx-auto mt-2 max-w-2xl text-3xl font-extrabold leading-[1.1] tracking-tight text-balance sm:text-[2.75rem]">
            What do you want to do?
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed soft text-pretty">
            Say it however you would say it to a friend. We will tell you which office is
            responsible, exactly what to bring, what it costs today and in what order — and show you
            the official source for every line.
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
              placeholder="e.g. I want to register my salon"
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
              <ServiceCard
                contract={result.contract}
                answerId={result.answer_id}
                onAsk={(t) => {
                  setText(t);
                  setAnswers({});
                  void run(t);
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
                onPick={(id) => run(asked, { serviceId: id })}
              />
            )}

            {result.outcome === 'blocked' && <BlockedCard message={result.message} />}
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
