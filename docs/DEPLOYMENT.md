# GovNavigator Ghana — Deployment Runbook

Deploy target: **Supabase (PostgreSQL + pgvector) + Render (FastAPI) + Vercel (Next.js)**.

---

## Architecture Overview

```
[ Citizen's Phone / Browser ]
             │
             ▼
   [ Vercel: Next.js Frontend ]
             │
             │ HTTPS (NEXT_PUBLIC_API_URL)
             ▼
   [ Render: FastAPI Backend ]
             │
             │ postgresql+psycopg:// with SSL
             ▼
 [ Supabase: PostgreSQL + pgvector ]
```

---

## Step 1: Database Setup on Supabase

1. Sign in to your [Supabase Dashboard](https://supabase.com/dashboard).
2. Click **New Project**:
   - Name: `govnavigator` (or your preferred name)
   - Database Password: Create a strong password (save this securely).
   - Region: Choose the closest region (e.g. `EU (Frankfurt)` or `EU (London)`).
3. Enable `pgvector`:
   - In the left sidebar, navigate to **SQL Editor**.
   - Click **New query** and paste:
     ```sql
     CREATE EXTENSION IF NOT EXISTS vector;
     ```
   - Click **Run**. You should see `Success. No rows returned`.
4. Get your connection string:
   - Go to **Project Settings** (gear icon) → **Database**.
   - Under **Connection string**, select the **URI** tab.
   - Mode: Choose **Session** (or **Direct connection**, typically port `5432` or `6543`).
   - Copy the string:
     ```
     postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
     ```
5. **Convert the scheme**:
   - SQLAlchemy with `psycopg3` requires `postgresql+psycopg://`.
   - Replace the starting `postgresql://` with `postgresql+psycopg://`:
     ```
     postgresql+psycopg://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require
     ```
6. **Seed the database from your local machine**:
   Open a terminal in the project root:
   ```bash
   cd backend
   # Make sure virtual environment is active
   .venv\Scripts\activate      # Windows (or: source .venv/bin/activate on Mac/Linux)

   # Test connection first (check_db reads DATABASE_URL, so set it inline —
   # never type the password into a file that could be committed):
   DATABASE_URL="postgresql+psycopg://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require" python -m app.scripts.check_db

   # Seed all 27 services, 23 institutions, 76 sources and embeddings:
   DATABASE_URL="postgresql+psycopg://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require" python -m app.scripts.seed --reset

   # Run evaluation against Supabase to ensure 100% score:
   DATABASE_URL="postgresql+psycopg://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require" python -m app.scripts.evaluate
   ```

---

## Step 2: Backend Deployment on Render

1. Push your repository to GitHub.
2. Sign in to your [Render Dashboard](https://dashboard.render.com).
3. Click **New +** → **Web Service**:
   - Connect your GitHub repository (`govnavigator`).
4. Configure the service:
   - **Name**: `govnavigator-api` (or similar)
   - **Language**: `Python 3`
   - **Root Directory**: `backend`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - **Instance Type**: `Free`
5. Configure Environment Variables (**Environment** tab):

   | Key | Value / Instructions |
   |---|---|
   | `APP_ENV` | `production` |
   | `DATABASE_URL` | Your Supabase `postgresql+psycopg://...` URL |
   | `JWT_SECRET` | Generate with `python -c "import secrets;print(secrets.token_urlsafe(48))"` (must be ≥ 32 chars) |
   | `ADMIN_EMAIL` | `curator@govnavigator.local` (or your email) |
   | `ADMIN_PASSWORD` | Strong password (do not use `change-me-before-you-deploy`) |
   | `CORS_ORIGINS` | Temporary: `http://localhost:3000` (update after deploying frontend) |
   | `GEMINI_API_KEY` | Optional: Your Google AI Studio API key |
   | `PYTHON_VERSION` | `3.11.10` (or `3.12.0`) |

6. Click **Deploy Web Service**.
7. Once deployed, note your Render URL, e.g.:
   `https://govnavigator-api.onrender.com`
8. Verify health endpoint:
   Open `https://govnavigator-api.onrender.com/health` in your browser. It should return `{"status":"ok","env":"production"}`.

---

## Step 3: Frontend Deployment on Vercel

1. Sign in to [Vercel](https://vercel.com).
2. Click **Add New...** → **Project**.
3. Import your GitHub repository (`govnavigator`).
4. Configure project settings:
   - **Framework Preset**: `Next.js`
   - **Root Directory**: Click **Edit** and choose `frontend`.
   - **Build Command**: `next build` (default)
   - **Output Directory**: `.next` (default)
5. Add Environment Variables:
   - `NEXT_PUBLIC_API_URL`: `https://govnavigator-api.onrender.com/api` (use your actual Render backend URL with `/api` appended).
6. Click **Deploy**.
7. Once complete, copy your production domain, e.g.:
   `https://govnavigator-ghana.vercel.app`

---

## Step 4: Final Wire-up (CORS)

1. Return to the **Render Dashboard** → Your `govnavigator-api` service → **Environment**.
2. Update `CORS_ORIGINS`:
   ```
   https://govnavigator-ghana.vercel.app,http://localhost:3000
   ```
3. Save changes (Render will trigger an automatic redeploy).

---

## Step 5: Verification Checklist

- [ ] **Health check**: `https://<render-url>/health` returns `{"status":"ok","env":"production"}`
- [ ] **System info**: `https://<render-url>/api/system` shows:
  - `"database": "postgresql+pgvector"`
  - `"services_indexed": 27`
- [ ] **Frontend Live Test**:
  - Open `https://<vercel-url>` on desktop and phone.
  - Ask: *"I want to register my salon"* → answers with Business Registration checklist.
  - Ask a follow-up: *"how much is the fee?"* → stays on thread.
  - Click **Not what you meant?** → displays candidate services.
  - Click **Talk to a human** → logs escalation and shows official contacts.
  - Test **Save / Copy / Print** buttons.
- [ ] **Admin Console**:
  - Sign in at `https://<vercel-url>/admin` with your `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
  - View query logs, feedback, and system verification stats.
