'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, getService } from '@/lib/api';
import type { AnswerContract } from '@/lib/types';
import { ServiceCard } from '@/components/ServiceCard';
import { AnswerSkeleton } from '@/components/AnswerStates';
import { Icon } from '@/components/ui';

/**
 * Deep link for one service card: fetches /services/{id}, which returns the
 * same fully validated Answer Contract the /query pipeline would, and renders
 * it through the shared ServiceCard (no onRevise here — there is no
 * conversation, so assumed conditions are stated but not undoable).
 *
 * Related-services chips (onAsk) can't re-enter this page's own conversation
 * (there isn't one), so they navigate to "/?q=<service name>" for Home to pick
 * up and ask on the main loop instead.
 */
export default function ServiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [contract, setContract] = useState<AnswerContract | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getService(id)
      .then(setContract)
      .catch((e) =>
        setError(
          e instanceof ApiError && e.status === 404
            ? 'We do not have a service card with that name.'
            : 'We could not load this service just now.',
        ),
      );
  }, [id]);


  return (
    <div className="space-y-4">
      <div className="no-print flex items-center justify-between gap-3">
        <Link href="/services" className="btn-quiet !px-2">
          <Icon.back /> All services
        </Link>
      </div>

      {error && (
        <div className="surface flex items-start gap-3 px-5 py-4">
          <Icon.warn className="mt-0.5 h-4 w-4 text-flag-bad" />
          <div>
            <p className="text-sm font-semibold">{error}</p>
            <Link href="/" className="btn-ghost mt-3">
              Ask in your own words instead
            </Link>
          </div>
        </div>
      )}

      {!contract && !error && <AnswerSkeleton />}
      {contract && <ServiceCard contract={contract} onAsk={(t) => router.push(`/?q=${encodeURIComponent(t)}`)} />}
    </div>
  );
}
