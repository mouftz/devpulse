# Production Deployment

DevPulse has two supported production shapes.

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
