import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, asyncHandler, unwrap } from '../utils/http.js';
import { callAI } from '../services/aiClient.js';
import { ORDER_SELECT, managedSellerIds } from '../services/access.js';

const router = Router();
router.use(requireAuth);

const uuid = z.string().uuid();
const idParam = validate(z.object({ id: uuid }), 'params');

// Optimisation previews live here until dispatched (use Redis if you run several API instances)
const PLAN_TTL_MS = 15 * 60 * 1000;
const plans = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of plans) if (v.expires < now) plans.delete(k);
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------
router.get('/vehicles', requireRole('fpo', 'admin', 'driver'), asyncHandler(async (req, res) => {
  let q = supabase.from('vehicles')
    .select('*, driver:profiles!vehicles_driver_id_fkey(id, full_name, phone)').order('name');
  if (req.user.role === 'fpo') q = q.eq('owner_id', req.user.id);
  if (req.user.role === 'driver') q = q.eq('driver_id', req.user.id);
  res.json({ vehicles: unwrap(await q) });
}));

const vehicleBody = z.object({
  name: z.string().trim().min(2).max(60),
  registration_no: z.string().trim().max(20).optional().nullable(),
  vehicle_type: z.enum(['mini_truck', 'pickup', 'tempo', 'van', 'truck']).default('mini_truck'),
  capacity_kg: z.coerce.number().positive().max(40000),
  cost_per_km: z.coerce.number().min(0).max(500).default(12),
  fixed_cost: z.coerce.number().min(0).max(100000).default(0),
  driver_id: uuid.optional().nullable(),
  is_active: z.boolean().optional(),
});

router.post('/vehicles', requireRole('fpo', 'admin'), validate(vehicleBody), asyncHandler(async (req, res) => {
  const vehicle = unwrap(await supabase.from('vehicles').insert({ ...req.body, owner_id: req.user.id }).select().single());
  res.status(201).json({ vehicle });
}));

