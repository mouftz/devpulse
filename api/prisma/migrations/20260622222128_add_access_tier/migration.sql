-- AlterTable
ALTER TABLE "users" ADD COLUMN     "access_tier" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "github_app_kind" TEXT;
