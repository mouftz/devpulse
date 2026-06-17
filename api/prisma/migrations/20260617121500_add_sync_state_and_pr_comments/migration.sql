ALTER TABLE "repos"
  ADD COLUMN IF NOT EXISTS "sync_status" TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS "last_sync_error" TEXT,
  ADD COLUMN IF NOT EXISTS "last_sync_started_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_sync_finished_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "pr_comments" (
  "id" TEXT NOT NULL,
  "pr_id" TEXT NOT NULL,
  "commenter_github_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "commented_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pr_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "pr_comments_pr_id_commented_at_idx" ON "pr_comments"("pr_id", "commented_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'pr_comments_pr_id_fkey'
  ) THEN
    ALTER TABLE "pr_comments"
      ADD CONSTRAINT "pr_comments_pr_id_fkey"
      FOREIGN KEY ("pr_id") REFERENCES "pull_requests"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