router.put('/vehicles/:id', requireRole('fpo', 'admin'), idParam, validate(vehicleBody.partial()), asyncHandler(async (req, res) => {
  const { data: v } = await supabase.from('vehicles').select('owner_id').eq('id', req.params.id).maybeSingle();
  if (!v) throw new HttpError(404, 'Vehicle not found');
  if (v.owner_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Not your vehicle');
  const vehicle = unwrap(await supabase.from('vehicles').update(req.body).eq('id', req.params.id).select().single());
  res.json({ vehicle });
}));

router.delete('/vehicles/:id', requireRole('fpo', 'admin'), idParam, asyncHandler(async (req, res) => {
  const { data: v } = await supabase.from('vehicles').select('owner_id').eq('id', req.params.id).maybeSingle();
  if (!v) throw new HttpError(404, 'Vehicle not found');
  if (v.owner_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Not your vehicle');
  unwrap(await supabase.from('vehicles').delete().eq('id', req.params.id));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Orders waiting for a truck
// ---------------------------------------------------------------------------
router.get('/pending-orders', requireRole('fpo', 'admin'), asyncHandler(async (req, res) => {
  const ids = await managedSellerIds(req.user);
  let q = supabase.from('orders').select(ORDER_SELECT)
    .in('status', ['confirmed', 'packed']).is('shipment_id', null).order('created_at');
  if (ids) q = q.in('seller_id', ids);
  const orders = unwrap(await q).map((o) => ({
    ...o,
    has_coordinates: [o.pickup_lat, o.pickup_lng, o.delivery_lat, o.delivery_lng].every((x) => x != null),
  }));
  res.json({ orders });
}));

// ---------------------------------------------------------------------------
// Optimise (preview only — nothing is written until /dispatch)
// ---------------------------------------------------------------------------
const optimizeBody = z.object({
  order_ids: z.array(uuid).min(1).max(60),
  vehicle_ids: z.array(uuid).min(1).max(15),
  depot: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    name: z.string().trim().max(80).optional(),
  }),
  max_route_km: z.coerce.number().positive().max(2000).default(400),
});

router.post('/optimize', requireRole('fpo', 'admin'), validate(optimizeBody), asyncHandler(async (req, res) => {
  const { order_ids, vehicle_ids, depot, max_route_km } = req.body;

  const managed = await managedSellerIds(req.user);
  const orders = unwrap(await supabase.from('orders').select(ORDER_SELECT).in('id', order_ids));
  const usable = [];
  const skipped = [];
  for (const o of orders) {
    if (managed && !managed.includes(o.seller_id)) { skipped.push({ order_id: o.id, reason: 'not one of your orders' }); continue; }
    if (o.shipment_id || !['confirmed', 'packed'].includes(o.status)) { skipped.push({ order_id: o.id, reason: `order is already ${o.shipment_id ? 'dispatched' : o.status}` }); continue; }
    if ([o.pickup_lat, o.pickup_lng, o.delivery_lat, o.delivery_lng].some((x) => x == null)) { skipped.push({ order_id: o.id, reason: 'missing pickup or delivery coordinates' }); continue; }
    usable.push(o);
  }
  if (!usable.length) throw new HttpError(400, 'None of the selected orders can be routed', skipped);

  let vq = supabase.from('vehicles').select('*').in('id', vehicle_ids).eq('is_active', true);
  if (req.user.role === 'fpo') vq = vq.eq('owner_id', req.user.id);
  const vehicles = unwrap(await vq);
  if (!vehicles.length) throw new HttpError(400, 'Select at least one active vehicle you own');

  const ai = await callAI('/route/optimize', {
    depot: { lat: depot.lat, lng: depot.lng, name: depot.name || 'Collection hub' },
    orders: usable.map((o) => ({
      id: o.id,
      label: `#${o.order_no}`,
      weight_kg: Math.max(1, Number(o.total_weight_kg)),
      pickup: { lat: o.pickup_lat, lng: o.pickup_lng, name: o.seller?.organization || o.seller?.full_name || 'Farm pickup' },
      delivery: { lat: o.delivery_lat, lng: o.delivery_lng, name: o.buyer?.organization || o.buyer?.full_name || 'Customer' },
    })),
    vehicles: vehicles.map((v) => ({
      id: v.id, name: v.name, capacity_kg: Number(v.capacity_kg),
      cost_per_km: Number(v.cost_per_km), fixed_cost: Number(v.fixed_cost),
    })),
    max_route_km,
  }, { timeoutMs: 45000 });

  const vehicleById = Object.fromEntries(vehicles.map((v) => [v.id, v]));
  const planId = randomUUID();
  plans.set(planId, { userId: req.user.id, ai, vehicleById, depot, expires: Date.now() + PLAN_TTL_MS });

  res.json({
    plan_id: planId,
    depot,
    ...ai,
    unassigned: [...ai.unassigned, ...skipped],
    routes: ai.routes.map((r) => ({ ...r, driver_id: vehicleById[r.vehicle_id]?.driver_id ?? null })),
  });
}));

// ---------------------------------------------------------------------------
// Dispatch a previewed plan → creates shipments and attaches orders
// ---------------------------------------------------------------------------
router.post('/dispatch', requireRole('fpo', 'admin'), validate(z.object({ plan_id: uuid })), asyncHandler(async (req, res) => {
  const plan = plans.get(req.body.plan_id);
  if (!plan || plan.userId !== req.user.id) throw new HttpError(404, 'This plan has expired — run the optimiser again');

  const allOrderIds = plan.ai.routes.flatMap((r) => r.order_ids);
  const fresh = unwrap(await supabase.from('orders').select('id, status, shipment_id').in('id', allOrderIds));
  const stale = fresh.filter((o) => o.shipment_id || !['confirmed', 'packed'].includes(o.status));
  if (stale.length) throw new HttpError(409, 'Some orders changed since the plan was made — run the optimiser again');

  const created = [];
  for (const r of plan.ai.routes) {
    const v = plan.vehicleById[r.vehicle_id];
    const shipment = unwrap(await supabase.from('shipments').insert({
      created_by: req.user.id,
      vehicle_id: r.vehicle_id,
      driver_id: v?.driver_id ?? null,
      total_distance_km: r.distance_km,
      total_duration_min: r.duration_min,
      total_load_kg: r.peak_load_kg,
      cost_estimate: r.cost_inr,
      // this route's fair share of the plan-level baseline (by order count)
      baseline_distance_km: Math.round((plan.ai.summary.baseline_distance_km * r.order_ids.length / Math.max(1, plan.ai.summary.orders_assigned)) * 100) / 100,
      plan: { depot: plan.depot, route: r, method: plan.ai.method },
    }).select().single());

    unwrap(await supabase.from('orders').update({ shipment_id: shipment.id, status: 'packed' }).in('id', r.order_ids));
    created.push(shipment);
  }
  plans.delete(req.body.plan_id);
  res.status(201).json({ shipments: created });
}));

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------
const SHIPMENT_SELECT = `*,
  vehicle:vehicles(id, name, registration_no, capacity_kg),
  driver:profiles!shipments_driver_id_fkey(id, full_name, phone),
  orders(id, order_no, status, total_weight_kg, delivery_address)`;

router.get('/shipments', requireRole('fpo', 'admin', 'driver'), asyncHandler(async (req, res) => {
  let q = supabase.from('shipments').select(SHIPMENT_SELECT).order('created_at', { ascending: false }).limit(100);
  if (req.user.role === 'fpo') q = q.eq('created_by', req.user.id);
  if (req.user.role === 'driver') q = q.eq('driver_id', req.user.id);
  if (req.query.status) q = q.eq('status', String(req.query.status));
  res.json({ shipments: unwrap(await q) });
}));

router.patch('/shipments/:id/status', idParam, validate(z.object({ status: z.enum(['in_transit', 'completed', 'cancelled']) })),
  asyncHandler(async (req, res) => {
    const { data: s } = await supabase.from('shipments').select('*').eq('id', req.params.id).maybeSingle();
    if (!s) throw new HttpError(404, 'Shipment not found');
    const allowed = req.user.role === 'admin' || s.created_by === req.user.id || s.driver_id === req.user.id;
    if (!allowed) throw new HttpError(403, 'Not your shipment');

    const to = req.body.status;
    const ok = (s.status === 'planned' && ['in_transit', 'cancelled'].includes(to)) || (s.status === 'in_transit' && to === 'completed');
    if (!ok) throw new HttpError(409, `A ${s.status} shipment cannot become ${to}`);

    const now = new Date().toISOString();
    if (to === 'in_transit') {
      unwrap(await supabase.from('shipments').update({ status: to, started_at: now }).eq('id', s.id));
      unwrap(await supabase.from('orders').update({ status: 'in_transit' }).eq('shipment_id', s.id).eq('status', 'packed'));
    } else if (to === 'completed') {
      unwrap(await supabase.from('shipments').update({ status: to, completed_at: now }).eq('id', s.id));
      unwrap(await supabase.from('orders').update({ status: 'delivered', delivered_at: now, payment_status: 'paid' })
        .eq('shipment_id', s.id).eq('status', 'in_transit'));
    } else {
      unwrap(await supabase.from('shipments').update({ status: to }).eq('id', s.id));
      unwrap(await supabase.from('orders').update({ shipment_id: null }).eq('shipment_id', s.id));
    }
    const shipment = unwrap(await supabase.from('shipments').select(SHIPMENT_SELECT).eq('id', s.id).single());
    res.json({ shipment });
  }));

export default router;
