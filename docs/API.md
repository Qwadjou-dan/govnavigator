# API reference

Base URL `http://localhost:8000/api`. Interactive docs at `/docs`.

## Ask

### `POST /query`

```json
{ "text": "I wan make my business proper", "answers": {}, "skip_clarification": false }
```

Returns one of four outcomes — **all four are normal operation:**

| Outcome | Meaning |
|---|---|
| `answered` | A validated Answer Contract |
| `clarify` | One question, because guessing would be irresponsible |
| `refused` | Nothing citable; routes to the likely institution instead |
| `blocked` | Out of scope — legal/tax advice or circumvention |

Every response carries `stages[]`, the pipeline trace the interface shows under *How we got this answer*, and `latency_ms`.

Answer fields worth knowing:

- `contract.validator` — how many facts were checked and how many were dropped
- `contract.caveats[]` — freshness, dispute, locality and coverage warnings
- `contract.sources[]` — every citation, each flagged official or secondary
- each field's `status` — `confirmed` · `secondary` · `not_published` · `varies_by_locality` · `disputed`

## Browse

| Endpoint | Returns |
|---|---|
| `GET /services` | Service catalogue (optional `?category=`) |
| `GET /services/{id}` | Full Answer Contract, assembled and validated identically to an answer |
| `GET /institutions` | Tier 2 directory |
| `GET /institutions/{id}` | One institution plus its verified services |
| `GET /categories` | Category labels |
| `GET /system` | What this deployment is running — model, embedder, database, floor |

## Feedback

`POST /feedback` — `{answer_id, service_id, verdict: yes|partly|no, comment}`.
The question asked in the UI is *"did this match what you found at the office?"*, not *"was this helpful?"* — only the former can correct a fee.

## Identity

| Endpoint | Purpose |
|---|---|
| `POST /auth/request-code` | Send a 6-digit code (returned in the response in development only) |
| `POST /auth/verify-code` | Exchange it for a bearer token |
| `POST /auth/curator-login` | Curator sign-in with password |
| `GET/POST/DELETE /checklists` | Saved checklists (requires a token) |

## Curator (role `curator`)

| Endpoint | Purpose |
|---|---|
| `GET /admin/overview` | Answer rate, refusal rate, unsourced claims blocked, latency, feedback, coverage |
| `GET /admin/analytics` | Windowed daily series, outcome split, top requested services, languages, feedback breakdown (`?days=30`) |
| `GET /admin/verification-audit` | All 27 service cards ranked by need-for-action (unverified, stale, missing official source) with summary |
| `GET /admin/coverage-gaps` | Tier 3 backlog ranked by how often it was asked (`?limit=25`) |
| `GET /admin/corrections` | Reports from people who went to the office (`?status=open`) |
| `POST /admin/corrections/{id}/resolve` | Mark a correction resolved with a curator note |
| `POST /admin/services/{id}/verify` | Mark a card confirmed with the institution (removes caveat) |
| `GET /admin/recent-queries` | Chronological log of recent queries with outcomes and latency (`?limit=50`) |
| `GET /admin/answers/{id}` | Reconstruct exactly what a user was shown |

## Errors

`422` validation · `401` no/expired token · `403` not a curator · `404` unknown id · `429` rate limited · `500` returns a plain-language message, never a stack trace.
