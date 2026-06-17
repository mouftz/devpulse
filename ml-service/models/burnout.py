"""
Burnout risk predictor — wraps a scikit-learn RandomForestClassifier.

Label heuristic (for training on synthetic / real data):
  burnout = 1  if  late_night_ratio > 0.4
                OR weekend_ratio > 0.5
                OR avg_pr_cycle_hrs > 72
                OR days_since_last_commit > 14   (sudden drop-off)
"""

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

FEATURE_NAMES = [
    "commits_per_day",
    "late_night_ratio",
    "weekend_ratio",
    "avg_pr_cycle_hrs",
    "avg_review_wait_hrs",
    "additions_per_commit",
    "deletions_ratio",
    "days_since_last_commit",
]

class BurnoutPredictor:
    """Thin wrapper so we can swap the underlying estimator later."""

    def __init__(self):
        self.pipeline = Pipeline([
            ("scaler", StandardScaler()),
            ("clf",    RandomForestClassifier(
                n_estimators=100,
                max_depth=6,
                class_weight="balanced",
                random_state=42,
            )),
        ])
        self._fitted = False

    def fit(self, X: np.ndarray, y: np.ndarray):
        self.pipeline.fit(X, y)
        self._fitted = True
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if not self._fitted:
            # Return neutral probability until model is trained
            return np.array([[0.5, 0.5]] * len(X))
        return self.pipeline.predict_proba(X)

    @staticmethod
    def make_label(features: dict) -> int:
        """Heuristic label for bootstrapping before you have real labels."""
        return int(
            features["late_night_ratio"]      > 0.4
            or features["weekend_ratio"]       > 0.5
            or features["avg_pr_cycle_hrs"]    > 72
            or features["days_since_last_commit"] > 14
        )
