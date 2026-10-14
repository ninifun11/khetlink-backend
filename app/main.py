"""KhetLink AI service — demand/price forecasting, fair-price suggestion, route optimisation."""
from __future__ import annotations

import os
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import forecasting, pricing, routing

API_KEY = os.environ.get("AI_SERVICE_KEY", "").strip()
ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "http://localhost:4000,http://localhost:3000").split(",") if o.strip()]

app = FastAPI(title="KhetLink AI Service", version="1.0.0",
              description="Forecasting, pricing intelligence and route optimisation for the KhetLink marketplace.")
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["*"], allow_headers=["*"])


def verify_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    """If AI_SERVICE_KEY is set, callers (the Express API) must send it."""
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid or missing API key")


# ------------------------------- schemas -----------------------------------
class HistoryPoint(BaseModel):
    date: str
    demand_kg: Optional[float] = None
    price_per_kg: Optional[float] = None


class ForecastRequest(BaseModel):
    crop: str
    history: list[HistoryPoint] = Field(min_length=1)
    horizon_days: int = Field(default=14, ge=1, le=60)


class BatchSeries(BaseModel):
    crop: str
    history: list[HistoryPoint] = Field(min_length=1)


class BatchForecastRequest(BaseModel):
    series: list[BatchSeries] = Field(min_length=1)
    horizon_days: int = Field(default=14, ge=1, le=60)


class PriceRequest(BaseModel):
    crop: str
    mandi_price_per_kg: float = Field(gt=0)
    retail_price_per_kg: Optional[float] = Field(default=None, gt=0)
    forecast_price_per_kg: Optional[float] = Field(default=None, gt=0)
    demand_change_pct: Optional[float] = None
    quality_grade: str = "B"
    is_organic: bool = False


class LatLng(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    name: Optional[str] = None


class RouteOrder(BaseModel):
    id: str
    label: Optional[str] = None
    weight_kg: float = Field(gt=0)
    pickup: LatLng
    delivery: LatLng
    service_min: float = Field(default=10, ge=0)


class RouteVehicle(BaseModel):
    id: str
    name: Optional[str] = None
    capacity_kg: float = Field(gt=0)
    cost_per_km: float = Field(default=12, ge=0)
    fixed_cost: float = Field(default=0, ge=0)


class RouteRequest(BaseModel):
    depot: LatLng
    orders: list[RouteOrder] = Field(min_length=1, max_length=60)
    vehicles: list[RouteVehicle] = Field(min_length=1, max_length=15)
    max_route_km: float = Field(default=400, gt=0)
    speed_kmph: float = Field(default=35, gt=0)
    circuity: float = Field(default=1.35, ge=1.0, le=3.0)
    time_limit_s: int = Field(default=5, ge=1, le=30)


# ------------------------------- routes ------------------------------------
@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "khetlink-ai", "ortools": routing.HAS_ORTOOLS}


@app.post("/forecast/demand", dependencies=[Depends(verify_key)])
def forecast_demand(req: ForecastRequest) -> dict:
    try:
        return forecasting.forecast_crop(req.crop, [p.model_dump() for p in req.history], req.horizon_days)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.post("/forecast/batch", dependencies=[Depends(verify_key)])
def forecast_batch(req: BatchForecastRequest) -> dict:
    series = [{"crop": s.crop, "history": [p.model_dump() for p in s.history]} for s in req.series]
    return forecasting.forecast_batch(series, req.horizon_days)


@app.post("/pricing/suggest", dependencies=[Depends(verify_key)])
def suggest_price(req: PriceRequest) -> dict:
    try:
        out = pricing.suggest_price(
            mandi_price=req.mandi_price_per_kg,
            retail_price=req.retail_price_per_kg,
            forecast_price=req.forecast_price_per_kg,
            demand_change_pct=req.demand_change_pct,
            quality_grade=req.quality_grade,
            is_organic=req.is_organic,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"crop": req.crop, **out}


@app.post("/route/optimize", dependencies=[Depends(verify_key)])
def optimize_route(req: RouteRequest) -> dict:
    try:
        return routing.optimize_routes(req.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
