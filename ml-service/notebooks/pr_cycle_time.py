"""Learning-first PR cycle-time experiment for DevPulse.

Run from ml-service with:
    python notebooks/pr_cycle_time.py

The script deliberately uses only information available when a PR is opened.
That prevents future information, such as review count, from leaking into the
prediction.
"""

from __future__ import annotations

import os
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder


ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "api" / ".env")

QUERY = """
SELECT
    pr.id,
    r.provider,
    r.full_name AS repo_name,
    pr.author_github_id AS author_id,
    pr.title,
    pr.opened_at,
    EXTRACT(EPOCH FROM (pr.merged_at - pr.opened_at)) / 3600.0
        AS merge_duration_hours
FROM pull_requests pr
JOIN repos r ON r.id = pr.repo_id
WHERE pr.merged_at IS NOT NULL
  AND pr.merged_at >= pr.opened_at
ORDER BY pr.opened_at
"""

CATEGORICAL_FEATURES = ["provider", "repo_name", "author_id"]
NUMERIC_FEATURES = ["title_length", "opened_weekday", "opened_hour"]
FEATURES = CATEGORICAL_FEATURES + NUMERIC_FEATURES
TARGET = "merge_duration_hours"


def load_dataset() -> pd.DataFrame:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is missing. Add it to the root .env file.")

    with psycopg2.connect(database_url) as connection:
        frame = pd.read_sql_query(QUERY, connection)

    frame["opened_at"] = pd.to_datetime(frame["opened_at"], utc=True)
    frame["title_length"] = frame["title"].fillna("").str.len()
    frame["opened_weekday"] = frame["opened_at"].dt.dayofweek
    frame["opened_hour"] = frame["opened_at"].dt.hour
    return frame


def build_model() -> Pipeline:
    categorical = Pipeline(
        steps=[
            ("missing", SimpleImputer(strategy="most_frequent")),
            ("one_hot", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
        ]
    )
    numeric = Pipeline(steps=[("missing", SimpleImputer(strategy="median"))])
    preprocessing = ColumnTransformer(
        transformers=[
            ("categorical", categorical, CATEGORICAL_FEATURES),
            ("numeric", numeric, NUMERIC_FEATURES),
        ]
    )
    return Pipeline(
        steps=[
            ("features", preprocessing),
            (
                "model",
                RandomForestRegressor(
                    n_estimators=300,
                    min_samples_leaf=2,
                    random_state=42,
                    n_jobs=-1,
                ),
            ),
        ]
    )


def main() -> None:
    data = load_dataset()
    print(f"Loaded {len(data)} merged PRs from {data['repo_name'].nunique()} repositories.")

    if len(data) < 20:
        print(
            "\nNot enough data to evaluate responsibly. Aim for at least 20 merged PRs "
            "for this exercise and 100+ before treating results seriously."
        )
        return

    split_at = max(1, int(len(data) * 0.8))
    train = data.iloc[:split_at]
    test = data.iloc[split_at:]
    if test.empty:
        print("The time-based test set is empty; sync more merged PRs and try again.")
        return

    baseline_value = float(train[TARGET].median())
    baseline_predictions = np.full(len(test), baseline_value)
    baseline_mae = mean_absolute_error(test[TARGET], baseline_predictions)

    model = build_model()
    model.fit(train[FEATURES], train[TARGET])
    predictions = model.predict(test[FEATURES])
    model_mae = mean_absolute_error(test[TARGET], predictions)

    print(f"\nTraining rows: {len(train)} (older PRs)")
    print(f"Test rows:     {len(test)} (newer PRs)")
    print(f"Median baseline: {baseline_value:.1f} hours")
    print(f"Baseline MAE:    {baseline_mae:.1f} hours")
    print(f"Model MAE:       {model_mae:.1f} hours")

    if model_mae < baseline_mae:
        improvement = (baseline_mae - model_mae) / baseline_mae * 100
        print(f"Result: the model beats the baseline by {improvement:.1f}%.")
    else:
        print("Result: the model does not beat the baseline yet. Do not deploy it.")

    comparison = test[["repo_name", "opened_at", TARGET]].copy()
    comparison["predicted_hours"] = predictions
    comparison["absolute_error"] = np.abs(comparison[TARGET] - predictions)
    print("\nNewest test predictions:")
    print(comparison.tail(10).to_string(index=False))

    output_dir = Path(__file__).parent / "artifacts"
    output_dir.mkdir(exist_ok=True)
    joblib.dump(model, output_dir / "pr_cycle_time.joblib")
    comparison.to_csv(output_dir / "pr_cycle_time_evaluation.csv", index=False)
    print(f"\nSaved the experiment outputs to {output_dir}.")


if __name__ == "__main__":
    main()
