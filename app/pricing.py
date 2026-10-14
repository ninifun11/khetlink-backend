"""
Fair-price suggestion for farmers.

Idea: the farm-gate price should sit between the wholesale (mandi) price the
farmer would otherwise get and the retail price the consumer would otherwise
pay.  We split that "middle-man gap" so both sides win, and tilt the split
using demand outlook, quality grade and organic status.
"""
from __future__ import annotations

from typing import Any

RETAIL_MULTIPLE_WHEN_UNKNOWN = 1.9  # retail is typically ~1.8-2.2x mandi for fresh produce
QUALITY_ADJ = {"A": 0.05, "B": 0.0, "C": -0.06}


def suggest_price(
    mandi_price: float,
    retail_price: float | None = None,
    forecast_price: float | None = None,
    demand_change_pct: float | None = None,
    quality_grade: str = "B",
    is_organic: bool = False,
) -> dict[str, Any]:
    if mandi_price <= 0:
        raise ValueError("mandi_price must be positive")

    factors: list[str] = []
    base = mandi_price
    if forecast_price and forecast_price > 0:
        base = 0.5 * mandi_price + 0.5 * forecast_price
        factors.append(f"Blended today's mandi rate with the 14-day forecast (₹{forecast_price:.1f}/kg).")
    else:
        factors.append(f"Used today's mandi rate (₹{mandi_price:.1f}/kg) as the base.")

    retail_assumed = retail_price is None or retail_price <= base
    retail = base * RETAIL_MULTIPLE_WHEN_UNKNOWN if retail_assumed else retail_price
    if retail_assumed:
        factors.append("No retail reference given, so retail was assumed at ~1.9× the mandi rate.")

    gap = retail - base
    share = 0.45  # farmer's starting share of the gap
    if demand_change_pct is not None:
        tilt = max(-0.10, min(0.15, demand_change_pct / 100.0 * 0.5))
        share += tilt
        if abs(tilt) >= 0.01:
            direction = "rising" if tilt > 0 else "falling"
            factors.append(f"Demand is {direction} ({demand_change_pct:+.1f}%), so the farmer share moved {tilt * 100:+.0f} pts.")
    q = QUALITY_ADJ.get(quality_grade.upper(), 0.0)
    if q:
        share += q
        factors.append(f"Quality grade {quality_grade.upper()} adjusts the share by {q * 100:+.0f} pts.")
    if is_organic:
        share += 0.08
        factors.append("Organic produce earns a +8 pt premium.")
    share = max(0.30, min(0.70, share))

    recommended = base + share * gap
    floor = max(mandi_price * 1.02, base + 0.25 * gap)
    ceiling = min(retail * 0.90, base + 0.75 * gap)
    recommended = min(max(recommended, floor), ceiling)
    if ceiling < floor:  # degenerate tiny gap
        floor = ceiling = recommended = round(base * 1.05, 2)

    gain = (recommended - mandi_price) / mandi_price * 100.0
    saving = (retail - recommended) / retail * 100.0
    confidence = "high" if (forecast_price and not retail_assumed) else "medium" if forecast_price or not retail_assumed else "low"

    return {
        "min_price_per_kg": round(floor, 2),
        "recommended_price_per_kg": round(recommended, 2),
        "max_price_per_kg": round(ceiling, 2),
        "farmer_gain_vs_mandi_pct": round(gain, 1),
        "consumer_saving_vs_retail_pct": round(saving, 1),
        "assumed_retail_price_per_kg": round(retail, 2),
        "confidence": confidence,
        "factors": factors,
        "explanation": (
            f"Listing at ₹{recommended:.1f}/kg pays the farmer about {gain:.0f}% more than the mandi rate "
            f"while the buyer still saves about {saving:.0f}% versus retail."
        ),
    }
