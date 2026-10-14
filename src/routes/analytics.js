import { Router } from 'express';
import { supabase } from '../config/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler, unwrap } from '../utils/http.js';
import { managedSellerIds } from '../services/access.js';
import { aiHealth } from '../services/aiClient.js';
import { daysAgoISO, isoDay, lastNDays } from '../utils/dates.js';
import { fetchAll } from '../utils/db.js';

const router = Router();
router.use(requireAuth);

const round = (n, d = 0) => { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f; };
const ACTIVE = (o) => o.status !== 'cancelled';

function dailySeries(orders, days, pick) {
  const map = Object.fromEntries(lastNDays(days).map((d) => [d, { date: d, value: 0, orders: 0 }]));
  for (const o of orders) {
    const k = isoDay(o.created_at);
    if (map[k]) { map[k].value += pick(o); map[k].orders += 1; }
  }
  return Object.values(map).map((r) => ({ date: r.date, value: round(r.value, 2), orders: r.orders }));
}

function statusCounts(orders) {
  const out = {};
  for (const o of orders) out[o.status] = (out[o.status] || 0) + 1;
  return Object.entries(out).map(([status, count]) => ({ status, count }));
}

// ---------------------------------------------------------------------------
// Farmer / FPO
// ---------------------------------------------------------------------------
router.get('/seller', requireRole('farmer', 'fpo', 'admin'), asyncHandler(async (req, res) => {
  const ids = await managedSellerIds(req.user);
  let q = supabase.from('orders').select('id, status, total_amount, total_weight_kg, created_at, items:order_items(product_name, quantity, unit_price, mandi_price, line_total, weight_kg)')
    .gte('created_at', daysAgoISO(90)).order('created_at', { ascending: false }).limit(3000);
  if (ids) q = q.in('seller_id', ids);
  const orders = unwrap(await q);
  const live = orders.filter(ACTIVE);

  let mandiBase = 0, premium = 0;
  const products = {};
  for (const o of live) for (const it of o.items) {
    if (it.mandi_price) {
      mandiBase += Number(it.mandi_price) * Number(it.quantity);
      premium += (Number(it.unit_price) - Number(it.mandi_price)) * Number(it.quantity);
    }
    const p = (products[it.product_name] ||= { name: it.product_name, revenue: 0, kg: 0 });
    p.revenue += Number(it.line_total); p.kg += Number(it.weight_kg);
  }
  const revenue = live.reduce((s, o) => s + Number(o.total_amount), 0);

  let pq = supabase.from('products').select('id, name, quantity_available, unit, status, image_emoji');
  pq = ids ? pq.in('seller_id', ids) : pq;
  const listings = unwrap(await pq);

  res.json({
    totals: {
      revenue: round(revenue),
      orders: live.length,
      volume_kg: round(live.reduce((s, o) => s + Number(o.total_weight_kg), 0)),
      avg_order_value: live.length ? round(revenue / live.length) : 0,
      premium_vs_mandi_pct: mandiBase ? round((premium / mandiBase) * 100, 1) : null,
      extra_earned_vs_mandi: round(premium),
      pending_orders: orders.filter((o) => ['placed', 'confirmed'].includes(o.status)).length,
      active_listings: listings.filter((p) => p.status === 'active').length,
    },
    by_status: statusCounts(orders),
    revenue_by_day: dailySeries(live, 30, (o) => Number(o.total_amount)),
    top_products: Object.values(products).sort((a, b) => b.revenue - a.revenue).slice(0, 6)
      .map((p) => ({ ...p, revenue: round(p.revenue), kg: round(p.kg) })),
    low_stock: listings.filter((p) => p.status === 'active' && Number(p.quantity_available) <= 20).slice(0, 5),
  });
}));

// ---------------------------------------------------------------------------
// Consumer / bulk buyer
// ---------------------------------------------------------------------------
router.get('/buyer', asyncHandler(async (req, res) => {
  const orders = unwrap(await supabase.from('orders')
    .select('id, status, total_amount, total_weight_kg, created_at, items:order_items(quantity, unit_price, retail_price, line_total, product:products(category))')
    .eq('buyer_id', req.user.id).gte('created_at', daysAgoISO(180)).order('created_at', { ascending: false }).limit(1000));
  const live = orders.filter(ACTIVE);

  let retailBase = 0, saved = 0;
  const cat = {};
  for (const o of live) for (const it of o.items) {
    if (it.retail_price) {
      retailBase += Number(it.retail_price) * Number(it.quantity);
      saved += (Number(it.retail_price) - Number(it.unit_price)) * Number(it.quantity);
    }
    const c = it.product?.category || 'other';
    cat[c] = (cat[c] || 0) + Number(it.line_total);
  }
  const spend = live.reduce((s, o) => s + Number(o.total_amount), 0);
  res.json({
    totals: {
      spend: round(spend),
      orders: live.length,
      volume_kg: round(live.reduce((s, o) => s + Number(o.total_weight_kg), 0)),
      saved_vs_retail: round(saved),
      saved_pct: retailBase ? round((saved / retailBase) * 100, 1) : null,
      open_orders: orders.filter((o) => !['delivered', 'cancelled'].includes(o.status)).length,
    },
    spend_by_day: dailySeries(live, 30, (o) => Number(o.total_amount)),
    by_category: Object.entries(cat).map(([name, value]) => ({ name, value: round(value) })).sort((a, b) => b.value - a.value),
    by_status: statusCounts(orders),
  });
}));

