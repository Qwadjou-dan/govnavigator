# Deployment

Target: managed frontend host + managed container host + managed Postgres. Deployment should be a non-event during Demo Day week; the team's time belongs to the product.

## 1. Database (Neon or Supabase — both free)

Create a Postgres database, then enable the extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Copy the connection string and convert the scheme to `postgresql+psycopg://`.

```
postgresql+psycopg://USER:PASSWORD@HOST/DB?sslmode=require
```

Seed it once from your machine:

```bash
cd backend
source .venv/bin/activate     # macOS/Linux; without this, use python3
DATABASE_URL="postgresql+psycopg://..." python -m app.scripts.seed --reset
```

Once the corpus grows past a few thousand chunks, add an ANN index:

```sql
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
```

## 2. Backend (Render, Railway or Fly)

- Build: `pip install -r requirements.txt`
- Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Root directory: `backend`

Environment variables:

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `DATABASE_URL` | your Postgres URL |
| `JWT_SECRET` | generate with `python3 -c "import secrets;print(secrets.token_urlsafe(48))"` |
| `ADMIN_PASSWORD` | a real password |
| `CORS_ORIGINS` | your deployed frontend URL |
| `GEMINI_API_KEY` | optional |

## 3. Frontend (Vercel)

- Root directory: `frontend`
- `NEXT_PUBLIC_API_URL` = `https://your-api-host/api`

Deploy the frontend last, then set `CORS_ORIGINS` on the backend to the URL Vercel gives you and redeploy the backend.

## Before you go live — checklist

- [ ] `JWT_SECRET` and `ADMIN_PASSWORD` changed from their defaults
- [ ] `APP_ENV=production` (this stops OTP codes being returned in API responses)
- [ ] `CORS_ORIGINS` set to the real frontend origin, not `*`
- [ ] `.env` is not committed — confirm with `git status`
- [ ] `python -m app.scripts.evaluate` run against the production database
- [ ] At least the highest-traffic service cards verified in the curator console
- [ ] Someone has actually loaded the site on a real Android phone on mobile data

## Operating it

- **Health**: `GET /health`. **What is running**: `GET /api/system`.
- **Quality**: `GET /api/admin/overview` — watch *unsourced claims blocked* (should stay 0) and the refusal rate (a rise means coverage is falling behind demand, not that grounding is too strict).
- **Cost**: token cost is logged per query; verified answers are cached.
- **Content updates**: edit `backend/app/content/*.json`, re-run `python -m app.scripts.seed`, then re-run the evaluation. No code deploy is needed for a fee change.

## Known operational limits

Rate limiting is in-process, so it must move to Redis or the gateway before running more than one API instance. Corpus ingestion is manual in this MVP; scheduled crawling and change detection are designed but not built.
