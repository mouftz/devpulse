# PR Cycle-Time Learning Lab

This experiment predicts the number of hours between a pull request opening
and merging. It is intentionally separate from the production API while you
learn and validate the model.

## What you are learning

1. **Target:** `merge_duration_hours` is a regression target, not a category.
2. **Leakage:** features must be known when the PR opens. Review and comment
   counts are excluded because they happen afterward.
3. **Baseline:** predicting the training-set median is the simple model that ML
   must beat.
4. **Time split:** older PRs train the model and newer PRs test it. A random
   split would make the evaluation less realistic.
5. **Metric:** MAE is the average size of the prediction error in hours.

## Run it

Start Postgres and make sure merged PRs have been synced, then:

```bash
cd ml-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python notebooks/pr_cycle_time.py
```

The script stops early when fewer than 20 merged PRs are available. That is a
data limitation, not an error. Syncing more history is the correct next step.

## Read the result

- If `Model MAE` is lower than `Baseline MAE`, the model added predictive value.
- If it is higher, do not tune the model blindly. Improve the data first.
- The saved CSV shows every test prediction and its absolute error.

The current schema only provides weak opening-time features. The most useful
next ingest fields are additions, deletions, files changed, draft status,
reviewers requested at open, and labels. Adding those fields should happen
before production integration.
