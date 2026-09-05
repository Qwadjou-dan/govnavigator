'use client';

import { useState } from 'react';
import { requestEscalation } from '@/lib/api';
import type { Institution } from '@/lib/types';
import { Icon } from './ui';

/**
 * The named human route (FR-13). Two jobs in one control:
 *
 * 1. Put a real person within reach — the responsible institution's contact,
 *    which the card may or may not already carry.
 * 2. Log the click as a coverage request, because someone who escalates from
 *    a card we thought was answered is telling us what to verify next. That
 *    is how the coverage backlog gets its weight from real people.
 *
 * The contacts are revealed optimistically: even if the log call fails (no
 * signal, offline), the person still gets what they came for — a way to talk
 * to a human.
 */
export function TalkToHuman({
  queryText,
  institution,
  outcome = 'answered',
  serviceId,
  className,
}: {
  queryText: string;
  institution: Institution | null;
  outcome?: string;
  serviceId?: string | null;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'sent' | 'error'>('idle');

  if (!queryText.trim()) return null;

  async function escalate() {
    setState('sent');
    try {
      await requestEscalation({
        query_text: queryText,
        service_id: serviceId ?? null,
        institution_id: institution?.id ?? null,
        outcome,
      });
    } catch {
      setState('error');
    }
  }

  return (
    <div className={className}>
      <button onClick={escalate} disabled={state === 'sent'} className="btn-ghost">
        <Icon.chat className="h-3.5 w-3.5" /> Talk to a human
      </button>

      {state !== 'idle' && (
        <div className="surface-sunk mt-3 space-y-2 px-4 py-3.5 text-sm">
          <p className="soft text-pretty">
            {state === 'error'
              ? 'We could not log this right now, but the contacts below are real and current.'
              : 'We have flagged this for a member of the team. To speak to the institution directly:'}
          </p>

          {institution ? (
            <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              <dt className="sr-only">Institution</dt>
              <dd className="font-semibold">{institution.name}</dd>
              {institution.phone && (
                <>
                  <dt className="label">Phone</dt>
                  <dd className="soft">{institution.phone}</dd>
                </>
              )}
              {institution.email && (
                <>
                  <dt className="label">Email</dt>
                  <dd className="soft break-all">{institution.email}</dd>
                </>
              )}
              {institution.head_office && (
                <>
                  <dt className="label">In person</dt>
                  <dd className="soft">{institution.head_office}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="text-xs muted text-pretty">
              We do not have verified contact details for this one yet — your note is with the team, and
              we are working out where best to point people.
            </p>
          )}

          {institution?.official_url && (
            <a
              href={institution.official_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary mt-1 inline-flex !py-1.5 text-xs"
            >
              <Icon.link /> Official website
            </a>
          )}
        </div>
      )}
    </div>
  );
}