-- =====================================================================
-- KhetLink — database schema (PostgreSQL / Supabase)
-- Run this whole file once in the Supabase SQL Editor.
-- It is idempotent: safe to re-run.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- profiles  (1:1 with auth.users)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null default '',
  role          text not null default 'consumer'
                check (role in ('farmer','fpo','consumer','bulk_buyer','driver','admin')),
  phone         text,
  organization  text,
  village       text,
  district      text,
  state         text default 'Telangana',
  address       text,
  lat           double precision,
  lng           double precision,
  fpo_id        uuid references public.profiles(id) on delete set null, -- farmer's parent FPO
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_fpo_idx on public.profiles(fpo_id);
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create a profile automatically when someone signs up.
-- Self-service sign-up can never create an 'admin'.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role text := coalesce(new.raw_user_meta_data->>'role', 'consumer');
begin
  if v_role not in ('farmer','fpo','consumer','bulk_buyer','driver') then
    v_role := 'consumer';
  end if;
  insert into public.profiles (id, full_name, role, phone, organization, district)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    v_role,
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'organization',
    new.raw_user_meta_data->>'district'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------
create table if not exists public.products (
  id                    uuid primary key default gen_random_uuid(),
  seller_id             uuid not null references public.profiles(id) on delete cascade,
  name                  text not null,
  category              text not null default 'vegetables'
                        check (category in ('vegetables','fruits','grains','pulses','spices','dairy','other')),
  description           text,
  unit                  text not null default 'kg'
                        check (unit in ('kg','quintal','dozen','piece','bunch')),
  kg_per_unit           numeric(10,3) not null default 1 check (kg_per_unit > 0),
  price_per_unit        numeric(12,2) not null check (price_per_unit >= 0),
  mandi_price_per_unit  numeric(12,2),   -- reference: wholesale (mandi) price
  retail_price_per_unit numeric(12,2),   -- reference: typical retail price
  quantity_available    numeric(12,2) not null default 0 check (quantity_available >= 0),
  min_order_qty         numeric(12,2) not null default 1 check (min_order_qty > 0),
  is_organic            boolean not null default false,
  harvest_date          date,
  district              text,
  state                 text default 'Telangana',
  lat                   double precision,
  lng                   double precision,
  image_emoji           text,
  image_url             text,
  status                text not null default 'active'
                        check (status in ('active','paused','sold_out')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists products_seller_idx on public.products(seller_id);
create index if not exists products_category_idx on public.products(category);
create index if not exists products_status_idx on public.products(status);
create index if not exists products_name_idx on public.products(lower(name));
drop trigger if exists products_updated_at on public.products;
create trigger products_updated_at before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- vehicles & shipments (logistics)
-- ---------------------------------------------------------------------
create table if not exists public.vehicles (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.profiles(id) on delete cascade,
  name            text not null,
  registration_no text,
  vehicle_type    text not null default 'mini_truck'
                  check (vehicle_type in ('mini_truck','pickup','tempo','van','truck')),
  capacity_kg     numeric(10,2) not null check (capacity_kg > 0),
  cost_per_km     numeric(10,2) not null default 12 check (cost_per_km >= 0),
  fixed_cost      numeric(10,2) not null default 0,
  driver_id       uuid references public.profiles(id) on delete set null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists vehicles_owner_idx on public.vehicles(owner_id);

create table if not exists public.shipments (
  id                  uuid primary key default gen_random_uuid(),
  created_by          uuid not null references public.profiles(id) on delete cascade,
  vehicle_id          uuid references public.vehicles(id) on delete set null,
  driver_id           uuid references public.profiles(id) on delete set null,
  status              text not null default 'planned'
                      check (status in ('planned','in_transit','completed','cancelled')),
  total_distance_km   numeric(10,2) not null default 0,
  total_duration_min  numeric(10,2) not null default 0,
  total_load_kg       numeric(10,2) not null default 0,
  cost_estimate       numeric(12,2) not null default 0,
  baseline_distance_km numeric(10,2) not null default 0,
  plan                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  completed_at        timestamptz
);
create index if not exists shipments_creator_idx on public.shipments(created_by);
create index if not exists shipments_driver_idx on public.shipments(driver_id);

-- ---------------------------------------------------------------------
-- orders & order_items
-- One order = one seller. A multi-seller cart is split into several orders.
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_no         bigint generated always as identity,
  buyer_id         uuid not null references public.profiles(id) on delete restrict,
  seller_id        uuid not null references public.profiles(id) on delete restrict,
  status           text not null default 'placed'
                   check (status in ('placed','confirmed','packed','in_transit','delivered','cancelled')),
  payment_method   text not null default 'cod' check (payment_method in ('cod','upi')),
  payment_status   text not null default 'pending' check (payment_status in ('pending','paid','refunded')),
  total_amount     numeric(12,2) not null default 0,
  total_weight_kg  numeric(12,2) not null default 0,
  delivery_address text,
  delivery_lat     double precision,
  delivery_lng     double precision,
  pickup_address   text,
  pickup_lat       double precision,
  pickup_lng       double precision,
  notes            text,
  shipment_id      uuid references public.shipments(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  delivered_at     timestamptz
);
create index if not exists orders_buyer_idx on public.orders(buyer_id);
create index if not exists orders_seller_idx on public.orders(seller_id);
create index if not exists orders_status_idx on public.orders(status);
create index if not exists orders_shipment_idx on public.orders(shipment_id);
drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

create table if not exists public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  product_id    uuid references public.products(id) on delete set null,
  product_name  text not null,
  unit          text not null,
  kg_per_unit   numeric(10,3) not null default 1,
  quantity      numeric(12,2) not null check (quantity > 0),
  unit_price    numeric(12,2) not null,
  mandi_price   numeric(12,2),   -- snapshot at order time (for farmer-premium analytics)
  retail_price  numeric(12,2),   -- snapshot at order time (for consumer-savings analytics)
  line_total    numeric(12,2) not null,
  weight_kg     numeric(12,2) not null
);
create index if not exists order_items_order_idx on public.order_items(order_id);
create index if not exists order_items_product_idx on public.order_items(product_id);

-- ---------------------------------------------------------------------
-- market_data: daily mandi price + demand per crop/district.
-- Used by the AI service for demand & price forecasting.
-- (Seeded with synthetic data; plug in Agmarknet / eNAM feeds in production.)
-- ---------------------------------------------------------------------
create table if not exists public.market_data (
  id                   bigint generated always as identity primary key,
  crop                 text not null,
  district             text not null,
  date                 date not null,
  price_per_kg         numeric(10,2) not null,
  retail_price_per_kg  numeric(10,2),
  demand_kg            numeric(14,2) not null,
  unique (crop, district, date)
);
create index if not exists market_data_crop_date_idx on public.market_data(crop, date);

-- ---------------------------------------------------------------------
-- Atomic order placement (stock is locked & decremented in one transaction)
-- Only callable with the service role (i.e. from the Express API).
-- ---------------------------------------------------------------------
create or replace function public.place_order(
  p_buyer            uuid,
  p_items            jsonb,
  p_delivery_address text,
  p_delivery_lat     double precision,
  p_delivery_lng     double precision,
  p_payment_method   text,
  p_notes            text
) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare
  v_item      jsonb;
  v_prod      public.products%rowtype;
  v_seller    public.profiles%rowtype;
  v_qty       numeric;
  v_order_ids uuid[] := '{}';
  v_order_id  uuid;
  v_line      numeric;
  v_weight    numeric;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::numeric;

    select * into v_prod from public.products
      where id = (v_item->>'product_id')::uuid for update;

    if not found or v_prod.status <> 'active' then
      raise exception 'PRODUCT_UNAVAILABLE:%', coalesce(v_prod.name, v_item->>'product_id');
    end if;
    if v_prod.seller_id = p_buyer then
      raise exception 'OWN_PRODUCT:%', v_prod.name;
    end if;
    if v_qty is null or v_qty <= 0 or v_qty < v_prod.min_order_qty then
      raise exception 'BELOW_MIN_QTY:%', v_prod.name;
    end if;
    if v_prod.quantity_available < v_qty then
      raise exception 'INSUFFICIENT_STOCK:%', v_prod.name;
    end if;

    -- find or create this seller's order within the current cart
    v_order_id := null;
    select id into v_order_id from public.orders
      where id = any(v_order_ids) and seller_id = v_prod.seller_id;

    if v_order_id is null then
      select * into v_seller from public.profiles where id = v_prod.seller_id;
      insert into public.orders (
        buyer_id, seller_id, delivery_address, delivery_lat, delivery_lng,
        pickup_address, pickup_lat, pickup_lng, payment_method, notes
      ) values (
        p_buyer, v_prod.seller_id, p_delivery_address, p_delivery_lat, p_delivery_lng,
        coalesce(v_seller.address, v_prod.district),
        coalesce(v_prod.lat, v_seller.lat), coalesce(v_prod.lng, v_seller.lng),
        coalesce(p_payment_method, 'cod'), p_notes
      ) returning id into v_order_id;
      v_order_ids := v_order_ids || v_order_id;
    end if;

    v_line   := round(v_qty * v_prod.price_per_unit, 2);
    v_weight := round(v_qty * v_prod.kg_per_unit, 2);

    insert into public.order_items (
      order_id, product_id, product_name, unit, kg_per_unit, quantity,
      unit_price, mandi_price, retail_price, line_total, weight_kg
    ) values (
      v_order_id, v_prod.id, v_prod.name, v_prod.unit, v_prod.kg_per_unit, v_qty,
      v_prod.price_per_unit, v_prod.mandi_price_per_unit, v_prod.retail_price_per_unit,
      v_line, v_weight
    );

    update public.products
       set quantity_available = quantity_available - v_qty,
           status = case when quantity_available - v_qty <= 0 then 'sold_out' else status end
     where id = v_prod.id;

    update public.orders
       set total_amount = total_amount + v_line,
           total_weight_kg = total_weight_kg + v_weight
     where id = v_order_id;
  end loop;

  return v_order_ids;
end $$;

-- Cancel an order and return its stock to the shelf.
create or replace function public.cancel_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.products p
     set quantity_available = p.quantity_available + oi.quantity,
         status = case when p.status = 'sold_out' then 'active' else p.status end
    from public.order_items oi
   where oi.order_id = p_order_id and oi.product_id = p.id;

  update public.orders
     set status = 'cancelled',
         payment_status = case when payment_status = 'paid' then 'refunded' else payment_status end
   where id = p_order_id;
end $$;

revoke all on function public.place_order(uuid, jsonb, text, double precision, double precision, text, text) from public, anon, authenticated;
grant execute on function public.place_order(uuid, jsonb, text, double precision, double precision, text, text) to service_role;
revoke all on function public.cancel_order(uuid) from public, anon, authenticated;
grant execute on function public.cancel_order(uuid) to service_role;

-- ---------------------------------------------------------------------
-- Row Level Security
-- The Express API uses the service-role key (bypasses RLS) and enforces
-- permissions itself. RLS below protects direct client access (defence in depth).
-- ---------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.products    enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
alter table public.vehicles    enable row level security;
alter table public.shipments   enable row level security;
alter table public.market_data enable row level security;

create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- profiles
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select using (id = auth.uid());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = public.current_role_name());  -- role cannot be self-changed

-- products: anyone signed-in can browse active listings; sellers manage their own
drop policy if exists products_select on public.products;
create policy products_select on public.products for select
  using (status = 'active' or seller_id = auth.uid());
drop policy if exists products_insert_own on public.products;
create policy products_insert_own on public.products for insert
  with check (seller_id = auth.uid() and public.current_role_name() in ('farmer','fpo'));
drop policy if exists products_update_own on public.products;
create policy products_update_own on public.products for update using (seller_id = auth.uid());
drop policy if exists products_delete_own on public.products;
create policy products_delete_own on public.products for delete using (seller_id = auth.uid());

-- orders: visible to buyer and seller (writes go through the API / RPC)
drop policy if exists orders_select_parties on public.orders;
create policy orders_select_parties on public.orders for select
  using (buyer_id = auth.uid() or seller_id = auth.uid());

drop policy if exists order_items_select_parties on public.order_items;
create policy order_items_select_parties on public.order_items for select
  using (exists (select 1 from public.orders o
                 where o.id = order_id and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())));

-- logistics
drop policy if exists vehicles_select on public.vehicles;
create policy vehicles_select on public.vehicles for select
  using (owner_id = auth.uid() or driver_id = auth.uid());
drop policy if exists shipments_select on public.shipments;
create policy shipments_select on public.shipments for select
  using (created_by = auth.uid() or driver_id = auth.uid());

-- market data: readable by any signed-in user
drop policy if exists market_data_select on public.market_data;
create policy market_data_select on public.market_data for select
  using (auth.uid() is not null);

-- ---------------------------------------------------------------------
-- market_daily: per-crop daily aggregate across all districts (used by AI endpoints)
-- ---------------------------------------------------------------------
create or replace view public.market_daily as
  select crop,
         date,
         sum(demand_kg)                         as demand_kg,
         round(avg(price_per_kg), 2)            as price_per_kg,
         round(avg(retail_price_per_kg), 2)     as retail_price_per_kg
    from public.market_data
   group by crop, date;
revoke all on public.market_daily from anon, authenticated;
grant select on public.market_daily to service_role;
