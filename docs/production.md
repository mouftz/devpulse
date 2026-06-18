# Production Deployment

DevPulse has two supported production shapes.

## Vercel + Render

This is the recommended managed deployment:

- Vercel serves the Vite frontend from the `web` root directory.
- Render provisions the API, queue worker, private ML service, Postgres, and
  Redis from `render.yaml`.

1. Push the repository, then create a Render Blueprint from `render.yaml`.
2. Supply the prompted GitHub OAuth and optional Gitea values. Initially set
   `FRONTEND_URL` to the future Vercel URL and set `GITHUB_CALLBACK_URL` to
   `https://devpulse-api.onrender.com/auth/github/callback`.
3. In Vercel, import this repository, choose `web` as the root directory, and
   add `VITE_API_URL=https://devpulse-api.onrender.com`.
4. Deploy Vercel, then replace `FRONTEND_URL` in Render with the actual Vercel
   production URL.
5. Add the production callback URL to the GitHub OAuth application's callback
   URL list.

The Blueprint uses free Postgres, Redis, and API plans where available. The
always-on queue worker and private model service use Render Starter instances,
and therefore require billing. Model artifacts live on the ML service disk.

## Single-host Docker Compose

This is the simplest complete deployment because Postgres, Redis, the worker,
the model service, API, and frontend share one private network.

```bash
cp .env.production.example .env.production
# Fill every required value, then:
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Only the frontend is published by default. Put TLS in front of port 8080 and
route the API hostname to the API container if it must be externally reachable.

## Google Cloud

The intended managed architecture is:

- Cloud Run: `devpulse-web`, `devpulse-api`, and `devpulse-ml`
- Cloud Run Job: database migrations
- Cloud SQL for PostgreSQL
- Memorystore for Redis on a VPC
- Secret Manager for database, OAuth, JWT, Gitea, and ML service secrets
- Cloud Scheduler for the periodic sync trigger
- Artifact Registry for container images

Keep Cloud Run, Cloud SQL, and Memorystore in the same region. Attach the Cloud
SQL instance to API, ML, migration, and worker workloads. The runtime service
account needs `roles/cloudsql.client` and access only to the secrets each
service consumes.

### Required GitHub repository variables

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCP_ARTIFACT_REPOSITORY`
- `GCP_CLOUD_SQL_INSTANCE` (`PROJECT:REGION:INSTANCE`)
- `GCP_RUNTIME_SERVICE_ACCOUNT`
- `PUBLIC_API_URL`
- `FRONTEND_URL`
- `GITHUB_CALLBACK_URL`

Use Workload Identity Federation for GitHub Actions instead of downloading a
service-account JSON key. The CI workflow builds every image; deployment can be
enabled after the managed database and Redis endpoint exist. The
`Deploy to GCP` workflow is manual (`workflow_dispatch`) so an ordinary push
cannot unexpectedly change production.

### Database connection

Cloud Run exposes an attached Cloud SQL instance under
`/cloudsql/PROJECT:REGION:INSTANCE`. Use a URL-encoded Unix socket in
`DATABASE_URL`, for example:

```text
postgresql://USER:PASSWORD@localhost/DB?host=/cloudsql/PROJECT:REGION:INSTANCE
```

Run `npx prisma migrate deploy` as a Cloud Run Job before shifting API traffic.

### Secrets

Store these in Secret Manager and mount them as environment variables:

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `ML_SERVICE_TOKEN`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITEA_TOKEN` when used

The ML service accepts `/health` publicly for probes, but training and
prediction endpoints require `X-ML-Service-Token` when configured.

### Scaling notes

- Cap API and ML maximum instances according to the Cloud SQL connection limit.
- Keep the ML service at one warm instance while model artifacts remain local
  to the container. A future model registry can move artifacts to Cloud Storage.
- Run the queue consumer on infrastructure with stable outbound VPC access to
  Memorystore. Do not expose Redis publicly.

References: Google Cloud's Cloud Run/Cloud SQL connection guide, Secret Manager
integration guide, and the `google-github-actions/auth` Workload Identity
Federation setup.
