# AI workflow

Implements §6 of the Week 2 report, with the guardrail layer built out rather than described.

## The governing rule

> The language model is an **interpreter and an assembler**. It is never a source of fact.

It may work out what the user meant, choose among retrieved candidates, and write a one-line orientation sentence. It may **not** supply a requirement, a fee, a document, an office or a timeline. That distinction is enforced by a validator that runs *after* generation and blanks any field it cannot trace to a citation — not by instruction alone, because instructions are advisory and validators are not.

## Ten stages

| # | Stage | What happens | On failure |
|---|---|---|---|
| 1 | Intake | Normalise; strip anything shaped like a national identifier; neutralise instruction-like text | Unreadable → ask again |
| 2 | Scope gate | Advice-seeking and circumvention detected before anything else | → `blocked`, with a referral |
| 3 | Retrieval | Hybrid BM25 + dense + alias, damped by domain coverage | Below the floor → `refused` |
| 4 | Intent | Model chooses among retrieved candidates only; may answer "none" | Falls back to search ranking |
| 5 | Disambiguation | Two candidates within the margin → one question | Still unclear → present the candidates |
| 6 | Eligibility | Branch on clarifier answers (sole trader vs company, resident vs abroad) | Unknown → most common case, labelled |
| 7 | Assembly | Fill the Answer Contract from curated, source-tagged content | Unfillable field → left null, shown as *not confirmed* |
| 8 | Validation | Resolve every citation; strict mode for fees, timelines, documents | Field dropped and logged |
| 9 | Freshness | Compare source dates against policy | Stale → *verify before you travel* |
| 10 | Respond and learn | Persist the contract with its versions; log Tier 3 misses | Negative feedback → correction queue |

Stage 3 runs before stage 4 deliberately. Retrieval evidence makes the intent decision better, and it means the pipeline still produces a correct answer when no model is configured at all.

## The Answer Contract

Defined in `backend/app/schemas.py`. The system does not return text; it returns a validated object which the interface renders. Two consequences follow, and both are the point: an answer that fails validation **cannot be displayed**, and evaluation becomes field-level and objective rather than a judgement about tone.

Every populated factual field carries a `source_ref` and a `status`:

| Status | Meaning |
|---|---|
| `confirmed` | An official source states it |
| `secondary` | A credible non-official source states it — rendered as *Reported* |
| `not_published` | The institution publishes no figure. **We will not invent one.** |
| `varies_by_locality` | No national figure exists (all 261 assemblies set their own permit fees) |
| `disputed` | Official sources contradict each other — both are shown with their sources |

`not_published` and `disputed` are not edge cases in Ghana. NHIA publishes no premium amount anywhere on its site. ORC publishes no standard processing time. The Ministry announced a GH¢350 passport fee in November 2025 while the official passport portal still displayed GH¢500. A system without a way to express those states would have to make something up.

## Guardrails

**Identifier stripping.** Ghana Card numbers, TINs, passport numbers, SSNIT numbers, phone numbers and long digit strings are removed at intake, before logging and before anything reaches a model provider. Deliberately over-inclusive: a false positive costs a redacted token, a false negative costs a stored identifier.

**Scope gate.** Queries seeking legal, tax or professional advice, or a way around a requirement, are refused and referred — never generated.

**Citation validation.** After assembly, every populated field must resolve to a source in that answer's own source list. Fees, timelines and mandatory documents additionally require an *official* source; a field resting on a news report survives only if it is explicitly labelled `secondary`, and the interface then renders it as *Reported*. Fees are the highest-risk field in the product — a wrong fee sends someone to a counter with the wrong money — so no fee is shown without both a citation and an effective date.

**Freshness gate.** Sources older than the warning window flag the answer. Fees without an effective date are called out explicitly, because publishing an undated fee is exactly what the unreliable blogs already do.

**Injection defence.** Retrieved content is untrusted: it is delimited, instruction-like text is neutralised, and the prompt states plainly that the evidence is data to read, not instructions to follow.

**Refusal is measured, not minimised.** The evaluation scores refusal correctness in both directions. Over-refusal is a failure too, so the score cannot be improved by making the system chattier.

## Running without a model

`NullProvider` is a supported mode, not a stub. With no key configured:

- retrieval, grounding, citation checking and rendering are unchanged
- intent resolution falls back to hybrid search ranking
- the orientation sentence falls back to curated text

Answers remain correct and cited; the system is simply less good at unusual phrasing. This is the reliability story in NFR-3 and it is also the clearest demonstration that the model is not the source of the answer — you can remove it entirely and the citations still hold.

Adding a key upgrades stages 4 and 7's phrasing. It never changes where facts come from.

## Prompts

Versioned in `backend/app/ai/prompts.py` alongside the code, and every logged query records the prompt version that produced it — so a Week 4 prompt change is measurable against the same golden set rather than asserted to be an improvement.

The summary prompt forbids stating any fee, amount, document, office, time or requirement. If a returned summary contains a digit, it is discarded and curated text is used instead — the model is not policed, it is simply not trusted with facts.

## Evaluation

`python -m app.scripts.evaluate` runs 60 hand-built cases: 44 real phrasings and 16 adversarial ones (superseded fees, non-existent services, advice requests, prompt injection, PII leakage, gibberish, empty input).

Metrics: outcome accuracy, service accuracy, institution accuracy, fee spot checks, **unsourced claims (target zero)**, refusal correctness in both directions, PII containment, and latency.

Current results, grounded-only mode: 100% on every accuracy metric, 0 unsourced claims, p50 278ms.

The honest caveat: the golden set was written by the same people who wrote the content, so it measures whether the *pipeline* faithfully serves what was curated. It does not measure whether the curation is right. Only Week 4 user testing and institutional verification can do that.

## Answering the handbook's six responsible-AI questions

**How is user data protected?** Data minimisation first — no national identifiers are collected and the schema has nowhere to store one. Transport is encrypted; authentication holds no passwords for citizens; query logs are separable from identity.

**Is personal information handled securely?** Identifier-shaped strings are stripped before anything is stored or transmitted. Accounts hold a contact hash and saved checklists, nothing more.

**Could the AI produce biased or misleading responses?** Yes, in two ways we can name. **Coverage bias**: services published in English, online and in Accra are over-represented, so rural and informal-sector needs are systematically under-served. **Staleness bias**: a superseded fee is misleading even when faithfully cited. Mitigations are tiering, effective dates, the freshness gate, and a Tier 3 demand log that makes coverage gaps visible rather than invisible.

**How will users know they are interacting with AI?** A persistent disclosure, plus the standing statement that this is an independent service and not a government agency. The *How we got this answer* trace shows the system finding and checking sources, which makes the mechanism legible rather than magical.

**When should a human intervene?** Before a card is served as team-verified; whenever a source changes; whenever a user reports a mismatch; and always at the point of action — every answer directs the user to the official source before they travel.

**What safeguards have been implemented?** Grounded-or-silent generation; post-generation citation validation with strict mode on fees and documents; a freshness gate; refusal routing for advice; injection defences; rate limiting; and full answer auditability by version.