// ---------------------------------------------------------------------------
// Logistics (FPO sees own shipments, admin sees all)
// ---------------------------------------------------------------------------
router.get('/logistics', requireRole('fpo', 'admin'), asyncHandler(async (req, res) => {
  let q = supabase.from('shipments').select('id, status, total_distance_km, baseline_distance_km, cost_estimate, total_load_kg, created_at')
    .gte('created_at', daysAgoISO(90)).order('created_at', { ascending: false }).limit(1000);
  if (req.user.role === 'fpo') q = q.eq('created_by', req.user.id);
  const ships = unwrap(await q).filter((s) => s.status !== 'cancelled');
  const km = ships.reduce((s, x) => s + Number(x.total_distance_km), 0);
  const base = ships.reduce((s, x) => s + Number(x.baseline_distance_km), 0);
  res.json({
    totals: {
      shipments: ships.length,
      distance_km: round(km, 1),
      baseline_km: round(base, 1),
      saved_km: round(Math.max(0, base - km), 1),
      saved_pct: base ? round(((base - km) / base) * 100, 1) : 0,
      co2_saved_kg_est: round(Math.max(0, base - km) * 0.3, 1),
      load_kg: round(ships.reduce((s, x) => s + Number(x.total_load_kg), 0)),
      cost: round(ships.reduce((s, x) => s + Number(x.cost_estimate), 0)),
    },
    by_status: statusCounts(ships),
  });
}));

// ---------------------------------------------------------------------------
// Admin — platform-wide
// ---------------------------------------------------------------------------
router.get('/admin', requireRole('admin'), asyncHandler(async (_req, res) => {
  const profiles = await fetchAll((from, to) => supabase.from('profiles').select('role').range(from, to));
  const users = {};
  for (const p of profiles) users[p.role] = (users[p.role] || 0) + 1;

  const orders = await fetchAll((from, to) => supabase.from('orders')
    .select('id, status, total_amount, total_weight_kg, created_at, seller:profiles!orders_seller_id_fkey(district), items:order_items(quantity, unit_price, mandi_price, retail_price)')
    .gte('created_at', daysAgoISO(90)).order('created_at', { ascending: false }).range(from, to), 1000, 5000);
  const live = orders.filter(ACTIVE);

  let mandiBase = 0, premium = 0, retailBase = 0, saved = 0;
  for (const o of live) for (const it of o.items) {
    const q = Number(it.quantity);
    if (it.mandi_price) { mandiBase += Number(it.mandi_price) * q; premium += (Number(it.unit_price) - Number(it.mandi_price)) * q; }
    if (it.retail_price) { retailBase += Number(it.retail_price) * q; saved += (Number(it.retail_price) - Number(it.unit_price)) * q; }
  }
  const districts = {};
  for (const o of live) { const d = o.seller?.district || 'Unknown'; districts[d] = (districts[d] || 0) + Number(o.total_amount); }

  const ships = unwrap(await supabase.from('shipments').select('status, total_distance_km, baseline_distance_km').neq('status', 'cancelled'));
  const km = ships.reduce((s, x) => s + Number(x.total_distance_km), 0);
  const base = ships.reduce((s, x) => s + Number(x.baseline_distance_km), 0);

  const { count: activeListings } = await supabase.from('products').select('id', { count: 'exact', head: true }).eq('status', 'active');

  res.json({
    totals: {
      gmv: round(live.reduce((s, o) => s + Number(o.total_amount), 0)),
      orders: live.length,
      volume_kg: round(live.reduce((s, o) => s + Number(o.total_weight_kg), 0)),
      users: profiles.length,
      active_listings: activeListings ?? 0,
      farmer_premium_pct: mandiBase ? round((premium / mandiBase) * 100, 1) : null,
      consumer_saving_pct: retailBase ? round((saved / retailBase) * 100, 1) : null,
      route_saving_pct: base ? round(((base - km) / base) * 100, 1) : null,
      shipments: ships.length,
    },
    users_by_role: Object.entries(users).map(([role, count]) => ({ role, count })),
    by_status: statusCounts(orders),
    gmv_by_day: dailySeries(live, 30, (o) => Number(o.total_amount)),
    gmv_by_district: Object.entries(districts).map(([name, value]) => ({ name, value: round(value) })).sort((a, b) => b.value - a.value).slice(0, 8),
    ai_service: await aiHealth(),
  });
}));

export default router;
