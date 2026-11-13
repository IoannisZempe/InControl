# InControl Railway Daily Context Collector

Minimal Node + PostgreSQL receiver service that stores daily development & AI agent context snapshots keyed by date (`YYYY-MM-DD`). Each user deploys this service to their **own** Railway account so no third party stores your prompts, commits, or file paths.

## 1-Command Automated Setup (Recommended)

From the `InControl` repository (or anywhere with `npx`):

```bash
./scripts/setup-railway.sh
# or:
npx incontrol-agents setup railway
```

Optional flags:
- `--with-staging` — also provisions an isolated `staging` environment alongside `production`
- `--dry-run` — preview the provisioning plan without making any changes
- `--project <name>` — custom Railway project name (default: `incontrol-archive`)

The installer automatically:
1. Installs the Railway CLI if missing
2. Opens your browser once to sign in (or create a free Railway account on the fly)
3. Provisions managed PostgreSQL + `daily-archive` service
4. Generates a private `COLLECTOR_API_TOKEN` via stdin and wires `DATABASE_URL`
5. Deploys `railway-collector/`, generates a `*.up.railway.app` domain, checks `/health`, and saves the config to `~/.incontrol/settings.json` (`0600`)

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string (`${{Postgres.DATABASE_URL}}` on Railway)
- `COLLECTOR_API_TOKEN` — Bearer token required on all `/api/*` requests
- `PORT` — HTTP listen port (default `8080`)

## Endpoints
- `GET /health` — database + service healthcheck
- `POST /api/days` — upsert a day collection JSON payload (`{ day: "YYYY-MM-DD", ... }`)
- `GET /api/days` — list saved days (metadata & counts)
- `GET /api/days/:day` — retrieve the full saved context bundle for `YYYY-MM-DD`
