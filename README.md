# GovNavigator Ghana

**One question, one answer: who, what, how and where for any Ghana government service — with sources you can check.**

Week 3 MVP for the Codetrain AI Talent Accelerator 2026, Opportunity 5.1 (Government Service Navigator).
Built to the specification in `GovNavigator_Final_Report.docx` (Week 2 — Define & Design).

---

## What it does

You describe a goal in your own words — including Ghanaian English and Pidgin — and it returns:

> **relevant service → responsible institution → requirements → steps → documents → official sources**

It also does something less common, and more important: **when it cannot cite an official source, it says so and routes you to the institution instead of guessing.** A confidently wrong requirement costs a real person a wasted trip to an office; an honest "we don't know" costs them nothing.

---

## Quick start

Two terminals. You need Python 3.11+ and Node 18+.

**You do not need a database server to start.** Set `DATABASE_URL=sqlite:///./govnav.db` in `backend/.env` and everything runs immediately — same 27 services, same citations, same 100% evaluation score. The retrieval layer is dialect-adaptive, so moving to Postgres later is a one-line config change, not a rewrite. Use Postgres + `pgvector` when you deploy (`docs/DEPLOYMENT.md`).

**Terminal 1 — backend**

```bash
cd backend

# macOS and Linux ship "python3", not "python". Create the virtualenv with
# python3; once it is ACTIVATED, plain "python" works inside it.
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r requirements.txt
cp .env.example .env               # then set DATABASE_URL in .env
python -m app.scripts.seed --reset # loads 27 services, 23 institutions, 76 sources
uvicorn app.main:app --reload --port 8000
```

Your prompt should show `(.venv)` once the virtualenv is active. If it does not, activation did not work and every `python` below needs to be `python3`.

**Terminal 2 — frontend**

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

Open <http://localhost:3000>. API docs are at <http://localhost:8000/docs>.

### You do not need an AI API key

The system runs in **grounded-only mode** with no provider configured, and that is a supported production mode rather than a fallback. Retrieval, grounding, citation checking and rendering are all independent of the model, so answers are still correct and cited — the system just understands unusual phrasing less well. Add `GEMINI_API_KEY` (or OpenAI / Anthropic) to `backend/.env` and restart to switch the model layer on.

### Switching from SQLite to Postgres + pgvector

Do this before you deploy. It takes about ten minutes and changes one line of config.

