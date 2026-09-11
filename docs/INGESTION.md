# Ingestion & change detection (FR-10)

How GovNavigator keeps the corpus in step with what institutions actually
publish, without ever letting an automated crawl put untrusted text in front of
the public.

## The pipeline is observational

`python -m app.scripts.ingest` fetches every allowed source, hashes the raw
response bytes, and records an append-only `crawl_snapshots` row. It is a
**change detector**, not a crawler of content: it does not parse pages, extract
facts, or write to `sources`, `services` or `chunks`. The only thing it mutates
is its own snapshot table.

This is deliberate. A crawled page is untrusted input — see
`backend/app/ai/guardrails.py`, which is built around the assumption that
anything on the internet may contain anything. If a crawl pasted the page into
the answer the public reads, one changed fee schedule would ship a wrong number
with our name on it. So change detection ends in a **report to a curator**, and
the change itself lands through the same review path as everything else: an
edit to the content files, a pull request, a re-seed.

## Run it

```bash
cd backend
python -m app.scripts.ingest                     # all sources
python -m app.scripts.ingest --limit 3           # first 3 sources (smoke test)
python -m app.scripts.ingest --json report.json  # machine-readable report
python -m app.scripts.ingest --reembed           # re-embed existing chunks, no crawl
```

Per-source failures are isolated: one dead or slow source becomes a `FAILED`
row and the run continues.

## Read a report

Each row classifies against that source's *previous* snapshot:

| Flag | Meaning | Response |
|---|---|---|
| `NEW` | First time we have a baseline for this URL | Nothing — it is the baseline |
| `UNCHANGED` | Same bytes as last run | Nothing |
| `CHANGED` | Bytes differ from the last snapshot | **Action** — see below |
| `FAILED` | Request error or HTTP ≥ 400 | Check whether the site is down or the URL moved; fix the source if the URL is dead |

`CHANGED` is the signal the whole pipeline exists for: an official institution
has edited a page we cite. Many such edits are harmless (a staffing notice), so
a human looks first.

## Responding to a CHANGED flag

1. Look at the page and diff what is different against the service card.
2. If the change affects a fact (a fee, a document, a step, a timeline), edit
   the service's JSON in `backend/app/content/` and open a pull request that
   cites the changed source.
3. After merge, re-seed: `python -m app.scripts.seed --reset`. (A fresh seed
   rebuilds retrieval and reminders; verification status survives because it
   lives in the database keyed to the service, not in the content files.)
4. If the old figure is superseded, keep the superseding source's `retrieved_at`
   current so the freshness rule (a card is as old as its **oldest** source)
   matches reality. When two official sources genuinely disagree, show both —
   the same policy as the passport fee dispute in `docs/VERIFICATION.md`.

## PDF caveat

Several allowed sources are PDFs. The pipeline hashes the raw bytes without
parsing them, so it can say "this PDF changed" but not *what* changed. Compare
PDFs by hand or with a diff tool on the downloaded files.

## Scheduling

There is no always-on host or cron in the current deployment: the backend runs
on Render's free tier, which has no scheduler, and the frontend is static. So
the recommended cadence is:

- **Weekly, manual** — a curator (or GitHub Action on a schedule) runs the
  script and reads the report. `--json` writes a diff-able artifact.
- **GitHub Actions schedule** — optional, and only safe once a `DATABASE_URL`
  secret is configured for the workflow. The job runs the ingest, and on any
  `CHANGED` opens the report as a workflow artifact. Human review still gates
  every content change; the schedule only removes the "remember to run it"
  step.

Change detection also narrows the verification audit's blind spot: the
worksheet (`docs/VERIFICATION.md`) flags a card *stale* when its oldest source
is old, but ingest flags a card *changed* the week an institution edits its
page — the two tools together decide what a curator must look at.

## Re-embedding (`--reembed`)

`--reembed` is unrelated to crawling. It re-runs the embedder over the existing,
curated chunks — the normal use is after switching `EMBEDDING_PROVIDER` or the
model, so historical vectors match the new embedding space. It exercises the
same `embed_with_fallback` path the seeder uses, so a provider outage degrades
to the fallback embedder instead of failing the run.