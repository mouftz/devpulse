from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder


CATEGORICAL = ["provider", "repo_name", "author_id"]
NUMERIC = ["title_length", "opened_weekday", "opened_hour"]
FEATURES = CATEGORICAL + NUMERIC
MIN_TRAINING_ROWS = 20


def prepare_features(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    opened = pd.to_datetime(result["opened_at"], utc=True)
    result["title_length"] = result["title"].fillna("").str.len()
    result["opened_weekday"] = opened.dt.dayofweek
    result["opened_hour"] = opened.dt.hour
    return result


def build_pipeline() -> Pipeline:
    categorical = Pipeline([
        ("missing", SimpleImputer(strategy="most_frequent")),
        ("one_hot", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
    ])
    numeric = Pipeline([("missing", SimpleImputer(strategy="median"))])
    return Pipeline([
        ("features", ColumnTransformer([
            ("categorical", categorical, CATEGORICAL),
            ("numeric", numeric, NUMERIC),
        ])),
        ("model", RandomForestRegressor(
            n_estimators=300,
            min_samples_leaf=2,
            random_state=42,
            n_jobs=-1,
        )),
    ])


@dataclass
class TrainingResult:
    status: str
    model_kind: str
    model_version: str
    training_rows: int
    test_rows: int
    baseline_mae_hours: float | None
    model_mae_hours: float | None


def train_and_save(frame: pd.DataFrame, path: Path) -> TrainingResult:
    data = prepare_features(frame).sort_values("opened_at").reset_index(drop=True)
    version = datetime.now(timezone.utc).strftime("pr-cycle-%Y%m%d%H%M%S")
    median_hours = float(data["merge_duration_hours"].median()) if len(data) else 24.0
    bundle: dict = {
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_rows": len(data),
        "baseline_hours": median_hours,
        "model_kind": "median_baseline",
        "pipeline": None,
        "residual_quantiles": [median_hours * 0.5, median_hours * 1.5],
    }

    if len(data) < MIN_TRAINING_ROWS:
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(bundle, path)
        return TrainingResult("insufficient_data", "median_baseline", version, len(data), 0, None, None)

    split = max(1, int(len(data) * 0.8))
    train = data.iloc[:split]
    test = data.iloc[split:]
    baseline_predictions = np.full(len(test), float(train["merge_duration_hours"].median()))
    baseline_mae = float(mean_absolute_error(test["merge_duration_hours"], baseline_predictions))
    pipeline = build_pipeline()
    pipeline.fit(train[FEATURES], train["merge_duration_hours"])
    predictions = pipeline.predict(test[FEATURES])
    model_mae = float(mean_absolute_error(test["merge_duration_hours"], predictions))

    if model_mae < baseline_mae:
        residuals = test["merge_duration_hours"].to_numpy() - predictions
        bundle.update({
            "model_kind": "random_forest",
            "pipeline": pipeline,
            "residual_quantiles": [float(np.quantile(residuals, 0.1)), float(np.quantile(residuals, 0.9))],
            "baseline_mae_hours": baseline_mae,
            "model_mae_hours": model_mae,
        })

    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, path)
    return TrainingResult(
        "trained" if bundle["model_kind"] == "random_forest" else "baseline_retained",
        bundle["model_kind"], version, len(train), len(test), baseline_mae, model_mae,
    )


def predict(bundle: dict, frame: pd.DataFrame) -> list[dict]:
    data = prepare_features(frame)
    if data.empty:
        return []
    if bundle.get("pipeline") is None:
        values = np.full(len(data), float(bundle["baseline_hours"]))
    else:
        values = bundle["pipeline"].predict(data[FEATURES])
    low_residual, high_residual = bundle.get("residual_quantiles", [0.0, 0.0])
    results = []
    for (_, row), value in zip(data.iterrows(), values):
        estimate = max(0.5, float(value))
        snapshot = {name: row[name].item() if hasattr(row[name], "item") else row[name] for name in FEATURES}
        results.append({
            "pr_id": row["id"],
            "predicted_hours": estimate,
            "lower_bound_hours": max(0.5, estimate + float(low_residual)),
            "upper_bound_hours": max(0.5, estimate + float(high_residual)),
            "feature_snapshot": snapshot,
        })
    return results
