'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listInstitutions } from '@/lib/api';
import type { Institution } from '@/lib/types';
import { Icon } from '@/components/ui';

/**
 * This page is the Tier 2 directory made visible. Even where we cannot answer
 * "what exactly do I do", knowing which institution is responsible is worth
 * more than nothing — it is usually the thing the person did not know.
 */
export default function InstitutionsPage() {
  const [items, setItems] = useState<Institution[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listInstitutions()
      .then(setItems)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const deep = items.filter((i) => i.coverage_tier === 1);
  const directory = items.filter((i) => i.coverage_tier !== 1);

  function Card({ inst }: { inst: Institution }) {
    return (
      <Link
        href={`/institutions/${inst.id}`}
        className="surface group flex flex-col p-4 transition-all hover:border-brand-300 hover:shadow-lift"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/12 text-brand-600 dark:text-brand-300">
            <Icon.building className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold group-hover:text-brand-600 dark:group-hover:text-brand-300">
              {inst.abbreviation || inst.name}
            </span>
            {inst.abbreviation && (
              <span className="block truncate text-2xs muted">{inst.name}</span>
            )}
          </span>
        </div>
        {inst.mandate && <p className="mt-2 line-clamp-3 text-sm soft text-pretty">{inst.mandate}</p>}
      </Link>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight">Institutions</h1>
        <p className="mt-1.5 max-w-2xl text-sm soft text-pretty">
          Who is responsible for what. When we cannot verify a service in detail, we can still tell
          you which office owns it and how to reach them — which is usually the thing you did not
          know.
        </p>
      </header>

      {loading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="skeleton h-32" />
          ))}
        </div>
      )}

      {deep.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-bold tracking-tight">Verified in detail</h2>
            <p className="mt-0.5 text-sm soft">
              We hold checked requirements, documents, fees and steps for these.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {deep.map((i) => (
              <Card key={i.id} inst={i} />
            ))}
          </div>
        </section>
      )}

      {directory.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-bold tracking-tight">Directory only</h2>
            <p className="mt-0.5 text-sm soft text-pretty">
              We know who they are and what they do, but we have not yet verified their services
              field by field. We will say so rather than guess.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {directory.map((i) => (
              <Card key={i.id} inst={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
