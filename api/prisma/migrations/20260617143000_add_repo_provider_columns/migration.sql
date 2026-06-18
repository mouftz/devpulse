ALTER TABLE "repos"
  ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'github',
  ADD COLUMN IF NOT EXISTS "provider_repo_id" TEXT;

UPDATE "repos"
SET
  "provider" = CASE
    WHEN "github_repo_id" LIKE 'gitea:%' THEN 'gitea'
    ELSE 'github'
  END,
  "provider_repo_id" = CASE
    WHEN "github_repo_id" LIKE 'gitea:%' THEN split_part("github_repo_id", ':', 2)
    ELSE "github_repo_id"
  END
WHERE "provider_repo_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "repos_provider_provider_repo_id_key"
  ON "repos"("provider", "provider_repo_id");

CREATE UNIQUE INDEX IF NOT EXISTS "repos_owner_id_provider_full_name_key"
  ON "repos"("owner_id", "provider", "full_name");
