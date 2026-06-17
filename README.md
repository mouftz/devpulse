# DevPulse — Developer Analytics SaaS

A backend platform that ingests GitHub activity, computes engineering metrics,
and surfaces ML-powered burnout risk scores for individual developers and teams.

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| API | Node.js + Fastify + TypeScript | Type-safe, fast, familiar |
| ORM | Prisma | Schema-first, great migrations |
| Database | PostgreSQL 16 | Relational, analytical queries |
| Cache / Queue | Redis 7 | Sessions, job queue, hot metrics |
| ML service | Python + FastAPI + scikit-learn | IsolationForest anomaly detection, RF burnout predictor |
| ETL pipeline | Python + httpx + asyncio | Async GitHub ingestion, BigQuery load |
| Containers | Docker + docker-compose | Full local dev parity |
| Monitoring | Prometheus + Grafana | Metrics dashboards, alerting |
| Cloud | GCP — Cloud Run + Cloud SQL + BigQuery | Serverless containers, managed DB |
| CI/CD | GitHub Actions | Test → build → deploy on push |

## 

```bash
# 1. Clone and enter the repo
git clone https://github.com/yourname/devpulse && cd devpulse

# 2. Copy env file and fill in your GitHub OAuth app credentials
cp .env.example .env

# 3. Start all services
docker compose up --build

# 4. Run DB migrations
docker compose exec api npx prisma migrate dev

# 5. Open services
#   API        →  http://localhost:3000
#   Grafana    →  http://localhost:3001  (admin / admin)
#   Prometheus →  http://localhost:9090
#   ML service →  http://localhost:8001/docs
```

## Project structure

```
devpulse/
├── api/                      # Node.js + Fastify backend
│   ├── prisma/
│   │   └── schema.prisma     # Database schema (source of truth)
│   └── src/
│       ├── routes/           # HTTP route handlers
│       ├── services/         # Business logic
│       ├── middleware/       # Auth, rate limiting
│       ├── jobs/             # Redis queue consumers
│       └── db/               # Prisma client singleton
│
├── ml-service/               # Python FastAPI ML microservice
│   ├── api/main.py           # /score, /train, /health endpoints
│   ├── features/extractor.py # SQL → feature vector
│   └── models/
│       ├── burnout.py        # RandomForest classifier
│       └── anomaly.py        # IsolationForest detector
│
├── etl/
│   └── pipelines/
│       └── github_ingest.py  # Nightly GitHub → Postgres → BigQuery
│
├── infra/
│   └── monitoring/
│       └── prometheus.yml    # Scrape config
│
├── docker-compose.yml        # Full local environment
└── README.md
```