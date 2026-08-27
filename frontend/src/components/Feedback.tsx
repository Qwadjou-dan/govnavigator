'use client';

import { useState } from 'react';
import { sendFeedback } from '@/lib/api';
import { Icon, Spinner } from './ui';

/**
 * The question is deliberately not "was this helpful?".
 * "Was this what you found at the office?" is the only feedback that can
 * correct a fee, and it is the loop that keeps the corpus honest.
 */
export function Feedback({
  answerId,
  serviceId,
}: {
  answerId: string | null;
  serviceId: string | null;
}) {
  const [verdict, setVerdict] = useState<'yes' | 'partly' | 'no' | null>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(v: 'yes' | 'partly' | 'no', withComment = false) {
    setSending(true);
    setError(null);
    try {
      const res = await sendFeedback({
        answer_id: answerId,
        service_id: serviceId,
        verdict: v,
        comment: withComment ? comment : '',
      });
      setDone(res.message);
    } catch {
      setError('We could not record that just now. Your answer above is unaffected.');
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <div className="no-print flex items-start gap-2.5 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm dark:border-brand-700 dark:bg-brand-900/30">
        <Icon.check className="mt-0.5 h-4 w-4 text-brand-600 dark:text-brand-300" />
        <p className="soft text-pretty">{done}</p>
      </div>
    );
  }

  return (
    <div className="no-print surface-sunk px-4 py-4">
      <p className="text-sm font-semibold">Did this match what you found at the office?</p>
      <p className="mt-0.5 text-xs muted text-pretty">
        Not &ldquo;was it helpful&rdquo; — we need to know whether reality matched, so a curator can fix it.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {(
          [
            ['yes', 'Yes, it matched'],
            ['partly', 'Partly'],
            ['no', 'No, it was different'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            disabled={sending}
            onClick={() => {
              setVerdict(v);
              if (v === 'yes') void submit('yes');
            }}
            className={`chip ${verdict === v ? '!border-brand-400 !bg-brand-50 !text-brand-700 dark:!bg-brand-900/50 dark:!text-brand-200' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      {verdict && verdict !== 'yes' && (
        <div className="mt-3 space-y-2 animate-rise">
          <label htmlFor="fb" className="label block">
            What was different? (optional, but this is the part that helps)
          </label>
          <textarea
            id="fb"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="e.g. The fee at Kasoa was GH₵150, not GH₵130"
            className="w-full rounded-xl border border-ink-line bg-paper-raised px-3 py-2 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-brand-400 dark:border-night-line dark:bg-night-raised dark:placeholder:text-night-faint"
          />
          <button onClick={() => submit(verdict, true)} disabled={sending} className="btn-primary">
            {sending ? <Spinner /> : <Icon.arrow />} Send to a curator
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-flag-bad">{error}</p>}
    </div>
  );
}
