'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { listCategories, listServices } from '@/lib/api';
import type { Category, ServiceSummary } from '@/lib/types';
import { Empty, Icon } from '@/components/ui';

export default function ServicesPage() {
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [active, setActive] = useState<string>('all');
  const [term, setTerm] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([listServices(), listCategories()])
      .then(([s, c]) => {
        setServices(s);
        setCategories(c);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    return services.filter(
      (s) =>
        (active === 'all' || s.category === active) &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          s.summary.toLowerCase().includes(q) ||
          s.institution.name.toLowerCase().includes(q)),
    );
  }, [services, active, term]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight">Verified services</h1>
        <p className="mt-1.5 max-w-2xl text-sm soft text-pretty">
          Everything here has been built from official sources with a citation on each field. If you
          ask about something outside this list, the navigator will tell you so and route you to the
          institution rather than improvise an answer.
        </p>
      </header>

      <div className="space-y-3">
        <div className="surface flex items-center gap-2 px-3 py-2">
          <Icon.search className="h-4 w-4 muted" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Filter by name, institution or description"
            className="w-full bg-transparent py-1 text-sm outline-none placeholder:text-ink-faint dark:placeholder:text-night-faint"
          />
        </div>

        <div className="scroll-x -mx-1 px-1">
          <div className="flex min-w-max gap-2 pb-1">
            <button
              onClick={() => setActive('all')}
              className={`chip ${active === 'all' ? '!border-brand-400 !bg-brand-50 !text-brand-700 dark:!bg-brand-900/50 dark:!text-brand-200' : ''}`}
            >
              All ({services.length})
            </button>
            {categories.map((c) => {
              const n = services.filter((s) => s.category === c.id).length;
              return (
                <button
                  key={c.id}
                  onClick={() => setActive(c.id)}
                  className={`chip ${active === c.id ? '!border-brand-400 !bg-brand-50 !text-brand-700 dark:!bg-brand-900/50 dark:!text-brand-200' : ''}`}
                >
                  {c.label} ({n})
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {loading && (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-28" />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <Empty
          title="Nothing matches that filter"
          body="Try a different word, or ask the navigator in your own words on the home page — it understands goals, not just service names."
          icon={<Icon.search className="h-5 w-5" />}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {filtered.map((s) => (
          <Link
            key={s.id}
            href={`/service/${s.id}`}
            className="surface group flex flex-col gap-2 p-4 transition-all hover:border-brand-300 hover:shadow-lift"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-500/10 px-2 py-0.5 text-2xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-300">
                {s.institution.abbreviation || s.institution.name}
              </span>
              {s.reviewed ? (
                <span className="inline-flex items-center gap-1 text-2xs font-semibold text-brand-600 dark:text-brand-300">
                  <Icon.check className="h-3 w-3" /> team-verified
                </span>
              ) : (
                <span className="text-2xs muted">not yet team-verified</span>
              )}
            </div>
            <p className="text-[15px] font-bold leading-snug group-hover:text-brand-600 dark:group-hover:text-brand-300">
              {s.name}
            </p>
            <p className="line-clamp-2 text-sm soft text-pretty">{s.summary}</p>
            <p className="mt-auto pt-1 text-2xs font-medium muted">
              {s.document_count} things to bring · {s.step_count} steps
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
