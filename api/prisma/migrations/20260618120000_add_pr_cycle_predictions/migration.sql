CREATE TABLE "pr_cycle_predictions" (
    "id" TEXT NOT NULL,
    "pr_id" TEXT NOT NULL,
    "predicted_hours" DOUBLE PRECISION NOT NULL,
    "lower_bound_hours" DOUBLE PRECISION,
    "upper_bound_hours" DOUBLE PRECISION,
    "model_version" TEXT NOT NULL,
    "model_kind" TEXT NOT NULL,
    "feature_snapshot" JSONB NOT NULL,
    "predicted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_cycle_predictions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pr_cycle_predictions_pr_id_predicted_at_idx"
ON "pr_cycle_predictions"("pr_id", "predicted_at");

ALTER TABLE "pr_cycle_predictions"
ADD CONSTRAINT "pr_cycle_predictions_pr_id_fkey"
FOREIGN KEY ("pr_id") REFERENCES "pull_requests"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
