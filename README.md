# DevPulse

DevPulse is a developer analytics workspace for GitHub and Gitea repositories.
It connects to your repos, syncs commits and pull requests into Postgres, and
turns that raw activity into a dashboard with commit rhythm, repo-level metrics,
PR cycle trends, review latency, sync health, and repository management tools.

The current version is focused on one clean loop:

1. Connect GitHub with OAuth.
2. Optionally layer in Gitea from the dashboard.
3. Discover repositories.
4. Sync them in the background through Redis.
5. Explore repo and contributor activity in the UI.

## What Works Today

- GitHub OAuth sign-in with an HTTP-only session cookie
- Optional Gitea repository discovery using `GITEA_BASE_URL` and `GITEA_TOKEN`
- Background repo sync queue backed by Redis
- Manual sync actions for all visible repos or a single repo
- Nightly / catch-up sync worker flow
- Repo visibility management for hiding repos from the dashboard
- Bulk restore for hidden repositories
- Repo-manager search, status/visibility filters, result counts, and quick reset
- Dashboard totals for repos, commits, pull requests, and active repos
- Contribution heatmap with date range and `Mine` / `All` scope
- Repo-level detail view with:
  - commit trend
  - PR cycle trend
  - review latency
  - sync status and last sync error details
  - commit and pull-request comparisons against workspace averages
  - stable hover readouts with weekly PR/review sample counts
- Provider-aware repo handling for GitHub and Gitea
- API smoke tests and helper tests
- Queue payload validation and background-sync failure coverage
- Settings diagnostics for queue depth, worker state, and recent sync failures
- One-click retry for failed GitHub and Gitea syncs
- PR merge-time forecasts for open pull requests
- Time-aware Random Forest training with a median-baseline safety fallback
- Versioned prediction history with confidence ranges and feature snapshots
- Automatic post-sync inference and scheduled model retraining
- Production Docker Compose, container health checks, and GitHub Actions CI
- AES-256-GCM encryption for newly stored GitHub provider tokens

## Stack

| Layer | Tech |
| --- | --- |
| Frontend | React, Vite, TypeScript |
| API | Fastify, TypeScript |
| ORM | Prisma |
| Database | PostgreSQL |
| Queue / cache | Redis |
| ML service | FastAPI, pandas, scikit-learn |
| Local orchestration | Docker Compose |
| Monitoring scaffold | Prometheus, Grafana |

## Architecture

```text
GitHub OAuth / Gitea token
           |
           v
      Fastify API
           |
   -------------------
   |        |        |
   v        v        v
Postgres   Redis   Frontend
           |
           v
      Sync worker
```

The API owns auth, provider sync, database writes, analytics responses, and
repo visibility state. The worker consumes Redis jobs and performs background
syncs. The frontend reads everything from the API and uses the session cookie
set after OAuth.

## Local Setup

### 1. Install dependencies

```bash
cd api
npm install

cd ../web
npm install
```

### 2. Create env files

The root `.env` is used by `docker-compose.yml`.

```bash
cp .env.example .env
```

Fill in your provider values:

```env
DATABASE_URL=postgresql://devpulse:devpulse_secret@localhost:5433/devpulse_db
JWT_SECRET=change_me_in_production

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

GITEA_BASE_URL=
GITEA_TOKEN=

REDIS_URL=redis://localhost:6379
ML_SERVICE_URL=http://localhost:8001
ML_SERVICE_TOKEN=
SYNC_INTERVAL_SECONDS=86400
RUN_ON_START=true
SYNC_MAX_ATTEMPTS=3
SYNC_RETRY_BASE_MS=5000
SYNC_RETRY_MAX_MS=60000
PROVIDER_REQUEST_CONCURRENCY=5

FRONTEND_URL=http://localhost:5173
PORT=3000
HOST=127.0.0.1
```

Do not commit real secrets.

### 3. Start Postgres and Redis

```bash
docker compose up postgres redis
```

Postgres is mapped to local port `5433` to avoid clashing with other local
installs.

### 4. Run Prisma migrations

