import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, asyncHandler, unwrap } from '../utils/http.js';
import { ORDER_SELECT, managedSellerIds } from '../services/access.js';

const router = Router();
router.use(requireAuth);

const STATUSES = ['placed', 'confirmed', 'packed', 'in_transit', 'delivered', 'cancelled'];
const FLOW = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['in_transit'],
  in_transit: ['delivered'],
};

// ---------------------------------------------------------------------------
// Place an order  (cart may contain several sellers → one order per seller)
// ---------------------------------------------------------------------------
const placeSchema = z.object({
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.coerce.number().positive().max(100000),
  })).min(1, 'Your cart is empty').max(40),
  delivery_address: z.string().trim().min(5, 'Enter a delivery address').max(300),
  delivery_lat: z.coerce.number().min(-90).max(90),
  delivery_lng: z.coerce.number().min(-180).max(180),
  payment_method: z.enum(['cod', 'upi']).default('cod'),
  notes: z.string().trim().max(300).optional().nullable(),
});

const RPC_ERRORS = {
  EMPTY_CART: [400, 'Your cart is empty'],
  PRODUCT_UNAVAILABLE: [409, (n) => `"${n}" is no longer available`],
  OWN_PRODUCT: [400, (n) => `You cannot buy your own listing ("${n}")`],
  BELOW_MIN_QTY: [400, (n) => `"${n}" has a higher minimum order quantity`],
  INSUFFICIENT_STOCK: [409, (n) => `Not enough stock left for "${n}"`],
};

router.post('/', requireRole('consumer', 'bulk_buyer', 'fpo', 'farmer', 'admin'), validate(placeSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { data: ids, error } = await supabase.rpc('place_order', {
      p_buyer: req.user.id,
      p_items: b.items,
      p_delivery_address: b.delivery_address,
      p_delivery_lat: b.delivery_lat,
      p_delivery_lng: b.delivery_lng,
      p_payment_method: b.payment_method,
      p_notes: b.notes ?? null,
    });
    if (error) {
      const [code, arg] = (error.message || '').split(':');
      const mapped = RPC_ERRORS[code?.trim()];
      if (mapped) throw new HttpError(mapped[0], typeof mapped[1] === 'function' ? mapped[1](arg?.trim()) : mapped[1]);
      throw new HttpError(500, error.message);
    }
    const orders = unwrap(await supabase.from('orders').select(ORDER_SELECT).in('id', ids).order('order_no'));
    res.status(201).json({ orders });
  }));

// ---------------------------------------------------------------------------
// List orders — scope: buying | selling | delivery | all
// ---------------------------------------------------------------------------
const listQuery = z.object({
  scope: z.enum(['buying', 'selling', 'delivery', 'all']).optional(),
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

router.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const { role, id } = req.user;
  const defaultScope = { farmer: 'selling', fpo: 'selling', driver: 'delivery', admin: 'all' }[role] || 'buying';
  const scope = req.q.scope || defaultScope;

  let q = supabase.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(req.q.limit);
  if (req.q.status) q = q.eq('status', req.q.status);

  if (scope === 'buying') {
    q = q.eq('buyer_id', id);
  } else if (scope === 'selling') {
    if (!['farmer', 'fpo', 'admin'].includes(role)) throw new HttpError(403, 'Only sellers have received orders');
    const ids = await managedSellerIds(req.user);
    if (ids) q = q.in('seller_id', ids);
  } else if (scope === 'delivery') {
    if (!['driver', 'admin'].includes(role)) throw new HttpError(403, 'Only drivers have delivery orders');
    if (role === 'driver') {
      const ships = unwrap(await supabase.from('shipments').select('id').eq('driver_id', id));
      if (!ships.length) return res.json({ orders: [] });
      q = q.in('shipment_id', ships.map((s) => s.id));
    }
  } else if (scope === 'all' && role !== 'admin') {
    throw new HttpError(403, 'Not allowed');
  }
  res.json({ orders: unwrap(await q) });
}));

router.get('/:id', validate(z.object({ id: z.string().uuid() }), 'params'), asyncHandler(async (req, res) => {
  const { data: order, error } = await supabase.from('orders').select(ORDER_SELECT).eq('id', req.params.id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!order) throw new HttpError(404, 'Order not found');
  const managed = await managedSellerIds(req.user);
  const allowed = order.buyer_id === req.user.id || managed === null || managed.includes(order.seller_id)
    || order.shipment?.driver_id === req.user.id;
  if (!allowed) throw new HttpError(403, 'You cannot view this order');
  res.json({ order });
}));

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------
router.patch('/:id/status',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  validate(z.object({ status: z.enum(STATUSES) })),
  asyncHandler(async (req, res) => {
    const to = req.body.status;
    const { data: order, error } = await supabase.from('orders')
      .select('*, shipment:shipments(id, driver_id, status)').eq('id', req.params.id).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!order) throw new HttpError(404, 'Order not found');

    if (!FLOW[order.status]?.includes(to)) {
      throw new HttpError(409, `An order that is "${order.status}" cannot move to "${to}"`);
    }

    const managed = await managedSellerIds(req.user);
    const isAdmin = req.user.role === 'admin';
    const isSellerSide = isAdmin || (managed || []).includes(order.seller_id);
    const isBuyer = order.buyer_id === req.user.id;
    const isDriver = order.shipment?.driver_id === req.user.id;

    let allowed = false;
    if (to === 'cancelled') allowed = isSellerSide || (isBuyer && order.status === 'placed');
    else if (to === 'confirmed' || to === 'packed') allowed = isSellerSide;
    else allowed = isAdmin || isDriver || (isSellerSide && !order.shipment_id); // in_transit / delivered
    if (!allowed) throw new HttpError(403, 'You are not allowed to make this change');

    if (to === 'cancelled') {
      unwrap(await supabase.rpc('cancel_order', { p_order_id: order.id }));
    } else {
      const patch = { status: to };
      if (to === 'delivered') {
        patch.delivered_at = new Date().toISOString();
        patch.payment_status = 'paid'; // COD collected / UPI settled on delivery (payment gateway is stubbed in this MVP)
      }
      unwrap(await supabase.from('orders').update(patch).eq('id', order.id));

      // If the whole shipment is now delivered, close it.
      if (to === 'delivered' && order.shipment_id) {
        const rest = unwrap(await supabase.from('orders').select('status').eq('shipment_id', order.shipment_id));
        if (rest.every((o) => ['delivered', 'cancelled'].includes(o.status))) {
          await supabase.from('shipments').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', order.shipment_id);
        }
      }
      if (to === 'in_transit' && order.shipment_id) {
        await supabase.from('shipments').update({ status: 'in_transit', started_at: new Date().toISOString() })
          .eq('id', order.shipment_id).eq('status', 'planned');
      }
    }
    const updated = unwrap(await supabase.from('orders').select(ORDER_SELECT).eq('id', order.id).single());
    res.json({ order: updated });
  }));

export default router;
