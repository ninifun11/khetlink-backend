import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, asyncHandler, unwrap } from '../utils/http.js';
import { haversineKm } from '../utils/geo.js';

const router = Router();

const CATEGORIES = ['vegetables', 'fruits', 'grains', 'pulses', 'spices', 'dairy', 'other'];
const UNITS = ['kg', 'quintal', 'dozen', 'piece', 'bunch'];
const DEFAULT_KG = { kg: 1, quintal: 100, dozen: 1.2, piece: 0.25, bunch: 0.25 };

const SELLER_COLS = 'id, full_name, role, organization, district, village';
const SELLER = `seller:profiles!products_seller_id_fkey(${SELLER_COLS})`;
const SELLER_INNER = `seller:profiles!products_seller_id_fkey!inner(${SELLER_COLS})`; // inner join → can filter by seller role

const withMeta = (p) => ({
  ...p,
  saving_vs_retail_pct: p.retail_price_per_unit && p.retail_price_per_unit > 0
    ? Math.round(((p.retail_price_per_unit - p.price_per_unit) / p.retail_price_per_unit) * 100) : null,
  premium_vs_mandi_pct: p.mandi_price_per_unit && p.mandi_price_per_unit > 0
    ? Math.round(((p.price_per_unit - p.mandi_price_per_unit) / p.mandi_price_per_unit) * 100) : null,
});

// ---------------------------------------------------------------------------
// Public browse (no login required)
// ---------------------------------------------------------------------------
const listQuery = z.object({
  q: z.string().trim().max(60).optional(),
  category: z.enum(CATEGORIES).optional(),
  district: z.string().trim().max(60).optional(),
  organic: z.enum(['true', 'false']).optional(),
  seller_role: z.enum(['farmer', 'fpo']).optional(),
  min_price: z.coerce.number().min(0).optional(),
  max_price: z.coerce.number().min(0).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'nearest']).default('newest'),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(48),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const f = req.q;
  let query = supabase.from('products')
    .select(`*, ${f.seller_role ? SELLER_INNER : SELLER}`, { count: 'exact' })
    .eq('status', 'active').gt('quantity_available', 0);
  if (f.seller_role) query = query.eq('seller.role', f.seller_role);

  if (f.q) query = query.ilike('name', `%${f.q.replace(/[%_,]/g, ' ')}%`);
  if (f.category) query = query.eq('category', f.category);
  if (f.district) query = query.ilike('district', f.district);
  if (f.organic) query = query.eq('is_organic', f.organic === 'true');
  if (f.min_price !== undefined) query = query.gte('price_per_unit', f.min_price);
  if (f.max_price !== undefined) query = query.lte('price_per_unit', f.max_price);

  const nearest = f.sort === 'nearest' && f.lat !== undefined && f.lng !== undefined;
  if (f.sort === 'price_asc') query = query.order('price_per_unit', { ascending: true });
  else if (f.sort === 'price_desc') query = query.order('price_per_unit', { ascending: false });
  else query = query.order('created_at', { ascending: false });

  if (nearest) query = query.limit(500); // sort in memory by distance, then page
  else query = query.range(f.offset, f.offset + f.limit - 1);

  const { data, count, error } = await query;
  if (error) throw new HttpError(500, error.message);

  let items = data.map(withMeta);
  if (nearest) {
    items = items
      .map((p) => ({ ...p, distance_km: p.lat != null && p.lng != null ? Math.round(haversineKm({ lat: f.lat, lng: f.lng }, p) * 10) / 10 : null }))
      .sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9))
      .slice(f.offset, f.offset + f.limit);
  }
  res.json({ products: items, total: count ?? items.length });
}));

// ---------------------------------------------------------------------------
// Seller's own listings (declared before '/:id')
// ---------------------------------------------------------------------------
router.get('/mine', requireAuth, requireRole('farmer', 'fpo', 'admin'), asyncHandler(async (req, res) => {
  let q = supabase.from('products').select('*').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') q = q.eq('seller_id', req.user.id);
  res.json({ products: unwrap(await q).map(withMeta) });
}));

router.get('/:id', validate(z.object({ id: z.string().uuid() }), 'params'), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('products').select(`*, ${SELLER}`).eq('id', req.params.id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, 'Product not found');
  res.json({ product: withMeta(data) });
}));

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------
const num = (min = 0) => z.coerce.number().min(min);
const productBody = z.object({
  name: z.string().trim().min(2).max(80),
  category: z.enum(CATEGORIES).default('vegetables'),
  description: z.string().trim().max(600).optional().nullable(),
  unit: z.enum(UNITS).default('kg'),
  kg_per_unit: z.coerce.number().positive().max(1000).optional(),
  price_per_unit: num(0),
  mandi_price_per_unit: num(0).optional().nullable(),
  retail_price_per_unit: num(0).optional().nullable(),
  quantity_available: num(0),
  min_order_qty: z.coerce.number().positive().default(1),
  is_organic: z.boolean().default(false),
  harvest_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').optional().nullable(),
  district: z.string().trim().max(80).optional().nullable(),
  lat: z.coerce.number().min(-90).max(90).optional().nullable(),
  lng: z.coerce.number().min(-180).max(180).optional().nullable(),
  image_emoji: z.string().trim().max(8).optional().nullable(),
  status: z.enum(['active', 'paused']).optional(),
});

router.post('/', requireAuth, requireRole('farmer', 'fpo'), validate(productBody), asyncHandler(async (req, res) => {
  const b = req.body;
  const row = {
    ...b,
    seller_id: req.user.id,
    kg_per_unit: b.kg_per_unit ?? DEFAULT_KG[b.unit],
    district: b.district ?? req.user.district,
    lat: b.lat ?? req.user.lat,
    lng: b.lng ?? req.user.lng,
    status: b.quantity_available > 0 ? (b.status ?? 'active') : 'sold_out',
  };
  const product = unwrap(await supabase.from('products').insert(row).select().single());
  res.status(201).json({ product: withMeta(product) });
}));

router.put('/:id', requireAuth, requireRole('farmer', 'fpo', 'admin'),
  validate(z.object({ id: z.string().uuid() }), 'params'),
  validate(productBody.partial()),
  asyncHandler(async (req, res) => {
    const { data: existing } = await supabase.from('products').select('*').eq('id', req.params.id).maybeSingle();
    if (!existing) throw new HttpError(404, 'Product not found');
    if (existing.seller_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'You can only edit your own listings');

    const patch = { ...req.body };
    const unit = patch.unit ?? existing.unit;
    if (patch.unit && patch.kg_per_unit === undefined) patch.kg_per_unit = DEFAULT_KG[unit];
    const qty = patch.quantity_available ?? existing.quantity_available;
    if (qty <= 0) patch.status = 'sold_out';
    else if (existing.status === 'sold_out' && !patch.status) patch.status = 'active';

    const product = unwrap(await supabase.from('products').update(patch).eq('id', existing.id).select().single());
    res.json({ product: withMeta(product) });
  }));

router.delete('/:id', requireAuth, requireRole('farmer', 'fpo', 'admin'),
  validate(z.object({ id: z.string().uuid() }), 'params'),
  asyncHandler(async (req, res) => {
    const { data: existing } = await supabase.from('products').select('seller_id').eq('id', req.params.id).maybeSingle();
    if (!existing) throw new HttpError(404, 'Product not found');
    if (existing.seller_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'You can only delete your own listings');
    unwrap(await supabase.from('products').delete().eq('id', req.params.id));
    res.json({ ok: true });
  }));

export default router;
