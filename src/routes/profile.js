import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, asyncHandler, unwrap } from '../utils/http.js';

const router = Router();
router.use(requireAuth);

router.get('/me', (req, res) => res.json({ profile: req.user }));

const updateSchema = z.object({
  full_name: z.string().trim().min(2).max(80).optional(),
  phone: z.string().trim().max(20).optional().nullable(),
  organization: z.string().trim().max(100).optional().nullable(),
  village: z.string().trim().max(80).optional().nullable(),
  district: z.string().trim().max(80).optional().nullable(),
  state: z.string().trim().max(80).optional().nullable(),
  address: z.string().trim().max(250).optional().nullable(),
  lat: z.coerce.number().min(-90).max(90).optional().nullable(),
  lng: z.coerce.number().min(-180).max(180).optional().nullable(),
  fpo_id: z.string().uuid().optional().nullable(),
}).strict(); // role and id can never be changed through this endpoint

router.put('/me', validate(updateSchema), asyncHandler(async (req, res) => {
  const patch = { ...req.body };
  if (patch.fpo_id) {
    if (req.user.role !== 'farmer') throw new HttpError(400, 'Only farmers can join an FPO');
    const { data: fpo } = await supabase.from('profiles').select('id').eq('id', patch.fpo_id).eq('role', 'fpo').maybeSingle();
    if (!fpo) throw new HttpError(404, 'That FPO does not exist');
  }
  const profile = unwrap(await supabase.from('profiles').update(patch).eq('id', req.user.id).select().single());
  res.json({ profile: { ...profile, email: req.user.email } });
}));

// FPOs a farmer can join
router.get('/fpos', asyncHandler(async (_req, res) => {
  const fpos = unwrap(await supabase.from('profiles')
    .select('id, full_name, organization, district').eq('role', 'fpo').order('organization'));
  res.json({ fpos });
}));

// Drivers an FPO/admin can assign to vehicles
router.get('/drivers', asyncHandler(async (req, res) => {
  if (!['fpo', 'admin'].includes(req.user.role)) throw new HttpError(403, 'Not allowed');
  const drivers = unwrap(await supabase.from('profiles')
    .select('id, full_name, phone').eq('role', 'driver').order('full_name'));
  res.json({ drivers });
}));

export default router;
