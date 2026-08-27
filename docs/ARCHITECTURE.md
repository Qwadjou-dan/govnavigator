# Architecture

## Four planes

Separated so the corpus can be corrected without deploying code, and the AI pipeline can be evaluated without the interface.

```
┌──────────────────────────────────────────────────────────────────────┐
│ EXPERIENCE   Next.js 15 PWA · Service Card · checklist · print/share  │
│              answer states: clarify · refuse · block · offline        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ typed JSON (Answer Contract)
┌───────────────────────────────▼──────────────────────────────────────┐
│ APPLICATION  FastAPI · CORS · rate limit · OTP auth · feedback        │
│              observability middleware (latency, tracing)              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│ INTELLIGENCE  intake → scope gate → hybrid retrieval → intent →       │
│               clarify → eligibility → assemble → validate →           │
│               freshness → respond                                     │
│               provider-agnostic LLM · pluggable embedder · eval harness│
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│ KNOWLEDGE   PostgreSQL + pgvector                                     │
│             institutions · services · sources · chunks                │
│             query_logs · answer_logs · feedback · coverage_requests    │
└──────────────────────────────────────────────────────────────────────┘
```

## Request path

1. Client posts a free-text goal to `POST /api/query`.
2. Orchestrator sanitises the input and strips anything shaped like a national identifier.
3. Scope gate refuses advice-seeking and circumvention queries outright.
4. Hybrid retrieval (BM25 + dense vectors + curated-alias matching) ranks candidate services.
5. Intent resolution picks one, constrained to the retrieved candidates. Where a model is configured it chooses among them; where none is, search ranking decides.
6. Below the relevance floor → refusal payload, a Tier 3 coverage request is logged, **no generation occurs**.
7. Two candidates within the ambiguity margin, or an unanswered clarifier → one question, never a guess.
8. Assembler fills the Answer Contract from curated, source-tagged content.
9. Validator resolves every citation; failing fields are blanked and recorded.
10. Freshness gate compares source dates against policy and attaches caveats.
11. Validated contract is persisted with its model and prompt version, then returned.

## Data model

| Table | Purpose | Notes |
|---|---|---|
| `institutions` | The Tier 2 directory | Mandate, contacts, offices, coverage tier |
| `services` | The service registry | Aliases, clarifiers, and all contract fields as JSON |
| `sources` | The citation allow-list | `is_official` drives strict validation |
| `chunks` | Retrievable evidence | Section-tagged, embedded, dated |
| `query_logs` | Every question | Post-redaction text, outcome, latency, validator report |
| `answer_logs` | Every answer served | The exact contract, for audit |
| `feedback` / `coverage_requests` | Learning | Corrections queue; Tier 3 demand backlog |
| `users` / `saved_checklists` / `one_time_codes` | Identity | Contact **hash** only |

There is deliberately **no column anywhere capable of holding a Ghana Card number, TIN or passport number.**

## Retrieval

Hybrid, because the two failure modes are different. Institution names, form numbers and fee labels are keyword-exact; user phrasing is semantic. Either signal alone fails roughly half the real queries.

- **BM25** over chunk text (self-contained, no dependency at this corpus size).
- **Dense vectors** via a pluggable embedder, stored as a real `vector(384)` column on Postgres.
- **Curated alias matching**, weighted by token rarity with function words removed — a hand-written alias like *"I wan make my business proper"* is the strongest intent evidence available, but only when the words that match actually carry meaning.
- **Domain-coverage damping.** A question full of words the corpus has never seen ("fishing", "helicopter") is damped, because one incidental keyword match should not carry an out-of-scope question past the floor.

Scores are **absolute, not normalised against the best match**. Normalising by the leader guarantees the top result always scores highly, which makes the relevance floor meaningless — and that is exactly how a navigator ends up answering questions it should have declined.

## Dialect adaptivity

The `Embedding` type in `db.py` resolves to `pgvector.Vector` on Postgres and JSON everywhere else, so the same code runs against managed Postgres in production and SQLite in CI. pgvector returns numpy arrays; these are coerced to Python floats at that boundary, because numpy scalars otherwise travel silently through the whole pipeline and fail at JSON serialisation far from the cause.

Adding an ANN index once the corpus grows is a one-line migration:

```sql
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
```

## Technology decisions

| Layer | Choice | Why | Rejected |
|---|---|---|---|
| Frontend | Next.js 15 PWA, TypeScript | Fast first paint on 3G; installable without app-store friction | Native Android — installation is a barrier |
| Backend | Python / FastAPI | Pipeline, eval harness and ingestion all live in Python | Node API — splits the AI code across two runtimes |
| Database | PostgreSQL + pgvector | Citations are relational joins, and vectors live in the same store | Separate vector DB — a synchronisation problem at this size |
| Retrieval | Hybrid + alias | Neither keyword nor vector alone is sufficient | Vector-only — misses form and institution identifiers |
| Auth | OTP, contact hashed | No passwords to leak; anonymous asking preserved | Ghana Card sign-in — contrary to the privacy stance |
| LLM | Provider-agnostic wrapper | Model can change without touching the pipeline; A/B measurable | SDK calls scattered through the code |
| Fonts | System stack only | Payload budget; primary users are on metered data | Webfonts |

## Security

TLS in transit; secrets in environment configuration only; parameterised queries throughout; per-address rate limiting; identifier stripping at intake; retrieved content treated strictly as data; curator actions recorded with identity and timestamp; every served answer stored with its versions for reconstruction.
