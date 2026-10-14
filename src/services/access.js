import { supabase } from '../config/supabase.js';
import { HttpError } from '../utils/http.js';

/**
 * Seller ids whose orders this user may manage.
 *  - farmer  → themselves
 *  - fpo     → themselves + every farmer that joined the FPO
 *  - admin   → null (means "everyone")
 */
export async function managedSellerIds(user) {
  if (user.role === 'admin') return null;
  const ids = [user.id];
  if (user.role === 'fpo') {
    const { data, error } = await supabase.from('profiles').select('id').eq('fpo_id', user.id);
    if (error) throw new HttpError(500, error.message);
    ids.push(...data.map((r) => r.id));
  }
  return ids;
}

export const ORDER_SELECT = `*,
  items:order_items(*),
  buyer:profiles!orders_buyer_id_fkey(id, full_name, phone, organization),
  seller:profiles!orders_seller_id_fkey(id, full_name, phone, organization, district),
  shipment:shipments(id, status, driver_id, vehicle_id)`;