1. **Create a free database.** [neon.com](https://neon.com) — sign in with GitHub, create a project, copy the connection string it shows you.

2. **Rewrite the scheme and paste it into `backend/.env`.** This is the step everyone gets wrong:

   ```
   # what Neon gives you:   postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
   # what you must paste:   postgresql+psycopg://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
   #                                  ^^^^^^^^ add this
   ```

3. **Check it before doing anything else:**

   ```bash
   python -m app.scripts.check_db
   ```

   This validates the scheme, opens a connection, installs the `vector` extension if it can, and tells you in plain language what is wrong if anything is. It never prints your password.

4. **Load the knowledge base into the new database:**

   ```bash
   python -m app.scripts.seed --reset
   python -m app.scripts.check_db        # should be all green
   python -m app.scripts.evaluate        # should still score 100%
   ```

5. **Restart uvicorn.** The site footer will change from `sqlite` to `postgresql+pgvector`.

Your SQLite file is untouched, so switching back is just restoring the old `DATABASE_URL` line. Nothing else in the codebase changes — the storage layer adapts, and `chunks.embedding` becomes a native `vector(384)` column on Postgres rather than JSON.

### Troubleshooting

**`Could not find a version that satisfies the requirement psycopg-binary==...`**
You have an older copy of `requirements.txt` with exact pins. The current file uses ranges. Pull the latest and re-run `pip install -r requirements.txt`.

**`ModuleNotFoundError: No module named 'crypt'`** (Python 3.13+)
An older copy that still used `passlib`. The current code uses `bcrypt` directly. Pull the latest.

**`zsh: command not found: python`** (macOS)
macOS has no `python` command, only `python3`. Either use `python3` for every command, or — better — activate the virtualenv, inside which plain `python` exists:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
```

Your prompt shows `(.venv)` when it worked. Run `source .venv/bin/activate` again in every new terminal.

**`ModuleNotFoundError: No module named 'sqlalchemy'` while `(.venv)` is showing**
The virtualenv is active but the packages were never installed *into it* — usually because an earlier `pip install` went to your system Python before the venv existed. From `backend/`:

```bash
source .venv/bin/activate
pip install -r requirements.txt
```

To confirm which Python you are actually using, run `pip -V`. The path it prints should end in `backend/.venv`. If it points anywhere else, a different virtualenv is active than you think — `deactivate`, then activate the right one.

**`error: externally-managed-environment`** (macOS with Homebrew Python)
You are installing into the system Python. Create and activate the virtualenv as above, then `pip install -r requirements.txt` again. Do not use `--break-system-packages` — it installs into a Python you share with your operating system.

**`InsecureKeyLengthWarning: The HMAC key is 18 bytes long`**
Your `.env` was copied from an older `.env.example`. Replace the `JWT_SECRET` line with a real value:

```bash
python3 -c "import secrets;print('JWT_SECRET=' + secrets.token_urlsafe(48))"
```

**`connection to server at "127.0.0.1", port 5432 failed: Connection refused`**
`DATABASE_URL` is still the default and points at a local Postgres you are not running. You have two options.

*Get running now, no accounts.* In `backend/.env`, replace the `DATABASE_URL` line with:

```
DATABASE_URL=sqlite:///./govnav.db
```

Then `python -m app.scripts.seed --reset` and you are working. This is a real supported mode — the test suite runs on it, and the evaluation scores identically.

*Use Postgres.* Create a free database at [neon.com](https://neon.com) or [supabase.com](https://supabase.com), run `CREATE EXTENSION IF NOT EXISTS vector;` on it once from their SQL editor, then paste the connection string into `.env` **with the scheme rewritten**:

```
# what they give you:   postgresql://user:pass@host/db?sslmode=require
# what you must paste:  postgresql+psycopg://user:pass@host/db?sslmode=require
DATABASE_URL=postgresql+psycopg://user:pass@host/db?sslmode=require
```

The `+psycopg` is required — without it SQLAlchemy looks for a driver that is not installed.

**`extension "vector" is not available`**
Run `CREATE EXTENSION IF NOT EXISTS vector;` on the database once. Neon and Supabase both support it.

**`npm audit` reports vulnerabilities and suggests `npm audit fix --force`**
**Do not run `--force`.** It installs semver-major upgrades across the tree to silence warnings — here it would pull Next 16, a major release we have not tested against. This project is already on patched `next@^15.5.23` (the CVE that deprecated 15.1.6 is fixed) with a `postcss` override forcing the patched 8.5.23+.

What remains is one advisory in `sharp`, a transitive dependency Next uses for image optimisation. It is left deliberately: the fix exists only as `0.35.0-rc`, and **this app never calls `next/image`**, so the flagged code path is never executed. Revisit when sharp 0.35.0 ships stable. An unused dependency at a stable version beats a release candidate in your build.

**`npm warn tarball ... seems to be corrupted. Trying again.`**
A transient network hiccup. npm retried and succeeded — note it still said `added 115 packages`. Nothing to do. If it ever fails outright: `npm cache clean --force` then reinstall.

**`npm warn allow-scripts` about `fsevents` and `sharp`**
npm asking whether to run those packages' install scripts. You can ignore it — `fsevents` only speeds up file watching on macOS, and we do not use `sharp` at all. The app builds and runs without either.

**The web app says "We cannot reach the service right now"**
The API is not running, or `NEXT_PUBLIC_API_URL` in `frontend/.env.local` does not match where it is. Check `http://localhost:8000/health` in a browser first. Next.js bakes that variable in at build time, so restart `npm run dev` after changing it.

**A dependency version worries you.** Re-run `python -m pytest tests/ -q` and `python -m app.scripts.evaluate`. Both are the contract: if they pass, the resolved versions are fine.

---

## What was built (Week 3 deliverables)

| Handbook requirement | Where it lives |
|---|---|
| Working MVP | Full stack, running end to end |
| Frontend | `frontend/` — Next.js 15 PWA, mobile-first, dark mode, print stylesheet |
| Backend | `backend/` — FastAPI, 10-stage AI pipeline, 17 endpoints |
| AI integration | RAG: hybrid BM25 + vector retrieval, provider-agnostic LLM layer, guardrails |
| Authentication | Passwordless OTP for citizens, password for curators, anonymous asking |
| Database | PostgreSQL + pgvector, 11 tables, dialect-adaptive (also runs on SQLite) |
| Documentation | This file plus `docs/` (architecture, AI workflow, API, deployment, Week 3 report) |

Beyond the minimum: a curator console, an evaluation harness with a 102-case golden set, an adversarial test set, and a full audit trail for every answer served.

---

## The four ideas the build rests on

**1. The Answer Contract.** The language model never writes the text you read. It fills a typed object (`backend/app/schemas.py`), a validator checks every populated field against its citation, and the interface renders the validated result. Prose is not the transport, so fluency cannot smuggle in a fact.

**2. Grounded-or-silent.** Generation only happens over retrieved official content. After generation, a citation validator drops any field it cannot trace to a source in that answer's own source list. Fees, timelines and mandatory documents are held to a stricter rule: they additionally require an *official* source, not a news report.

**3. "Not published" is an answer.** Several Ghanaian agencies genuinely publish no processing time and no fee amount. NHIA publishes no premium anywhere on its website; ORC publishes no standard turnaround. The honest rendering of that is a field marked *Not published*, not a plausible-looking number. `FieldStatus` also carries `disputed` (two official sources contradict each other — this really happens with the passport fee) and `varies_by_locality` (all 261 assemblies set their own permit fees, so no national figure exists).

**4. Refusal is measured, not minimised.** The evaluation tracks refusal correctness in **both** directions. Over-refusing counts as failure too, so the team cannot improve the numbers by quietly making the system more talkative.

**5. Answer the question, not only the service.** A checklist answers *what does this service require*. It cannot answer *can I do this for my brother, who is in London* — it can only show steps that quietly assume a different situation. So a model reads the conditions out of the question, and writes a short cited reply above the card. When the sources do not cover that situation it says so, which is a real answer and the one a checklist is least able to give.

---

## The model's job

The system runs correctly with no model at all, and that mode is tested. What a model adds is understanding of the **question**, never knowledge of the **answer**. It has exactly three jobs, and each one is constrained so that a bad response costs quality, never correctness:

| Job | What it may return | What stops it going wrong |
|---|---|---|
| Which service is this about? | one id from a supplied list | an id outside the list is discarded; retrieval ranking is used instead |
| Has the question already settled a branch? | one option value per branch, from a fixed set | a value not in the set is discarded and the person is asked, or the default applies |
| What is the direct answer? | at most three sentences, plus the source ids it used | ids it was not shown are dropped; text left with no citation is deleted and the verdict falls back to *not addressed* |

Every one of those guarantees is a test in `backend/tests/test_direct_answer.py`, run against a stub provider that misbehaves deliberately — inventing fees, citing sources it was never shown, choosing option values that do not exist.

```bash
cd backend
# get a free key at https://aistudio.google.com/apikey, put it in .env, then:
python -m app.scripts.check_llm
```

**Free tiers ration two different things, and they behave differently.** A per-minute limit clears in under a minute. A per-day allowance does not clear today — waiting is pointless, and pacing a run more slowly does not help. The app tells the two apart: it retries the first with backoff, and on the second it stops retrying, says which quota was spent and what its limit was, and points at [your rate-limit dashboard](https://aistudio.google.com/rate-limit). An `--with-model` evaluation aborts rather than grinding through 88 paced questions to reproduce the baseline score.

If you are running out daily, `LLM_MODEL=gemini-3.5-flash-lite` generally carries a larger free allowance than the flash models.

Identical calls are also cached in-process. Temperature is zero everywhere here, so a repeated question would return the same object — it would just cost another slice of the day's quota to do it. That matters most where the quota hurts: re-running the evaluation while tuning, and a demo where the same few questions get typed over and over.

**A burst will still hit the per-minute limit.** One question costs one model call, sometimes two — the intent call is skipped whenever retrieval is already decisive. A single person asking questions will not notice the limit; the evaluation harness firing 88 questions in a row certainly will. Rate limits and brief provider outages are retried with backoff, and anything that still fails falls back to the grounded answer, so a `429` costs a little quality and never an answer.

That is also why `evaluate` runs against the deterministic baseline by default. A benchmark has to be reproducible, and a run where the first few questions get a model and the rest get rate-limited is not. To measure what the model actually contributes, run it both ways:

```bash
python -m app.scripts.evaluate                        # baseline, reproducible
python -m app.scripts.evaluate --with-model --pace 4  # with the model, paced
```

`check_llm` makes one real call and reports what happened. It exists because the model layer degrades **silently** by design: a wrong key, a retired model id and no key at all all look identical from the outside — the app simply carries on without a model, which is correct in production and impossible to debug during setup.

> Model ids are retired on a schedule. This project originally shipped `gemini-2.0-flash` and `text-embedding-004`; **both have since been shut down**. If a call 404s, pin a current id from Google's [model list](https://ai.google.dev/gemini-api/docs/models) or [embeddings list](https://ai.google.dev/gemini-api/docs/embeddings) via `LLM_MODEL` / `EMBEDDING_MODEL` in `.env`.

### Embeddings stay local, deliberately

Adding a chat key does **not** change how retrieval works. `EMBEDDING_PROVIDER` defaults to local, and has to be set by name to do otherwise, for three reasons:

- The local embedder is instant and offline. A remote one puts a network call on the critical path of *every* question — the opposite of what you want on a slow connection.
- The vectors are baked into the database at seed time. If the embedder changed silently, stored vectors and query vectors would come from different models, and retrieval would quietly get worse with nothing to point at.
- It scores 100% on the golden set as it is. The model earns its place by understanding the *question*, not by doing the searching.

Seeding also no longer dies when a provider refuses. It falls back to local embeddings, finishes building the database, and says plainly what went wrong — because an aborted seed leaves you with nothing at all, which is the worst outcome available rather than the safest.

### What it looks like

Asked *"can I get a national ID card for a friend who is abroad"*:

- **Without a model** — the card is correct but generic: it shows the in-Ghana registration route, and states plainly at the top that it assumed *In Ghana*, with one click to change that.
- **With a model** — the same card opens with *"No — you cannot do this for your friend. Every applicant must appear in person at a designated NIA office or a Ghana Mission…"*, cites the NIA FAQ and the diaspora service page, switches the fees to the USD bands that apply from abroad, and notes that it took *Outside Ghana* from the question rather than asking.

Both are honest. The second is the one a person can act on.

---

## Verification

```bash
cd backend
python -m pytest tests/ -q            # 42 tests, runs on SQLite, no services needed
python -m app.scripts.evaluate        # 102-case golden set against your database
```

Current results (grounded-only mode, no API key):

```
outcome accuracy      : 60/60  (100%)
service accuracy      : 46/46  (100%)
institution accuracy  : 9/9    (100%)
fee spot checks       : 6/6    (100%)
answers when it should: 46/46  (100%)
refuses when it should: 10/10  (100%)
unsourced claims      : 0             (target 0)
latency p50 / p95     : 278ms / 311ms
```

---

## Knowledge base

27 services across 9 categories, 23 institutions, 76 sources — 64 of them official government publications. Tax is covered end to end: registering for a TIN and for VAT, and then the part people actually live with — filing and paying income tax as a sole proprietor, corporate income tax, PAYE for employees, monthly VAT returns, and the Income Tax Stamp for informal-sector traders. Content lives in reviewable JSON at `backend/app/content/`, so a curator can correct a fee in a pull request without touching application code, next to the source it came from.

Covered: business name and company registration (ORC), TIN and VAT (GRA), SSNIT employer registration, business operating permit and building permit (MMDA), GhanaPostGPS digital address, Ghana Card registration and replacement (NIA), first-time passport and renewal, birth certificate (BDR), driver's licence and renewal (DVLA), NHIS, police clearance.

> **Read this before quoting anything.** Every card was built from official sources and carries its citations, but **no card has yet been confirmed with the institution by a human.** Until a curator verifies one in the console, every answer for it says so on screen. Fees in Ghana moved twice in the last twelve months — ORC and NIA both changed on 2 February 2026, the passport fee on 13 November 2025 — so verification is not optional before Demo Day.

---

## Project layout

```
govnavigator/
├── backend/
│   ├── app/
│   │   ├── ai/            pipeline, retrieval, embeddings, guardrails, providers, prompts
│   │   ├── content/       the knowledge base as reviewable JSON
│   │   ├── routers/       query, catalog, auth, feedback, admin
│   │   ├── eval/          golden_set.json
│   │   ├── scripts/       seed.py, evaluate.py
│   │   ├── models.py      11 tables — with no column for a national identifier
│   │   └── schemas.py     the Answer Contract
│   └── tests/             42 tests
├── frontend/
│   └── src/
│       ├── app/           ask, services, service detail, institutions, saved, admin
│       ├── components/    ServiceCard, answer states, shell, design system
│       └── lib/           typed API client mirroring the contract
└── docs/                  architecture, AI workflow, API, deployment, Week 3 report
```

---

## Responsible AI, briefly

Answered in full in `docs/AI_WORKFLOW.md`; the short version:

- **No national identifiers are collected, and the schema has nowhere to store one.** Anything shaped like a Ghana Card number, TIN or passport number is stripped at intake before it is logged or sent to any model provider. A privacy promise that lives only in a policy document tends not to survive a deadline.
- **Retrieved documents are data, not instructions** — a defence against prompt injection in crawled content.
- **Advice-seeking and circumvention queries are refused and routed**, never generated.
- **The product never presents itself as a government service.** No coat of arms, no national colours, and a persistent independence marker on every screen.
- **Every answer served is stored with its model version, prompt version and validator report**, so any answer a user disputes can be reconstructed exactly.

---

## Known limitations

Stated plainly, because a Week 3 MVP that claims to be finished is not credible.

1. **No card is team-verified yet.** The content is sourced and cited; it is not confirmed.
2. **The corpus is hand-curated, not crawled.** Scheduled ingestion and change detection are designed (`docs/ARCHITECTURE.md`) but not built — Week 5 work.
3. **English only.** Twi explanation is designed as v1.1; translating already-validated fields is safe, multilingual generation is not, and should not be attempted before grounding is proven.
4. **The keyless embedder is a lexical-semantic approximation**, not a transformer. It is strong at this corpus size and its limits will show as the corpus grows. Adding an embedding key and re-seeding upgrades it in place.
5. **Rate limiting is in-process**, so it needs Redis or a gateway if the API is ever run on more than one instance.
6. **WhatsApp and voice are deliberately deferred.** A channel is only worth adding once the answer it carries is trustworthy.
