import tempfile
import unittest
from pathlib import Path

import pandas as pd

from models.pr_cycle import predict, train_and_save


def dataset(rows: int) -> pd.DataFrame:
    opened = pd.date_range("2025-01-01", periods=rows, freq="D", tz="UTC")
    return pd.DataFrame({
        "id": [f"pr-{index}" for index in range(rows)],
        "provider": ["github"] * rows,
        "repo_name": ["team/repo"] * rows,
        "author_id": [f"author-{index % 3}" for index in range(rows)],
        "title": ["Update feature"] * rows,
        "opened_at": opened,
        "merge_duration_hours": [float(8 + (index % 5) * 3) for index in range(rows)],
    })


class PrCycleModelTest(unittest.TestCase):
    def test_sparse_data_creates_safe_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.joblib"
            result = train_and_save(dataset(5), path)
            self.assertEqual(result.model_kind, "median_baseline")
            self.assertTrue(path.exists())

    def test_prediction_contains_bounds_and_features(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.joblib"
            train_and_save(dataset(5), path)
            import joblib
            bundle = joblib.load(path)
            items = predict(bundle, dataset(1).drop(columns=["merge_duration_hours"]))
            self.assertEqual(len(items), 1)
            self.assertGreater(items[0]["predicted_hours"], 0)
            self.assertIn("opened_hour", items[0]["feature_snapshot"])


if __name__ == "__main__":
    unittest.main()
