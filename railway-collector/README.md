# InControl Railway Daily Context Collector

Minimal Node + PostgreSQL receiver service that stores daily development & AI agent context snapshots keyed by date (`YYYY-MM-DD`).

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string (`${{Postgres.DATABASE_URL}}` on Railway)
- `COLLECTOR_API_TOKEN` — Bearer token required on all `/api/*` requests
- `PORT` — HTTP listen port (default `8080`)

## Endpoints
- `GET /health` — database + service healthcheck
- `POST /api/days` — upsert a day collection JSON payload (`{ day: "YYYY-MM-DD", ... }`)
- `GET /api/days` — list saved days (metadata & counts)
- `GET /api/days/:day` — retrieve the full saved context bundle for `YYYY-MM-DD`
