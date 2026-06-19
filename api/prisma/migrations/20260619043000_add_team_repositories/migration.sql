CREATE TABLE "team_repos" (
  "id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "repo_id" TEXT NOT NULL,
  CONSTRAINT "team_repos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_repos_team_id_repo_id_key" ON "team_repos"("team_id", "repo_id");

ALTER TABLE "team_repos"
ADD CONSTRAINT "team_repos_team_id_fkey"
FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_repos"
ADD CONSTRAINT "team_repos_repo_id_fkey"
FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
