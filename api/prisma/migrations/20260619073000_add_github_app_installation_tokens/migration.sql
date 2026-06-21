-- Add GitHub App installation token storage
ALTER TABLE "users"
ADD COLUMN "github_installation_id" TEXT,
ADD COLUMN "github_installation_token" TEXT,
ADD COLUMN "github_installation_token_expires_at" TIMESTAMP(3);
