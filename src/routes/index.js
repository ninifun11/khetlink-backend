import { Router } from 'express';
import profile from './profile.js';
import products from './products.js';
import orders from './orders.js';
import logistics from './logistics.js';
import ai from './ai.js';
import analytics from './analytics.js';
import { aiHealth } from '../services/aiClient.js';
import { supabase } from '../config/supabase.js';

const router = Router();

router.get('/health', async (_req, res) => {
  const { error } = await supabase.from('profiles').select('id', { head: true, count: 'exact' }).limit(1);
  res.json({
    status: error ? 'degraded' : 'ok',
    database: error ? `error: ${error.message}` : 'ok',
    ai_service: await aiHealth(),
    time: new Date().toISOString(),
  });
});

router.use('/profile', profile);
router.use('/products', products);
router.use('/orders', orders);
router.use('/logistics', logistics);
router.use('/ai', ai);
router.use('/analytics', analytics);

export default router;