```bash
cd api
npx prisma migrate dev
```

### 5. Start the API

```bash
cd api
npm run build
node dist/index.js
```

Health check:

```text
http://localhost:3000/health
```

### 6. Start the sync worker

In another terminal:

```bash
cd api
npm run worker:dev
```

### 7. Start the frontend

```bash
cd web
npm run dev
```

Open:

```text
http://localhost:5173
```

### 8. Start the ML service

```bash
cd ml-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn api.main:app --host 127.0.0.1 --port 8001
```

Train the model after syncing merged pull requests:

```bash
curl -X POST http://localhost:8001/train/pr-cycle
```

With fewer than 20 merged PRs, DevPulse intentionally retains a median
baseline. With enough data, it promotes the Random Forest only when its MAE on
newer PRs beats that baseline.

## GitHub OAuth Setup

Create a GitHub OAuth app and use this callback URL:

```text
http://localhost:3000/auth/github/callback
```

Put the client ID and client secret in the root `.env`. After login, the API
stores the GitHub access token, signs a `devpulse_token` cookie, and redirects
back to the frontend.

## Helpful Commands

### API

```bash
cd api
npm run dev
npm run worker:dev
npm test
```

### Frontend

```bash
cd web
npm run dev
npm run build
npm test
```

## Main API Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | API health check |
| `/auth/github` | GET | Start GitHub OAuth |
| `/auth/github/callback` | GET | GitHub OAuth callback |
| `/auth/me` | GET | Current session user |
| `/auth/logout` | POST | Clear session cookie |
| `/auth/system` | GET | API / provider / queue status |
| `/github/repos` | GET | Discover and save GitHub repos |
| `/github/repos/manage` | GET | Visible + hidden repo manager data |
| `/github/repos/sync-all/background` | POST | Queue all visible GitHub repos |
| `/github/repos/:repoId/sync/background` | POST | Queue one GitHub repo |
| `/github/repos/:repoId/visibility` | POST/PATCH | Hide or restore a repo |
| `/github/repos/:repoId/summary` | GET | Repo-level metrics |
| `/github/repos/:repoId/pr-cycle` | GET | Weekly PR cycle trend |
| `/github/repos/:repoId/review-latency` | GET | Weekly review latency |
| `/github/repos/:repoId/predictions` | GET | Latest open-PR merge forecasts |
| `/github/overview` | GET | Dashboard totals and repo list |
| `/github/activity` | GET | Daily commit counts |
| `/github/insights` | GET | High-level dashboard insights |
| `/gitea/repos` | GET | Discover and save Gitea repos |
| `/gitea/repos/sync-all/background` | POST | Queue all visible Gitea repos |
| `/gitea/repos/:repoId/sync/background` | POST | Queue one Gitea repo |

## Project Layout

```text
devpulse/
├── api/             # Fastify API, Prisma schema, worker, tests
├── web/             # React dashboard
├── ml-service/      # PR cycle-time training and inference service
├── etl/             # older ETL scaffold
├── infra/           # monitoring / infra config
├── docker-compose.yml
└── README.md
```

## Testing

Current test coverage includes:

- API helper tests
- API app / route smoke tests
- frontend dashboard utility tests

Run them with:

```bash
cd api && npm test
cd web && npm test
cd ml-service && python -m unittest discover -s tests
```

## Production

Use `docker-compose.prod.yml` for a single-host deployment. It runs migrations
before starting immutable API, worker, ML, and frontend containers:

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

See [docs/production.md](docs/production.md) for Cloud Run, Cloud SQL,
Memorystore, Secret Manager, and Workload Identity Federation guidance.

## Notes

- The frontend uses `VITE_API_URL`, defaulting to `http://localhost:3000`.
- Set `TOKEN_ENCRYPTION_KEY` before reconnecting GitHub to encrypt newly stored
  access tokens. Existing plaintext local tokens remain readable for migration.
- Generate a token key with `openssl rand -base64 32`.
- `.DS_Store` is ignored and should stay untracked.

- This is still a WIP, so expect it to be unfinished :)
