'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { getInstitution } from '@/lib/api';
import type { Institution, ServiceSummary } from '@/lib/types';
import { Empty, Icon, Section } from '@/components/ui';

/**
 * One institution's page, from /institutions/{id}: the contact details the
 * directory holds (office, phone, email, hours, official/portal links), any
 * `notes` the team keeps about it (rendered as an amber call-out — the only
 * surfaced place a caution that isn't a user-facing claim), its office list,
 * and links into each of its verified services. Unknown id → the Empty state;
 * in-flight → skeleton.
 */
export default function InstitutionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{
    institution: Institution;
    notes: string;
    services: ServiceSummary[];
  } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    getInstitution(id)
      .then(setData)
      .catch(() => setError(true));
  }, [id]);

  if (error) {
    return (
      <Empty
        title="We do not have a directory entry for that institution"
        body="Try the institutions list, or ask the navigator in your own words."
        icon={<Icon.building className="h-5 w-5" />}
      />
    );
  }

  if (!data) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-8 w-64" />
        <div className="skeleton h-40" />
      </div>
    );
  }

  const inst = data.institution;

  return (
    <div className="space-y-6">
      <Link href="/institutions" className="btn-quiet !px-2 no-print">
        <Icon.back /> All institutions
      </Link>

      <header className="surface px-5 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-500/12 text-brand-600 dark:text-brand-300">
            <Icon.building className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold leading-tight tracking-tight text-balance sm:text-2xl">
              {inst.name}
            </h1>
            {inst.abbreviation && (
              <p className="mt-0.5 text-sm font-semibold muted">{inst.abbreviation}</p>
            )}
          </div>
        </div>

        {inst.mandate && <p className="mt-3 text-sm leading-relaxed soft text-pretty">{inst.mandate}</p>}

        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          {inst.head_office && (
            <div><dt className="label">Head office</dt><dd className="mt-0.5 soft text-pretty">{inst.head_office}</dd></div>
          )}
          {inst.digital_address && (
            <div><dt className="label">Digital address</dt><dd className="mt-0.5 font-mono">{inst.digital_address}</dd></div>
          )}
          {inst.phone && <div><dt className="label">Phone</dt><dd className="mt-0.5 soft">{inst.phone}</dd></div>}
          {inst.email && <div><dt className="label">Email</dt><dd className="mt-0.5 soft break-all">{inst.email}</dd></div>}
          {inst.opening_hours && (
            <div><dt className="label">Opening hours</dt><dd className="mt-0.5 soft">{inst.opening_hours}</dd></div>
          )}
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          {inst.official_url && (
            <a href={inst.official_url} target="_blank" rel="noopener noreferrer" className="btn-primary">
              <Icon.link /> Official website
            </a>
          )}
          {inst.portal_url && (
            <a href={inst.portal_url} target="_blank" rel="noopener noreferrer" className="btn-ghost">
              Online portal
            </a>
          )}
        </div>

        {data.notes && (
          <p className="mt-4 rounded-xl border border-ochre-300/60 bg-ochre-100/40 px-3.5 py-2.5 text-sm soft dark:border-ochre-700/50 dark:bg-ochre-700/10 text-pretty">
            {data.notes}
          </p>
        )}
      </header>

      {inst.offices.length > 0 && (
        <Section title="Where you can go" icon={<Icon.pin className="h-4 w-4 text-brand-500" />}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {inst.offices.map((o, i) => (
              <li key={i} className="surface-sunk flex items-start gap-2 px-3.5 py-2.5 text-sm soft">
                <Icon.pin className="mt-0.5 h-3.5 w-3.5 shrink-0 muted" />
                <span className="text-pretty">{o}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Services we have verified here"
        icon={<Icon.doc className="h-4 w-4 text-brand-500" />}
        count={data.services.length}
      >
        {data.services.length === 0 ? (
          <Empty
            title="No verified services yet"
            body="We know this institution and what it does, but we have not yet checked its services field by field. Use their official page above."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.services.map((s) => (
              <Link
                key={s.id}
                href={`/service/${s.id}`}
                className="surface group p-4 transition-all hover:border-brand-300 hover:shadow-lift"
              >
                <p className="text-sm font-bold group-hover:text-brand-600 dark:group-hover:text-brand-300">
                  {s.name}
                </p>
                <p className="mt-1 line-clamp-2 text-sm soft text-pretty">{s.summary}</p>
              </Link>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
