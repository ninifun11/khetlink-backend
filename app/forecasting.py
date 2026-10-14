"""
Demand & price forecasting.

Model: ridge-regularised harmonic regression on log(1 + y)
  y(t) = trend + weekly seasonality (3 Fourier pairs) + annual seasonality (2 pairs, when >= 180 days of history)

Why this and not a deep model?  Daily mandi series are short, noisy and strongly
seasonal.  A regularised Fourier regression is fast, explainable, needs no GPU,
gives calibrated prediction intervals from residuals, and can be back-tested in
milliseconds — a good fit for an MVP that must run on a free-tier server.
Swap `fit_and_forecast` for Prophet / LightGBM later without changing the API.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

Z_80 = 1.2816  # two-sided 80% interval


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _to_series(points: list[dict[str, Any]], field: str) -> pd.Series:
    """Build a gap-free daily series for `field` from [{date, field, ...}]."""
    rows = [(p["date"], p.get(field)) for p in points if p.get(field) is not None]
    if not rows:
        return pd.Series(dtype=float)
    df = pd.DataFrame(rows, columns=["date", "v"])
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    s = df.groupby("date")["v"].mean().astype(float).sort_index()
    full = pd.date_range(s.index.min(), s.index.max(), freq="D")
    s = s.reindex(full).interpolate(limit_direction="both")
    return s


def _features(dates: pd.DatetimeIndex, t0: pd.Timestamp, use_annual: bool) -> np.ndarray:
    t = np.asarray((dates - t0).total_seconds(), dtype=float) / 86400.0
    dow = np.asarray(dates.dayofweek, dtype=float)
    cols = [np.ones_like(t), t / 365.0]
    for k in (1, 2, 3):
        cols += [np.sin(2 * np.pi * k * dow / 7.0), np.cos(2 * np.pi * k * dow / 7.0)]
    if use_annual:
        doy = np.asarray(dates.dayofyear, dtype=float)
        for k in (1, 2):
            cols += [np.sin(2 * np.pi * k * doy / 365.25), np.cos(2 * np.pi * k * doy / 365.25)]
    return np.column_stack(cols)


def _ridge(X: np.ndarray, y: np.ndarray, lam: float = 1.0) -> np.ndarray:
    penalty = lam * np.eye(X.shape[1])
    penalty[0, 0] = 0.0  # do not shrink the intercept
    return np.linalg.solve(X.T @ X + penalty, X.T @ y)


def _mape(actual: np.ndarray, pred: np.ndarray) -> float:
    denom = np.maximum(np.abs(actual), 1e-9)
    return float(np.mean(np.abs(actual - pred) / denom) * 100.0)


def fit_and_forecast(series: pd.Series, horizon: int) -> dict[str, Any]:
    """Return point forecast, 80% band, back-test MAPE and the method name."""
    n = len(series)
    future_idx = pd.date_range(series.index[-1] + pd.Timedelta(days=1), periods=horizon, freq="D")

    # Very short history -> seasonal-naive / moving average fallback
    if n < 21:
        level = float(series.tail(min(7, n)).mean())
        spread = float(series.tail(min(14, n)).std(ddof=0) or level * 0.1)
        pred = np.full(horizon, level)
        return {
            "index": future_idx,
            "pred": pred,
            "lower": np.maximum(pred - Z_80 * spread, 0),
            "upper": pred + Z_80 * spread,
            "mape": None,
            "holdout": 0,
            "method": "moving-average (history < 21 days)",
        }

    use_annual = n >= 180
    y = np.log1p(np.maximum(series.values, 0))
    t0 = series.index[0]
    X = _features(series.index, t0, use_annual)

    # Back-test on the most recent slice
    holdout = int(min(14, max(7, n // 6)))
    Xtr, ytr = X[:-holdout], y[:-holdout]
    w_bt = _ridge(Xtr, ytr)
    bt_pred = np.expm1(X[-holdout:] @ w_bt)
    mape = _mape(series.values[-holdout:], bt_pred)

    # Final fit on all data
    w = _ridge(X, y)
    resid_sigma = float(np.std(y - X @ w, ddof=min(X.shape[1], n - 1)))
    Xf = _features(future_idx, t0, use_annual)
    mu = Xf @ w
    # widen the band slowly with horizon (uncertainty grows the further we look)
    widen = 1.0 + 0.02 * np.arange(1, horizon + 1)
    lower = np.expm1(mu - Z_80 * resid_sigma * widen)
    upper = np.expm1(mu + Z_80 * resid_sigma * widen)
    return {
        "index": future_idx,
        "pred": np.expm1(mu),
        "lower": np.maximum(lower, 0),
        "upper": upper,
        "mape": round(mape, 2),
        "holdout": holdout,
        "method": "ridge harmonic regression" + (" (weekly+annual)" if use_annual else " (weekly)"),
    }


def _trend_label(pct: float | None, band: float = 4.0) -> str:
    if pct is None:
        return "unknown"
    if pct > band:
        return "rising"
    if pct < -band:
        return "falling"
    return "stable"


def _pct(new: float, old: float) -> float | None:
    if old is None or old == 0 or np.isnan(old):
        return None
    return round((new - old) / old * 100.0, 1)


def _recommendation(crop: str, demand_pct: float | None, price_pct: float | None) -> str:
    d, p = _trend_label(demand_pct), _trend_label(price_pct)
    if d == "rising" and p == "rising":
        return (f"Demand and prices for {crop} are both expected to climb. "
                "List more stock now and consider holding a share back for bulk buyers at the higher price.")
    if d == "rising" and p != "rising":
        return (f"Demand for {crop} is picking up while prices stay flat. "
                "Good moment to win new repeat buyers with a small volume discount.")
    if d == "falling" and p == "falling":
        return (f"Both demand and prices for {crop} are softening. "
                "Sell existing stock early and avoid over-listing until the trend turns.")
    if d == "falling":
        return (f"Demand for {crop} is expected to dip. "
                "Offer bulk-order pricing to move volume before the slowdown.")
    if p == "rising":
        return f"Prices for {crop} are trending up on steady demand — a good time to review your listing price."
    if p == "falling":
        return f"Prices for {crop} are trending down. Keep your price close to the mandi rate to stay competitive."
    return f"{crop} looks stable over the coming weeks. Keep listings fresh and stock levels steady."


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def forecast_crop(crop: str, history: list[dict[str, Any]], horizon_days: int = 14) -> dict[str, Any]:
    demand = _to_series(history, "demand_kg")
    price = _to_series(history, "price_per_kg")
    if demand.empty and price.empty:
        raise ValueError("history contains neither demand_kg nor price_per_kg values")

    d_fc = fit_and_forecast(demand, horizon_days) if not demand.empty else None
    p_fc = fit_and_forecast(price, horizon_days) if not price.empty else None
    idx = (d_fc or p_fc)["index"]

    forecast = []
    for i, day in enumerate(idx):
        row: dict[str, Any] = {"date": day.strftime("%Y-%m-%d")}
        if d_fc:
            row.update(demand_kg=round(float(d_fc["pred"][i]), 1),
                       demand_lower=round(float(d_fc["lower"][i]), 1),
                       demand_upper=round(float(d_fc["upper"][i]), 1))
        if p_fc:
            row.update(price_per_kg=round(float(p_fc["pred"][i]), 2),
                       price_lower=round(float(p_fc["lower"][i]), 2),
                       price_upper=round(float(p_fc["upper"][i]), 2))
        forecast.append(row)

    # history tail for charting
    tail_n = 45
    hist_df = pd.DataFrame({"demand_kg": demand.tail(tail_n) if not demand.empty else None,
                            "price_per_kg": price.tail(tail_n) if not price.empty else None})
    history_out = []
    for ts, r in hist_df.iterrows():
        item = {"date": ts.strftime("%Y-%m-%d")}
        if not demand.empty and not np.isnan(r["demand_kg"]):
            item["demand_kg"] = round(float(r["demand_kg"]), 1)
        if not price.empty and not np.isnan(r["price_per_kg"]):
            item["price_per_kg"] = round(float(r["price_per_kg"]), 2)
        history_out.append(item)

    summary: dict[str, Any] = {}
    demand_pct = price_pct = None
    if d_fc:
        recent = float(demand.tail(horizon_days).mean())
        fut = float(np.mean(d_fc["pred"]))
        demand_pct = _pct(fut, recent)
        peak_i = int(np.argmax(d_fc["pred"]))
        summary.update(
            recent_avg_daily_demand_kg=round(recent, 1),
            forecast_avg_daily_demand_kg=round(fut, 1),
            demand_change_pct=demand_pct,
            demand_trend=_trend_label(demand_pct),
            peak_demand_day=idx[peak_i].strftime("%Y-%m-%d"),
        )
    if p_fc:
        recent_p = float(price.tail(horizon_days).mean())
        fut_p = float(np.mean(p_fc["pred"]))
        price_pct = _pct(fut_p, recent_p)
        summary.update(
            current_price_per_kg=round(float(price.iloc[-1]), 2),
            forecast_avg_price_per_kg=round(fut_p, 2),
            price_change_pct=price_pct,
            price_trend=_trend_label(price_pct),
        )
    summary["recommendation"] = _recommendation(crop, demand_pct, price_pct)

    metrics = {
        "history_days": int(max(len(demand), len(price))),
        "demand_mape_pct": d_fc["mape"] if d_fc else None,
        "price_mape_pct": p_fc["mape"] if p_fc else None,
        "backtest_days": int((d_fc or p_fc)["holdout"]),
    }
    return {
        "crop": crop,
        "horizon_days": horizon_days,
        "method": (d_fc or p_fc)["method"],
        "metrics": metrics,
        "summary": summary,
        "history": history_out,
        "forecast": forecast,
    }


def forecast_batch(series: list[dict[str, Any]], horizon_days: int = 14) -> dict[str, Any]:
    """Rank crops by expected demand growth — powers the 'what to grow / list next' view."""
    items = []
    for s in series:
        try:
            res = forecast_crop(s["crop"], s["history"], horizon_days)
        except ValueError:
            continue
        sm = res["summary"]
        dp, pp = sm.get("demand_change_pct"), sm.get("price_change_pct")
        # opportunity score: demand growth weighted above price growth
        score = (dp or 0) * 0.6 + (pp or 0) * 0.4
        items.append({
            "crop": s["crop"],
            "demand_change_pct": dp,
            "price_change_pct": pp,
            "demand_trend": sm.get("demand_trend"),
            "price_trend": sm.get("price_trend"),
            "forecast_avg_daily_demand_kg": sm.get("forecast_avg_daily_demand_kg"),
            "current_price_per_kg": sm.get("current_price_per_kg"),
            "forecast_avg_price_per_kg": sm.get("forecast_avg_price_per_kg"),
            "opportunity_score": round(score, 1),
            "recommendation": sm["recommendation"],
        })
    items.sort(key=lambda r: r["opportunity_score"], reverse=True)
    return {"horizon_days": horizon_days, "crops": items}
