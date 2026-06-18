"""DevPulse model service: PR cycle-time training and inference."""

from __future__ import annotations

import os
from contextlib import closing
from pathlib import Path

import joblib
import pandas as pd
import psycopg2
import psycopg2.extras
from fastapi import Depends, FastAPI, Header, HTTPException

from models.pr_cycle import predict, train_and_save


app = FastAPI(title="DevPulse ML Service", version="1.0.0")
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/app/models/saved"))
MODEL_PATH = MODEL_DIR / "pr_cycle.joblib"
DATABASE_URL = os.getenv("DATABASE_URL")
SERVICE_TOKEN = os.getenv("ML_SERVICE_TOKEN")

TRAINING_QUERY = """
SELECT pr.id, r.provider, r.full_name AS repo_name,
       pr.author_github_id AS author_id, pr.title, pr.opened_at,
       EXTRACT(EPOCH FROM (pr.merged_at - pr.opened_at)) / 3600.0 AS merge_duration_hours
FROM pull_requests pr
JOIN repos r ON r.id = pr.repo_id
WHERE pr.merged_at IS NOT NULL AND pr.merged_at >= pr.opened_at
ORDER BY pr.opened_at
"""

OPEN_PRS_QUERY = """
SELECT pr.id, r.provider, r.full_name AS repo_name,
       pr.author_github_id AS author_id, pr.title, pr.opened_at
FROM pull_requests pr
JOIN repos r ON r.id = pr.repo_id
WHERE pr.repo_id = %s AND pr.merged_at IS NULL AND pr.state = 'open'
ORDER BY pr.opened_at
"""


def connection():
    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not configured")
    return psycopg2.connect(DATABASE_URL)


def load_bundle() -> dict | None:
    return joblib.load(MODEL_PATH) if MODEL_PATH.exists() else None


def authorize(x_ml_service_token: str | None = Header(default=None)):
    if SERVICE_TOKEN and x_ml_service_token != SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid service token")


def train_model() -> dict:
    with closing(connection()) as conn:
        frame = pd.read_sql_query(TRAINING_QUERY, conn)
    result = train_and_save(frame, MODEL_PATH)
    return result.__dict__


@app.get("/health")
def health():
    bundle = load_bundle()
    return {
        "status": "ok",
        "model": None if bundle is None else {
            "version": bundle["version"],
            "kind": bundle["model_kind"],
            "trainingRows": bundle["training_rows"],
            "trainedAt": bundle["trained_at"],
        },
    }


@app.post("/train/pr-cycle", dependencies=[Depends(authorize)])
def train_pr_cycle():
    return train_model()


@app.post("/predict/repos/{repo_id}", dependencies=[Depends(authorize)])
def predict_repo(repo_id: str):
    bundle = load_bundle()
    if bundle is None:
        train_model()
        bundle = load_bundle()
    if bundle is None:
        raise HTTPException(status_code=503, detail="Model could not be initialized")

    with closing(connection()) as conn:
        frame = pd.read_sql_query(OPEN_PRS_QUERY, conn, params=(repo_id,))
        predictions = predict(bundle, frame)
        with conn.cursor() as cursor:
            for item in predictions:
                cursor.execute(
                    """
                    INSERT INTO pr_cycle_predictions
                        (id, pr_id, predicted_hours, lower_bound_hours, upper_bound_hours,
                         model_version, model_kind, feature_snapshot, predicted_at)
                    VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, %s, NOW())
                    """,
                    (
                        item["pr_id"], item["predicted_hours"], item["lower_bound_hours"],
                        item["upper_bound_hours"], bundle["version"], bundle["model_kind"],
                        psycopg2.extras.Json(item["feature_snapshot"]),
                    ),
                )
        conn.commit()

    return {
        "repoId": repo_id,
        "predictions": len(predictions),
        "modelVersion": bundle["version"],
        "modelKind": bundle["model_kind"],
    }
