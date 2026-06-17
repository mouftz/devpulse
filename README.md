# DevPulse

DevPulse is a developer analytics app that connects to GitHub, syncs repository
activity, and turns commits and pull requests into a clean dashboard.

The goal is to make engineering activity easier to understand at a glance:
which repos are active, how often work is landing, and where team/product
signals can eventually feed deeper analytics and ML scoring.

## What Works Today

- GitHub OAuth login
- Browser session cookie after login
- GitHub repository discovery
- One-click sync for all saved repos
- Commit and pull request ingestion into Postgres
- Dashboard totals for repos, synced repos, commits, and pull requests
- GitHub-style contribution heatmap for commit activity
- Repo table and “most active” ranking

## Product Direction

DevPulse is being built as a developer analytics SaaS. The current version is
focused on proving the core data loop:

1. Connect GitHub.
2. Save the authenticated user.
3. Discover repositories.
4. Sync commits and pull requests.
5. Display useful engineering activity in the dashboard.

Next steps are deeper analytics: PR cycle time trends, commit velocity by repo,
review latency, anomaly detection, and ML-powered burnout risk scoring.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React, Vite, TypeScript |
| API | Node.js, Fastify, TypeScript |
| ORM | Prisma |
| Database | PostgreSQL |
| Cache / Queue | Redis |
| ML service | Python, FastAPI, scikit-learn |
| Containers | Docker Compose |
| Monitoring | Prometheus, Grafana |

## Architecture

```text
GitHub OAuth
    |
    v
Fastify API  --->  PostgreSQL
    |                |
    |                v
    |          commits, PRs, repos, users
    |
    v
React Dashboard
```

The API owns authentication, GitHub API calls, database writes, and analytics
responses. The frontend reads from the API using the browser session cookie set
after GitHub OAuth.

The ML and ETL folders are scaffolded for the larger product direction. The
main working path right now is the web app plus API plus Postgres.

## Local Setup

### 1. Install Dependencies

```bash
cd api
npm install

cd ../web
npm install
```

### 2. Create API Environment File

Create `api/.env`:

```env
DATABASE_URL=postgresql://devpulse:devpulse_secret@localhost:5433/devpulse_db
JWT_SECRET=change_me_in_development
GITHUB_CLIENT_ID=your_github_oauth_client_id
GITHUB_CLIENT_SECRET=your_github_oauth_client_secret
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback
FRONTEND_URL=http://localhost:5173
PORT=3000
HOST=127.0.0.1
NODE_ENV=development
```

Do not commit real secrets.

### 3. Start Postgres and Redis

From the project root:

```bash
docker compose up postgres redis
```

This project maps Postgres to local port `5433` to avoid conflicts with other
local Postgres installs.

### 4. Run Database Migrations

In a second terminal:

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

### 6. Start the Frontend

In another terminal:

```bash
cd web
npm run dev
```

Open:

```text
http://localhost:5173
```

## GitHub OAuth Setup

Create a GitHub OAuth app and use this callback URL:

```text
http://localhost:3000/auth/github/callback
```

Put the app’s client ID and client secret in `api/.env`.

When you click “Connect GitHub” in the dashboard, the API will complete OAuth,
save the user, set a local session cookie, and redirect back to the frontend.

## Useful API Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | API health check |
| `/auth/github` | GET | Start GitHub OAuth |
| `/auth/github/callback` | GET | GitHub OAuth callback |
| `/auth/me` | GET | Current logged-in user |
| `/auth/logout` | POST | Clear session cookie |
| `/github/repos` | GET | Discover and save GitHub repos |
| `/github/repos/sync-all` | GET/POST | Sync all saved repos |
| `/github/repos/:repoId/sync` | POST | Sync one repo |
| `/github/repos/:repoId/summary` | GET | Repo-level metrics |
| `/github/overview` | GET | Dashboard totals and repo list |
| `/github/activity` | GET | Daily commit counts for the heatmap |

## Project Structure

```text
devpulse/
├── api/                 # Fastify API, Prisma schema, GitHub sync routes
├── web/                 # React/Vite dashboard
├── ml-service/          # FastAPI ML service scaffold
├── etl/                 # Background GitHub ingestion scaffold
├── infra/monitoring/    # Prometheus config
├── docker-compose.yml   # Local Postgres, Redis, services
└── README.md
```

## Development Notes

- The frontend expects the API at `http://localhost:3000`.
- The API sets an HTTP-only `devpulse_token` cookie after GitHub login.
- The dashboard can sync all repos from the UI.
- GitHub access tokens are stored in Postgres for local development; production
  should encrypt them before writing to the database.
- `npm audit` currently reports dependency advisories. Avoid
  `npm audit fix --force` unless you are ready to handle breaking upgrades.

## Roadmap

### Analytics

- Per-repo activity charts with commits-over-time line charts.
- PR cycle time trends that show whether merge time is improving or getting
  slower.
- Review latency metrics, especially time from PR open to first review.
- Repo filtering and a dashboard date range picker.

### Infrastructure

- Background sync jobs. Sync is currently manual; the Redis queue and ETL worker
  should run scheduled syncs automatically.
- Keep generated OS files out of Git. `.DS_Store` is ignored and should stay
  untracked.

### ML Pipeline

- Train the burnout predictor and anomaly detector on real ingested data.
- Wire the ML service `/score` endpoint into the sync flow.
- Store model outputs in the `ml_scores` table.
- Surface burnout and anomaly scores in the dashboard.

### Deployment

- GCP Cloud Run and Cloud SQL setup.
- GitHub Actions CI/CD pipeline.
