CREATE TABLE "github_installations" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "installation_id" TEXT NOT NULL,
  "installation_token" TEXT NOT NULL,
  "installation_token_expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "github_installations_user_id_tier_key"
  ON "github_installations"("user_id", "tier");

CREATE UNIQUE INDEX "github_installations_tier_installation_id_key"
  ON "github_installations"("tier", "installation_id");

ALTER TABLE "github_installations"
  ADD CONSTRAINT "github_installations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "github_installations" (
  "id",
  "user_id",
  "tier",
  "installation_id",
  "installation_token",
  "installation_token_expires_at",
  "created_at",
  "updated_at"
)
SELECT
  "id" || ':' || COALESCE("github_app_kind", "access_tier", 'standard'),
  "id",
  COALESCE("github_app_kind", "access_tier", 'standard'),
  "github_installation_id",
  "github_installation_token",
  "github_installation_token_expires_at",
  "created_at",
  "updated_at"
FROM "users"
WHERE "github_installation_id" IS NOT NULL
  AND "github_installation_token" IS NOT NULL
  AND "github_installation_token_expires_at" IS NOT NULL
ON CONFLICT DO NOTHING;
