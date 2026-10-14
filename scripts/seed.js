/**
 * Demo data seeder.
 *   npm run seed          → creates demo users, products, vehicles, 12 months of market data, sample orders
 *   npm run seed:reset    → wipes orders/products/vehicles/market data first, then seeds again
 *
 * All demo accounts share the password below.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || SUPABASE_URL.includes('YOUR')) {
  console.error('✖ Fill SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env first.');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const RESET = process.argv.includes('--reset');
const PASSWORD = 'Demo@12345';

// ---------- deterministic randomness so every run looks the same ----------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260920);
const between = (a, b) => a + rand() * (b - a);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

// ---------- catalogue ----------
// mandi / retail are ₹ per kg; demand = typical network-wide kg/day per district unit; phase = day-of-year of price peak
const CROPS = [
  { name: 'Tomato',       emoji: '🍅', category: 'vegetables', mandi: 18,  retail: 38,  demand: 520, phase: 150, amp: 0.30 },
  { name: 'Onion',        emoji: '🧅', category: 'vegetables', mandi: 22,  retail: 40,  demand: 610, phase: 300, amp: 0.25 },
  { name: 'Potato',       emoji: '🥔', category: 'vegetables', mandi: 20,  retail: 34,  demand: 560, phase: 40,  amp: 0.15 },
  { name: 'Brinjal',      emoji: '🍆', category: 'vegetables', mandi: 24,  retail: 44,  demand: 240, phase: 200, amp: 0.20 },
  { name: 'Okra',         emoji: '🌿', category: 'vegetables', mandi: 28,  retail: 52,  demand: 210, phase: 250, amp: 0.22 },
  { name: 'Cauliflower',  emoji: '🥦', category: 'vegetables', mandi: 22,  retail: 46,  demand: 200, phase: 20,  amp: 0.28 },
  { name: 'Spinach',      emoji: '🥬', category: 'vegetables', mandi: 30,  retail: 60,  demand: 150, phase: 15,  amp: 0.18 },
  { name: 'Green Chilli', emoji: '🌶️', category: 'vegetables', mandi: 42,  retail: 84,  demand: 170, phase: 320, amp: 0.32 },
  { name: 'Banana',       emoji: '🍌', category: 'fruits',     mandi: 28,  retail: 52,  demand: 330, phase: 180, amp: 0.12 },
  { name: 'Mango',        emoji: '🥭', category: 'fruits',     mandi: 46,  retail: 98,  demand: 260, phase: 130, amp: 0.35 },
  { name: 'Rice',         emoji: '🌾', category: 'grains',     mandi: 40,  retail: 62,  demand: 900, phase: 60,  amp: 0.06 },
  { name: 'Toor Dal',     emoji: '🫘', category: 'pulses',     mandi: 112, retail: 152, demand: 300, phase: 90,  amp: 0.10 },
];
const CROP = Object.fromEntries(CROPS.map((c) => [c.name, c]));

const DISTRICTS = [
  { name: 'Hyderabad',   weight: 1.6, price: 1.06 },
  { name: 'Rangareddy',  weight: 1.0, price: 1.02 },
  { name: 'Medak',       weight: 0.6, price: 0.97 },
  { name: 'Sangareddy',  weight: 0.7, price: 0.98 },
  { name: 'Warangal',    weight: 0.9, price: 0.99 },
  { name: 'Nalgonda',    weight: 0.6, price: 0.96 },
];

const HUB = { lat: 17.533, lng: 78.265 }; // Patancheru aggregation hub

const USERS = [
  { key: 'admin',     email: 'khetlink.admin@example.com',   name: 'Platform Admin',             role: 'admin',      district: 'Hyderabad',  lat: 17.385, lng: 78.4867, address: 'KhetLink HQ, Hyderabad' },
  { key: 'fpo',       email: 'khetlink.fpo@example.com',     name: 'Meena Reddy',                role: 'fpo',        org: 'Medak Kisan Producer Co.', district: 'Sangareddy', village: 'Patancheru', ...HUB, address: 'Collection hub, Patancheru' },
  { key: 'farmer1',   email: 'khetlink.farmer1@example.com', name: 'Ravi Kumar',                 role: 'farmer',     district: 'Sangareddy', village: 'Kondapur',  lat: 17.6247, lng: 78.0867, address: 'Kondapur village, Sangareddy', fpo: true },
  { key: 'farmer2',   email: 'khetlink.farmer2@example.com', name: 'Lakshmi Devi',               role: 'farmer',     district: 'Vikarabad',  village: 'Nawabpet',  lat: 17.3381, lng: 77.9043, address: 'Nawabpet, Vikarabad', fpo: true },
  { key: 'farmer3',   email: 'khetlink.farmer3@example.com', name: 'Narsimha Reddy',             role: 'farmer',     district: 'Medak',      village: 'Toopran',   lat: 18.0453, lng: 78.2607, address: 'Toopran, Medak', fpo: true },
  { key: 'farmer4',   email: 'khetlink.farmer4@example.com', name: 'Sunitha Rao',                role: 'farmer',     district: 'Nalgonda',   village: 'Miryalaguda', lat: 17.0575, lng: 79.2671, address: 'Miryalaguda, Nalgonda' },
  { key: 'farmer5',   email: 'khetlink.farmer5@example.com', name: 'Mahesh Goud',                role: 'farmer',     district: 'Warangal',   village: 'Hanamkonda', lat: 17.9689, lng: 79.5941, address: 'Hanamkonda, Warangal' },
  { key: 'consumer1', email: 'khetlink.consumer1@example.com', name: 'Anjali Sharma',            role: 'consumer',   district: 'Hyderabad',  lat: 17.4948, lng: 78.3996, address: 'Kukatpally, Hyderabad' },
  { key: 'consumer2', email: 'khetlink.consumer2@example.com', name: 'Rahul Verma',              role: 'consumer',   district: 'Hyderabad',  lat: 17.4483, lng: 78.3915, address: 'Madhapur, Hyderabad' },
  { key: 'buyer1',    email: 'khetlink.buyer1@example.com',  name: 'Kiran Patel',                role: 'bulk_buyer', org: 'Green Leaf Restaurants', district: 'Hyderabad', lat: 17.4126, lng: 78.4482, address: 'Banjara Hills, Hyderabad' },
  { key: 'buyer2',    email: 'khetlink.buyer2@example.com',  name: 'Sridevi N',                  role: 'bulk_buyer', org: 'Sri Sai Hostel Mess',    district: 'Hyderabad', lat: 17.4401, lng: 78.3489, address: 'Gachibowli, Hyderabad' },
  { key: 'driver1',   email: 'khetlink.driver1@example.com', name: 'Suresh Yadav',               role: 'driver',     district: 'Sangareddy', lat: 17.53, lng: 78.26, address: 'Patancheru' },
  { key: 'driver2',   email: 'khetlink.driver2@example.com', name: 'Imran Khan',                 role: 'driver',     district: 'Rangareddy', lat: 17.53, lng: 78.26, address: 'Patancheru' },
];

// what each seller lists: [crop, qty (kg, or quintals for quintal-unit crops), organic]
const LISTINGS = {
  fpo:     [['Tomato', 1800], ['Onion', 2500], ['Potato', 2000], ['Rice', 60], ['Green Chilli', 400]],
  farmer1: [['Tomato', 600], ['Brinjal', 350], ['Okra', 250, true], ['Cauliflower', 300]],
  farmer2: [['Spinach', 180], ['Green Chilli', 220, true], ['Okra', 200], ['Banana', 500]],
  farmer3: [['Mango', 700], ['Toor Dal', 25], ['Onion', 900]],
  farmer4: [['Rice', 40], ['Toor Dal', 30], ['Potato', 700]],
  farmer5: [['Green Chilli', 500], ['Tomato', 800], ['Banana', 400]],
};
const QUINTAL = new Set(['Rice', 'Toor Dal']);

// ---------- helpers ----------
const must = (res, label) => { if (res.error) { throw new Error(`${label}: ${res.error.message}`); } return res.data; };
const log = (...a) => console.log(...a);

async function ensureUser(u) {
  const created = await db.auth.admin.createUser({
    email: u.email, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: u.name, role: u.role === 'admin' ? 'consumer' : u.role, organization: u.org, district: u.district },
  });
  let id = created.data?.user?.id;
  if (!id) {
    // already exists → find it
    for (let page = 1; page < 20 && !id; page++) {
      const { data } = await db.auth.admin.listUsers({ page, perPage: 200 });
      id = data?.users?.find((x) => x.email === u.email)?.id;
      if (!data?.users?.length) break;
    }
  }
  if (!id) throw new Error(`Could not create or find ${u.email}: ${created.error?.message}`);
  return id;
}

async function main() {
  log('\n🌾 KhetLink seeder\n');

  if (RESET) {
    log('• Resetting existing demo data…');
    await db.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('shipments').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('vehicles').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('market_data').delete().gt('id', 0);
  }

  // ---- users & profiles ----
  log('• Creating users…');
  const ids = {};
  for (const u of USERS) ids[u.key] = await ensureUser(u);
  for (const u of USERS) {
    must(await db.from('profiles').update({
      full_name: u.name, role: u.role, organization: u.org ?? null, district: u.district, village: u.village ?? null,
      lat: u.lat, lng: u.lng, address: u.address, phone: `+91 9${String(Math.floor(between(1e8, 9.9e8))).padStart(9, '0')}`,
      fpo_id: u.fpo ? ids.fpo : null,
    }).eq('id', ids[u.key]), `profile ${u.key}`);
  }

  // ---- vehicles ----
  log('• Adding vehicles…');
  const { count: vCount } = await db.from('vehicles').select('id', { count: 'exact', head: true });
  let vehicles = [];
  if (!vCount) {
    vehicles = must(await db.from('vehicles').insert([
      { owner_id: ids.fpo, name: 'Tata Ace Gold',          registration_no: 'TS 08 UB 4412', vehicle_type: 'mini_truck', capacity_kg: 750,  cost_per_km: 11, fixed_cost: 100, driver_id: ids.driver1 },
      { owner_id: ids.fpo, name: 'Mahindra Bolero Pickup', registration_no: 'TS 09 UC 1278', vehicle_type: 'pickup',     capacity_kg: 1250, cost_per_km: 14, fixed_cost: 150, driver_id: ids.driver2 },
      { owner_id: ids.fpo, name: 'Eicher Pro 2049',        registration_no: 'TS 07 UD 9051', vehicle_type: 'truck',      capacity_kg: 3000, cost_per_km: 22, fixed_cost: 300, driver_id: null },
    ]).select(), 'vehicles');
  } else {
    vehicles = must(await db.from('vehicles').select('*'), 'vehicles');
  }

  // ---- products ----
  log('• Listing products…');
  const { count: pCount } = await db.from('products').select('id', { count: 'exact', head: true });
  let products = [];
  if (!pCount) {
    const rows = [];
    for (const u of USERS) {
      for (const [cropName, qty, organic] of LISTINGS[u.key] || []) {
        const c = CROP[cropName];
        const quintal = QUINTAL.has(cropName);
        const mult = quintal ? 100 : 1;
        const farmKg = r1(c.mandi * between(1.1, 1.24));
        const daysAgo = Math.floor(between(0, 4));
        const harvest = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
        rows.push({
          seller_id: ids[u.key], name: c.name, category: c.category, unit: quintal ? 'quintal' : 'kg', kg_per_unit: quintal ? 100 : 1,
          description: `${organic ? 'Organically grown ' : 'Fresh '}${c.name.toLowerCase()} from ${u.org || u.village || u.district}. ${quintal ? 'Sold by the quintal (100 kg).' : 'Harvested and packed within days.'}`,
          price_per_unit: r2(farmKg * mult), mandi_price_per_unit: r2(c.mandi * mult), retail_price_per_unit: r2(c.retail * mult),
          quantity_available: qty, min_order_qty: quintal ? 0.25 : 1, is_organic: !!organic, harvest_date: harvest,
          district: u.district, lat: u.lat, lng: u.lng, image_emoji: c.emoji, status: 'active',
        });
      }
    }
    products = must(await db.from('products').insert(rows).select(), 'products');
  } else {
    products = must(await db.from('products').select('*').eq('status', 'active'), 'products');
  }

  // ---- market data (365 days × crops × districts) ----
  const { count: mCount } = await db.from('market_data').select('id', { count: 'exact', head: true });
  if (!mCount) {
    log('• Generating 12 months of market data (this takes a few seconds)…');
    const rows = [];
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const DOW = [1.12, 0.92, 0.95, 0.97, 1.0, 1.05, 1.18]; // Sun..Sat
    for (let i = 364; i >= 0; i--) {
      const d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
      const doy = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
      for (const c of CROPS) {
        const season = 1 + c.amp * Math.cos((2 * Math.PI * (doy - c.phase)) / 365);
        const dSeason = 1 + 0.12 * Math.cos((2 * Math.PI * (doy - (c.phase + 20))) / 365);
        for (const dist of DISTRICTS) {
          const price = Math.max(4, c.mandi * season * dist.price * (1 + 0.04 * gauss()));
          const demand = c.demand * dist.weight * DOW[d.getUTCDay()] * dSeason * (1 + 0.12 * (1 - i / 364)) * (1 + 0.06 * gauss());
          rows.push({
            crop: c.name, district: dist.name, date: d.toISOString().slice(0, 10),
            price_per_kg: r2(price), retail_price_per_kg: r2(price * (1.75 + 0.1 * gauss())), demand_kg: r1(Math.max(5, demand)),
          });
        }
      }
    }
    for (let i = 0; i < rows.length; i += 1000) {
      must(await db.from('market_data').upsert(rows.slice(i, i + 1000), { onConflict: 'crop,district,date' }), 'market_data');
    }
    log(`  ${rows.length.toLocaleString()} rows`);
  }

  // ---- sample orders ----
  const { count: oCount } = await db.from('orders').select('id', { count: 'exact', head: true });
  if (!oCount && products.length) {
    log('• Placing sample orders…');
    const buyers = ['consumer1', 'consumer2', 'buyer1', 'buyer2'].map((k) => ({ key: k, ...USERS.find((u) => u.key === k), id: ids[k] }));
    const fpoGroup = new Set([ids.fpo, ids.farmer1, ids.farmer2, ids.farmer3]);
    const TOTAL = 46, SPECIAL = 19; // the last 19 orders are shaped for the live demo (9 packed, 10 pending)
    const placed = [];

    for (let n = 0; n < TOTAL; n++) {
      const special = n >= TOTAL - SPECIAL;
      const buyer = special && n < TOTAL - 7 ? pick(buyers.slice(2)) : pick(buyers);
      const bulk = buyer.role === 'bulk_buyer';
      const pool = special && n < TOTAL - 7 ? products.filter((p) => fpoGroup.has(p.seller_id)) : products;
      const chosen = [...new Set(Array.from({ length: bulk ? 3 : 2 }, () => pick(pool)))];
      const items = chosen.map((p) => ({
        product_id: p.id,
        quantity: p.unit === 'quintal' ? pick([0.5, 1, 1.5]) : Math.round(bulk ? between(25, 110) : between(2, 12)),
      }));
      const { data: orderIds, error } = await db.rpc('place_order', {
        p_buyer: buyer.id, p_items: items, p_delivery_address: `${buyer.address}`,
        p_delivery_lat: r2(buyer.lat + between(-0.012, 0.012)), p_delivery_lng: r2(buyer.lng + between(-0.012, 0.012)),
        p_payment_method: pick(['cod', 'upi']), p_notes: null,
      });
      if (error) { log(`  skipped order ${n}: ${error.message}`); continue; }
      for (const id of orderIds) placed.push({ id, n, special });
    }

    // shape history: spread over 30 days, mark statuses
    const now = Date.now();
    let packedCount = 0;
    for (const o of placed) {
      let created, status;
      if (!o.special) {
        created = new Date(now - between(3, 30) * 86400000);
        status = rand() < 0.06 ? 'cancelled' : 'delivered';
      } else {
        created = new Date(now - between(0.05, 1.5) * 86400000);
        const k = o.n - (TOTAL - SPECIAL);
        status = k >= 9 ? pick(['placed', 'confirmed']) : 'packed';
      }
      if (status === 'cancelled') { must(await db.rpc('cancel_order', { p_order_id: o.id }), 'cancel'); }
      must(await db.from('orders').update({
        created_at: created.toISOString(),
        status,
        ...(status === 'delivered' ? { delivered_at: new Date(created.getTime() + between(0.4, 2) * 86400000).toISOString(), payment_status: 'paid' } : {}),
      }).eq('id', o.id), 'order update');
      if (status === 'packed') packedCount++;
    }
    log(`  ${placed.length} orders (${packedCount} packed and waiting for a truck)`);

    // historical completed shipments for the logistics analytics
    const delivered = must(await db.from('orders').select('id, seller_id').eq('status', 'delivered').is('shipment_id', null), 'delivered');
    const fpoDelivered = delivered.filter((o) => fpoGroup.has(o.seller_id));
    for (let i = 0; i + 3 <= fpoDelivered.length && i < 18; i += 3) {
      const group = fpoDelivered.slice(i, i + 3);
      const v = vehicles[i / 3 % 2];
      const km = r1(between(70, 130));
      const ship = must(await db.from('shipments').insert({
        created_by: ids.fpo, vehicle_id: v.id, driver_id: v.driver_id, status: 'completed',
        total_distance_km: km, baseline_distance_km: r1(km * between(1.5, 2.2)), total_duration_min: r1(km * 1.9), total_load_kg: r1(between(180, 520)),
        cost_estimate: r1(km * v.cost_per_km + v.fixed_cost), plan: {},
        created_at: new Date(now - between(4, 28) * 86400000).toISOString(),
        completed_at: new Date(now - between(1, 3) * 86400000).toISOString(),
      }).select().single(), 'shipment');
      must(await db.from('orders').update({ shipment_id: ship.id }).in('id', group.map((g) => g.id)), 'attach shipment');
    }
  } else if (oCount) {
    log('• Orders already exist — skipped (use `npm run seed:reset` for a clean slate)');
  }

  log('\n✔ Done. Demo logins (password for all: ' + PASSWORD + '):\n');
  for (const u of USERS) log(`   ${u.role.padEnd(11)} ${u.email}`);
  log('');
}

main().catch((e) => { console.error('\n✖ Seed failed:', e.message); process.exit(1); });
