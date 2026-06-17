"""
Feature extractor for DevPulse ML models.

Features engineered per user/repo over a rolling window:
  - commits_per_day         : average daily commit count
  - late_night_ratio        : fraction of commits between 22:00–05:00
  - weekend_ratio           : fraction of commits on Sat/Sun
  - avg_pr_cycle_hrs        : mean hours from PR open → merge
  - avg_review_wait_hrs     : mean hours until first review
  - additions_per_commit    : average lines added per commit
  - deletions_ratio         : deletions / (additions + 1)  — rework signal
  - days_since_last_commit  : recency signal
"""

import os
from datetime import datetime, timedelta, timezone
import psycopg2
import psycopg2.extras

DATABASE_URL = os.getenv("DATABASE_URL")

async def extract_features(user_id: str, repo_id: str, days: int) -> dict | None:
    since = datetime.now(timezone.utc) - timedelta(days=days)

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    # ── Commit features ───────────────────────────────────────────────────────
    cur.execute("""
        SELECT
            COUNT(*)                                              AS total_commits,
            AVG(additions)                                        AS avg_additions,
            AVG(deletions)                                        AS avg_deletions,
            SUM(CASE WHEN EXTRACT(HOUR FROM committed_at) >= 22
                       OR EXTRACT(HOUR FROM committed_at) < 5
                     THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0)
                                                                  AS late_night_ratio,
            SUM(CASE WHEN EXTRACT(DOW FROM committed_at) IN (0, 6)
                     THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0)
                                                                  AS weekend_ratio,
            MAX(committed_at)                                     AS last_commit_at
        FROM commits
        WHERE repo_id = %s
          AND author_github_id = (
              SELECT github_id FROM users WHERE id = %s
          )
          AND committed_at >= %s
    """, (repo_id, user_id, since))
    commit_row = cur.fetchone()

    if not commit_row or commit_row["total_commits"] == 0:
        conn.close()
        return None

    # ── PR cycle time ─────────────────────────────────────────────────────────
    cur.execute("""
        SELECT
            AVG(EXTRACT(EPOCH FROM (merged_at - opened_at)) / 3600) AS avg_pr_cycle_hrs,
            AVG(
                (SELECT MIN(EXTRACT(EPOCH FROM (r.submitted_at - pr.opened_at)) / 3600)
                 FROM pr_reviews r WHERE r.pr_id = pr.id)
            ) AS avg_review_wait_hrs
        FROM pull_requests pr
        WHERE repo_id = %s
          AND author_github_id = (
              SELECT github_id FROM users WHERE id = %s
          )
          AND opened_at >= %s
          AND state = 'merged'
    """, (repo_id, user_id, since))
    pr_row = cur.fetchone()
    conn.close()

    total    = commit_row["total_commits"] or 1
    last_ts  = commit_row["last_commit_at"]
    days_since = (datetime.now(timezone.utc) - last_ts).days if last_ts else days

    return {
        "commits_per_day":       round(total / days, 4),
        "late_night_ratio":      round(float(commit_row["late_night_ratio"] or 0), 4),
        "weekend_ratio":         round(float(commit_row["weekend_ratio"] or 0), 4),
        "avg_pr_cycle_hrs":      round(float(pr_row["avg_pr_cycle_hrs"] or 0), 4),
        "avg_review_wait_hrs":   round(float(pr_row["avg_review_wait_hrs"] or 0), 4),
        "additions_per_commit":  round(float(commit_row["avg_additions"] or 0), 4),
        "deletions_ratio":       round(
            float(commit_row["avg_deletions"] or 0) /
            (float(commit_row["avg_additions"] or 0) + 1), 4
        ),
        "days_since_last_commit": days_since,
    }
