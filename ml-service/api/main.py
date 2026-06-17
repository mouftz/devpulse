"""
DevPulse ML Service
Endpoints:
  POST /score         — run burnout + anomaly inference for a user/repo
  POST /train         — retrain models on latest DB data
  GET  /health        — liveness probe
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import joblib, os, numpy as np
from pathlib import Path
from features.extractor import extract_features
from models.burnout import BurnoutPredictor
from models.anomaly import AnomalyDetector

app = FastAPI(title="DevPulse ML Service", version="0.1.0")

MODEL_DIR = Path(os.getenv("MODEL_DIR", "/app/models/saved"))
MODEL_DIR.mkdir(parents=True, exist_ok=True)

# ── Load or initialise models at startup ──────────────────────────────────────
burnout_model: BurnoutPredictor = None
anomaly_model: AnomalyDetector = None

@app.on_event("startup")
async def load_models():
    global burnout_model, anomaly_model
    bp_path = MODEL_DIR / "burnout.joblib"
    ad_path  = MODEL_DIR / "anomaly.joblib"
    burnout_model = joblib.load(bp_path) if bp_path.exists() else BurnoutPredictor()
    anomaly_model = joblib.load(ad_path) if ad_path.exists() else AnomalyDetector()

# ── Request / Response schemas ────────────────────────────────────────────────
class ScoreRequest(BaseModel):
    user_id:  str
    repo_id:  str
    days:     int = 30   # look-back window

class ScoreResponse(BaseModel):
    user_id:       str
    repo_id:       str
    burnout_score: float   # 0.0 – 1.0 (higher = higher risk)
    anomaly_score: float   # Isolation Forest decision score
    features:      dict
    model_version: str

# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.post("/score", response_model=ScoreResponse)
async def score(req: ScoreRequest):
    """Extract features from DB then run both models."""
    features = await extract_features(req.user_id, req.repo_id, req.days)
    if not features:
        raise HTTPException(status_code=404, detail="No activity data found")

    feature_vec = np.array([list(features.values())])

    burnout = float(burnout_model.predict_proba(feature_vec)[0][1])
    anomaly = float(anomaly_model.decision_function(feature_vec)[0])

    return ScoreResponse(
        user_id=req.user_id,
        repo_id=req.repo_id,
        burnout_score=round(burnout, 4),
        anomaly_score=round(anomaly, 4),
        features=features,
        model_version="0.1.0",
    )

@app.post("/train")
async def train():
    """Retrain both models on latest data and persist to disk."""
    from models.trainer import retrain_all
    result = await retrain_all(MODEL_DIR)
    return {"status": "ok", "result": result}

@app.get("/health")
async def health():
    return {"status": "ok"}
