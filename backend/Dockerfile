# Deploy target for Render (also plain-docker friendly anywhere else).
#
# The app is a single FastAPI process with binary-wheel deps, so the runtime
# needs no compilers: keep it a small slim image.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# psycopg ships binary wheels (no libpq headers at build time), but libpq5 at
# runtime is cheap insurance for the binary's bundled copy and lets the app
# fall back cleanly on exotic platforms.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies change far less often than the code; install them first so this
# layer survives across deploys.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY main.py .

# Render injects a real PORT (its free tier uses 10000); Docker runs default to 8000.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]