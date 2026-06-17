"""
Anomaly detector — wraps sklearn IsolationForest.

Flags unusual commit behaviour (commit spikes, sudden stops, extreme
late-night sessions) without needing labelled data.

Decision function returns:
  > 0  →  normal
  < 0  →  anomalous (the more negative, the more anomalous)
"""

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline


class AnomalyDetector:

    def __init__(self, contamination: float = 0.05):
        """
        contamination: expected fraction of anomalies in the training set.
        0.05 means ~5% of developers are flagged as outliers.
        """
        self.pipeline = Pipeline([
            ("scaler",  StandardScaler()),
            ("iforest", IsolationForest(
                n_estimators=100,
                contamination=contamination,
                random_state=42,
            )),
        ])
        self._fitted = False

    def fit(self, X: np.ndarray):
        """IsolationForest is unsupervised — no labels needed."""
        self.pipeline.fit(X)
        self._fitted = True
        return self

    def decision_function(self, X: np.ndarray) -> np.ndarray:
        """
        Returns raw anomaly score per sample.
        Positive = normal, negative = anomalous.
        """
        if not self._fitted:
            return np.zeros(len(X))
        return self.pipeline.decision_function(X)

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Returns 1 (normal) or -1 (anomaly) per sample."""
        if not self._fitted:
            return np.ones(len(X))
        return self.pipeline.predict(X)
