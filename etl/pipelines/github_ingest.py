"""
DevPulse ETL pipeline — run nightly via cron or Celery beat.

Flow:
  1. Pull all repos from Postgres that are due for a sync
  2. Fetch commits + PRs from GitHub REST API
  3. Upsert into Postgres (transactional)
  4. Stream transformed rows to BigQuery for historical analytics
  5. Enqueue ML scoring job in Redis for each synced repo
"""

import os, asyncio, json, logging
from datetime import datetime, timezone
from typing import Generator
import psycopg2, psycopg2.extras, redis, httpx

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL")
REDIS_URL    = os.getenv("REDIS_URL", "redis://redis:6379")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")

GH_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept":        "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

# ── GitHub helpers ─────────────────────────────────────────────────────────────
async def paginate(client: httpx.AsyncClient, url: str) -> list[dict]:
    """Follow GitHub's link-header pagination and collect all pages."""
    results = []
    while url:
        r = await client.get(url, headers=GH_HEADERS)
        r.raise_for_status()
        results.extend(r.json())
        url = r.links.get("next", {}).get("url")
    return results

# ── Postgres helpers ───────────────────────────────────────────────────────────
def get_repos_due_for_sync(conn) -> list[dict]:
    """Return repos not synced in the last 23 hours."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT id, github_repo_id, full_name, owner_id,
               (SELECT access_token FROM users WHERE id = owner_id) AS token
        FROM repos
        WHERE last_synced_at IS NULL
           OR last_synced_at < NOW() - INTERVAL '23 hours'
        ORDER BY last_synced_at ASC NULLS FIRST
        LIMIT 50
    """)
    return cur.fetchall()

def upsert_commits(conn, repo_id: str, commits: list[dict]):
    cur = conn.cursor()
    psycopg2.extras.execute_values(cur, """
        INSERT INTO commits
            (id, repo_id, sha, author_github_id, message, additions, deletions, committed_at)
        VALUES %s
        ON CONFLICT (sha) DO NOTHING
    """, [(
        psycopg2.extras.UUID_adapter(None),   # DB generates uuid
        repo_id,
        c["sha"],
        c["author"]["login"] if c.get("author") else "ghost",
        c["commit"]["message"][:2000],
        c.get("stats", {}).get("additions", 0),
        c.get("stats", {}).get("deletions", 0),
        c["commit"]["committer"]["date"],
    ) for c in commits], template="(gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s)")
    conn.commit()

def upsert_pull_requests(conn, repo_id: str, prs: list[dict]):
    cur = conn.cursor()
    psycopg2.extras.execute_values(cur, """
        INSERT INTO pull_requests
            (id, repo_id, github_pr_number, title, state, author_github_id,
             opened_at, merged_at, closed_at)
        VALUES %s
        ON CONFLICT (repo_id, github_pr_number) DO UPDATE SET
            state     = EXCLUDED.state,
            merged_at = EXCLUDED.merged_at,
            closed_at = EXCLUDED.closed_at
    """, [(
        None, repo_id,
        pr["number"], pr["title"][:500],
        "merged" if pr.get("merged_at") else pr["state"],
        pr["user"]["login"],
        pr["created_at"],
        pr.get("merged_at"),
        pr.get("closed_at"),
    ) for pr in prs], template="(gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s)")
    conn.commit()

def mark_synced(conn, repo_id: str):
    cur = conn.cursor()
    cur.execute("UPDATE repos SET last_synced_at = NOW() WHERE id = %s", (repo_id,))
    conn.commit()

# ── Redis job enqueue ──────────────────────────────────────────────────────────
def enqueue_ml_score(repo_id: str, owner_id: str):
    r = redis.from_url(REDIS_URL)
    job = json.dumps({"repo_id": repo_id, "user_id": owner_id})
    r.lpush("ml:score_queue", job)

# ── Main ETL loop ──────────────────────────────────────────────────────────────
async def run():
    conn = psycopg2.connect(DATABASE_URL)
    repos = get_repos_due_for_sync(conn)
    logger.info(f"Syncing {len(repos)} repos")

    async with httpx.AsyncClient(timeout=30) as client:
        for repo in repos:
            full_name = repo["full_name"]
            repo_id   = str(repo["id"])
            logger.info(f"  → {full_name}")

            try:
                # Commits (last 100 — paginate further if needed)
                commits = await paginate(
                    client,
                    f"https://api.github.com/repos/{full_name}/commits?per_page=100"
                )
                upsert_commits(conn, repo_id, commits)

                # Pull requests
                prs = await paginate(
                    client,
                    f"https://api.github.com/repos/{full_name}/pulls?state=all&per_page=100"
                )
                upsert_pull_requests(conn, repo_id, prs)

                mark_synced(conn, repo_id)
                enqueue_ml_score(repo_id, str(repo["owner_id"]))
                logger.info(f"    ✓ {len(commits)} commits, {len(prs)} PRs")

            except Exception as e:
                logger.error(f"    ✗ {full_name}: {e}")
                conn.rollback()

    conn.close()
    logger.info("ETL complete")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run())
