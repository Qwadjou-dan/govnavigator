# Verification runbook — the 27-card audit

How the GovNavigator team confirms every service card against its institution.
Nothing else in Phase 5 matters if the content is wrong: someone will travel to
an office on the strength of an answer, and the metric that counts is whether
what they found matched.

## What "verified" means here

"Team-verified" is a specific, narrow claim: **a person has read the card
against the institution's own publication and confirmed the facts.** It
happens in two places:

1. **The facts** — corrected in the content files (`backend/app/content/*.json`)
   through a pull request, so every change is visible next to its source.
2. **The status** — the `Verify` button in `/admin` (the verification audit
   table) stamps the card: it records *who* and *when*, bumps `content_version`,
   and is the only action that removes the **"has not yet been confirmed by our
   team"** caveat from every future answer for that card.

Verifying the status without checking the facts is worse than not verifying —
it removes the caveat that protects the reader.

## How the console ranks the work

`/admin` → **Verification audit** sorts the 27 cards *needs action first*, then
alphabetically. A card needs action when any of these is true:

| Signal | Meaning |
|---|---|
| Unverified | `reviewed_at` is empty — no one has confirmed it yet |
| `stale` / `verify` | Its **oldest** source is older than 240 / 120 days. Ghanaian fee schedules moved twice in the last year, so a card is only as fresh as its oldest citation |
| No official source | `official_source_count == 0` — there is no institution-published citation to stand on |

Work the table top-down. The printer-friendly companion is the generated
worksheet:

```bash
python -m app.scripts.audit_worksheet --out docs/VERIFICATION_WORKSHEET.md
```

## The per-card checklist

For every card, confirm the following against the linked official publication:

1. **Eligibility** — who can apply; any age, residency or status condition.
2. **Required documents** — every mandatory document exists and is actually
   asked for; the `where_to_obtain` note is still right.
3. **Fees** — the amount **and its effective date** (this is what changes most
   often). If the institution publishes no amount, the card must say
   *Not published*, never a guess.
4. **Steps** — the order, the channel (online / in person / both), and where.
5. **Timeline** — standard and any expedited time, or *not published*.

Each source URL listed for the card is in the worksheet. Follow it; if the URL
is dead or has moved, that is itself a finding — record it and update the
source rather than silently dropping it.

## Worked example — the passport fee dispute

The card for a first-time passport has two **official** sources that disagree:
the Ministry announced **GH¢350** (effective 13 Nov 2025); the official portal
still shows **GH¢500**. The correct response is **not** to pick one. Both are
shown, each with its citation, and a `dispute` caveat tells the reader. If a
verifier finds a newer official figure, they should **not** delete the older
side — they should add the new figure and update the caveat, keeping both
citations until the older source is withdrawn.

## Recording a finding

- **Correct a fact** → edit the service's JSON in `backend/app/content/`,
  push a PR, and note which source supports the change. After merge, re-seed
  (`python -m app.scripts.seed --reset`) or let the ingest pipeline's
  change detection confirm the source content first (see `docs/INGESTION.md`).
- **Confirm a card is right as-is** → click **Verify** in the audit table.
- **Report a mismatch from the field** → that is the *Corrections* queue;
  people who went to the office are the highest-value verifiers of all.

## Do not

- Do not mark verified from a secondary/aggregator source — only the
  institution's own publication removes the caveat's authority concern.
- Do not invent an amount or timeline because one "should" exist — `not_published`
  is the honest answer and is itself useful.
- Do not remove a disputed figure because it is inconvenient — uncertainty
  that is shown is safe; uncertainty that is hidden is a lawsuit waiting.

## Definition of done for this audit

`/admin` summary shows **27 / 27 verified** and no rows flagged `needs_action`
for unverified or stale. Work the coverage backlog next — it ranks what real
users asked for and did not get, which is the demand signal for what to verify
first as the corpus grows.