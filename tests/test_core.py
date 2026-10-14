"""Unit tests for the pure-Python core (no web framework needed)."""
import math
from datetime import date, timedelta

import numpy as np

from app import forecasting, pricing, routing


def _history(days=300, base=100.0, trend=0.0, seed=1):
    rng = np.random.default_rng(seed)
    start = date(2025, 1, 1)
    out = []
    for i in range(days):
        d = start + timedelta(days=i)
        weekly = 1 + 0.25 * math.sin(2 * math.pi * d.weekday() / 7)
        annual = 1 + 0.15 * math.sin(2 * math.pi * d.timetuple().tm_yday / 365)
        demand = base * weekly * annual * (1 + trend * i / 365) * rng.normal(1, 0.04)
        out.append({"date": d.isoformat(), "demand_kg": demand, "price_per_kg": 20 * annual * rng.normal(1, 0.03)})
    return out


def test_forecast_shapes_and_accuracy():
    res = forecasting.forecast_crop("Tomato", _history(), 14)
    assert len(res["forecast"]) == 14
    assert res["metrics"]["demand_mape_pct"] < 15
    assert res["summary"]["demand_trend"] in {"rising", "falling", "stable"}
    row = res["forecast"][0]
    assert row["demand_lower"] <= row["demand_kg"] <= row["demand_upper"]


def test_forecast_short_history_fallback():
    res = forecasting.forecast_crop("Onion", _history(days=10), 7)
    assert "moving-average" in res["method"]
    assert len(res["forecast"]) == 7


def test_forecast_handles_gaps():
    h = _history(120)
    del h[40:50]
    res = forecasting.forecast_crop("Potato", h, 5)
    assert len(res["forecast"]) == 5


def test_batch_ranking_sorted():
    up, down = _history(trend=0.8, seed=2), _history(trend=-0.6, seed=3)
    res = forecasting.forecast_batch([{"crop": "A", "history": down}, {"crop": "B", "history": up}], 14)
    scores = [c["opportunity_score"] for c in res["crops"]]
    assert scores == sorted(scores, reverse=True)


def test_price_suggestion_bounds():
    r = pricing.suggest_price(20, retail_price=40, forecast_price=22, demand_change_pct=10, is_organic=True)
    assert 20 < r["min_price_per_kg"] <= r["recommended_price_per_kg"] <= r["max_price_per_kg"] < 40
    assert r["farmer_gain_vs_mandi_pct"] > 0 and r["consumer_saving_vs_retail_pct"] > 0


def test_price_without_retail():
    r = pricing.suggest_price(30)
    assert r["confidence"] == "low"
    assert r["recommended_price_per_kg"] > 30


HUB = {"lat": 17.533, "lng": 78.265, "name": "Hub"}


def _orders(n=8):
    rng = np.random.default_rng(7)
    out = []
    for i in range(n):
        out.append({
            "id": f"order-{i:03d}",
            "label": f"#{i}",
            "weight_kg": float(rng.integers(40, 200)),
            "pickup": {"lat": 17.3 + rng.random() * 0.4, "lng": 77.9 + rng.random() * 0.5},
            "delivery": {"lat": 17.35 + rng.random() * 0.15, "lng": 78.35 + rng.random() * 0.25},
        })
    return out


def test_route_capacity_and_pairing():
    vehicles = [
        {"id": "v1", "name": "Ace", "capacity_kg": 500, "cost_per_km": 12},
        {"id": "v2", "name": "Bolero", "capacity_kg": 900, "cost_per_km": 15},
    ]
    res = routing.optimize_routes({"depot": HUB, "orders": _orders(8), "vehicles": vehicles})
    assigned = 0
    for r in res["routes"]:
        assert r["peak_load_kg"] <= r["capacity_kg"]
        seen_pickup = set()
        for s in r["stops"]:
            if s["type"] == "pickup":
                seen_pickup.add(s["order_id"])
            else:
                assert s["order_id"] in seen_pickup, "delivery before pickup"
        assigned += len(r["order_ids"])
    assert assigned + len(res["unassigned"]) == 8
    assert res["summary"]["distance_saved_pct"] >= 0


def test_route_consolidation_beats_baseline():
    vehicles = [{"id": "v1", "capacity_kg": 5000, "cost_per_km": 12}]
    res = routing.optimize_routes({"depot": HUB, "orders": _orders(8), "vehicles": vehicles})
    assert res["summary"]["total_distance_km"] < res["summary"]["baseline_distance_km"]
    assert res["summary"]["distance_saved_pct"] > 10


def test_route_overweight_order_is_unassigned():
    orders = _orders(2)
    orders[0]["weight_kg"] = 5000
    res = routing.optimize_routes({"depot": HUB, "orders": orders, "vehicles": [{"id": "v", "capacity_kg": 800, "cost_per_km": 10}]})
    assert any(u["order_id"] == "order-000" for u in res["unassigned"])
