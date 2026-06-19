ALTER TABLE "users"
ADD COLUMN "gitea_base_url" TEXT,
ADD COLUMN "gitea_token" TEXT;

DROP INDEX IF EXISTS "repos_provider_provider_repo_id_key";
DROP INDEX IF EXISTS "repos_github_repo_id_key";
DROP INDEX IF EXISTS "commits_sha_key";

CREATE UNIQUE INDEX "repos_owner_id_provider_provider_repo_id_key"
ON "repos"("owner_id", "provider", "provider_repo_id");

CREATE UNIQUE INDEX "commits_repo_id_sha_key"
ON "commits"("repo_id", "sha");
