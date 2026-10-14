import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, asyncHandler } from '../utils/http.js';
import { callAI, aiHealth } from '../services/aiClient.js';
import { fetchAll } from '../utils/db.js';
import { daysAgoISO } from '../utils/dates.js';

const router = Router();
router.use(requireAuth);

router.get('/health', asyncHandler(async (_req, res) => res.json(await aiHealth())));

/** Daily series for one crop. With a district → that district only, otherwise all districts combined. */
async function loadSeries(crop, district, days = 365) {
  const since = daysAgoISO(days);
  const rows = await fetchAll((from, to) => {
    if (district) {
      return supabase.from('market_data')
        .select('date, demand_kg, price_per_kg, retail_price_per_kg')
        .ilike('crop', crop).ilike('district', district).gte('date', since).order('date').range(from, to);
    }
    return supabase.from('market_daily')
      .select('date, demand_kg, price_per_kg, retail_price_per_kg')
      .ilike('crop', crop).gte('date', since).order('date').range(from, to);
  });
  if (!rows.length) throw new HttpError(404, `No market data found for ${crop}${district ? ` in ${district}` : ''}`);
  return rows.map((r) => ({ date: r.date, demand_kg: Number(r.demand_kg), price_per_kg: Number(r.price_per_kg), retail_price_per_kg: r.retail_price_per_kg == null ? null : Number(r.retail_price_per_kg) }));
}

// ---------------------------------------------------------------------------
// Demand + price forecast for a crop
// ---------------------------------------------------------------------------
const forecastQuery = z.object({
  crop: z.string().trim().min(2).max(40),
  district: z.string().trim().max(60).optional(),
  horizon: z.coerce.number().int().min(3).max(60).default(14),
});

router.get('/forecast', validate(forecastQuery, 'query'), asyncHandler(async (req, res) => {
  const { crop, district, horizon } = req.q;
  const history = await loadSeries(crop, district);
  const result = await callAI('/forecast/demand', {
    crop, horizon_days: horizon,
    history: history.map(({ date, demand_kg, price_per_kg }) => ({ date, demand_kg, price_per_kg })),
  });
  res.json({ ...result, scope: district || 'All districts' });
}));

// ---------------------------------------------------------------------------
// Crops ranked by expected demand/price momentum (cached 10 min)
// ---------------------------------------------------------------------------
let trendingCache = { key: '', at: 0, data: null };

router.get('/trending', validate(z.object({ horizon: z.coerce.number().int().min(3).max(30).default(14) }), 'query'),
  asyncHandler(async (req, res) => {
    const key = `h${req.q.horizon}`;
    if (trendingCache.key === key && Date.now() - trendingCache.at < 10 * 60 * 1000) return res.json(trendingCache.data);

    const rows = await fetchAll((from, to) => supabase.from('market_daily')
      .select('crop, date, demand_kg, price_per_kg').gte('date', daysAgoISO(200)).order('date').range(from, to));
    const byCrop = new Map();
    for (const r of rows) {
      if (!byCrop.has(r.crop)) byCrop.set(r.crop, []);
      byCrop.get(r.crop).push({ date: r.date, demand_kg: Number(r.demand_kg), price_per_kg: Number(r.price_per_kg) });
    }
    if (!byCrop.size) throw new HttpError(404, 'No market data yet — run `npm run seed` in the backend');
    const data = await callAI('/forecast/batch', {
      horizon_days: req.q.horizon,
      series: [...byCrop].map(([crop, history]) => ({ crop, history })),
    });
    trendingCache = { key, at: Date.now(), data };
    res.json(data);
  }));

// ---------------------------------------------------------------------------
// Fair price suggestion (used in the "add product" form)
// ---------------------------------------------------------------------------
const priceQuery = z.object({
  crop: z.string().trim().min(2).max(40),
  mandi_price_per_kg: z.coerce.number().positive().optional(),
  retail_price_per_kg: z.coerce.number().positive().optional(),
  quality: z.enum(['A', 'B', 'C']).default('B'),
  organic: z.enum(['true', 'false']).default('false'),
});

router.get('/price-suggestion', validate(priceQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.q;
  const history = await loadSeries(q.crop, undefined, 200);
  const last = history[history.length - 1];

  const fc = await callAI('/forecast/demand', {
    crop: q.crop, horizon_days: 14,
    history: history.map(({ date, demand_kg, price_per_kg }) => ({ date, demand_kg, price_per_kg })),
  });
  const suggestion = await callAI('/pricing/suggest', {
    crop: q.crop,
    mandi_price_per_kg: q.mandi_price_per_kg ?? last.price_per_kg,
    retail_price_per_kg: q.retail_price_per_kg ?? last.retail_price_per_kg ?? undefined,
    forecast_price_per_kg: fc.summary.forecast_avg_price_per_kg,
    demand_change_pct: fc.summary.demand_change_pct,
    quality_grade: q.quality,
    is_organic: q.organic === 'true',
  });
  res.json({
    ...suggestion,
    market: {
      latest_mandi_price_per_kg: last.price_per_kg,
      forecast_avg_price_per_kg: fc.summary.forecast_avg_price_per_kg,
      demand_trend: fc.summary.demand_trend,
      demand_change_pct: fc.summary.demand_change_pct,
      recommendation: fc.summary.recommendation,
    },
  });
}));

export default router;
