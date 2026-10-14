"""
Pickup-and-delivery route optimisation (Capacitated VRP with pairing constraints).

Every order has a PICKUP (farm / FPO collection point) and a DELIVERY (buyer).
We consolidate many orders onto few vehicles:
  * a pickup must happen before its delivery, on the same vehicle
  * vehicle load never exceeds capacity
  * each route is capped at `max_route_km`
  * orders that cannot fit anywhere are reported as `unassigned` instead of failing

Solver: Google OR-Tools routing (PARALLEL_CHEAPEST_INSERTION + GUIDED_LOCAL_SEARCH).
If OR-Tools is not installed the service transparently falls back to a greedy
cheapest-insertion heuristic, so the API keeps working (see `method` in the response).

Distances are haversine × `circuity` (road-network factor ≈ 1.35 for rural India).
Swap `build_distance_matrix` for the Mapbox Matrix / Google Distance Matrix API
to use real road distances.
"""
from __future__ import annotations

import math
from typing import Any

try:  # pragma: no cover - exercised only when ortools is installed
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2
    HAS_ORTOOLS = True
except Exception:  # noqa: BLE001
    HAS_ORTOOLS = False

EARTH_RADIUS_KM = 6371.0088
EMISSION_KG_PER_KM = 0.30  # rough figure for a small diesel commercial vehicle (estimate)


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------
def haversine_km(a: dict[str, float], b: dict[str, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a["lat"], a["lng"], b["lat"], b["lng"]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(h)))


def build_distance_matrix(nodes: list[dict[str, Any]], circuity: float) -> list[list[int]]:
    """Road-distance matrix in metres (integers, as OR-Tools requires)."""
    n = len(nodes)
    m = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            d = int(round(haversine_km(nodes[i], nodes[j]) * circuity * 1000))
            m[i][j] = m[j][i] = d
    return m


# ---------------------------------------------------------------------------
# solvers — both return a list of node-index sequences (one per vehicle, depot excluded)
# node 0 = depot; order i -> pickup node 1+2i, delivery node 2+2i
# ---------------------------------------------------------------------------
def _route_distance(seq: list[int], dist: list[list[int]]) -> int:
    if not seq:
        return 0
    path = [0, *seq, 0]
    return sum(dist[a][b] for a, b in zip(path, path[1:]))


def _feasible(seq: list[int], dist, demands: list[int], capacity: int, max_m: int) -> bool:
    load = 0
    for node in seq:
        load += demands[node]
        if load > capacity or load < 0:
            return False
    return _route_distance(seq, dist) <= max_m


def _solve_greedy(dist, demands, vehicles, orders, max_m) -> list[list[int]]:
    """Cheapest-insertion of pickup/delivery pairs (fallback when OR-Tools is unavailable)."""
    routes: list[list[int]] = [[] for _ in vehicles]
    # serve heavy orders first: they are the hardest to fit
    order_ids = sorted(range(len(orders)), key=lambda i: -orders[i]["weight_kg"])
    for i in order_ids:
        p, d = 1 + 2 * i, 2 + 2 * i
        best: tuple[float, int, list[int]] | None = None
        for v, veh in enumerate(vehicles):
            cap = int(veh["capacity_kg"])
            base = _route_distance(routes[v], dist)
            fixed = 0 if routes[v] else veh.get("fixed_cost", 0) * 1000  # discourages opening new vehicles
            for a in range(len(routes[v]) + 1):
                for b in range(a, len(routes[v]) + 1):
                    cand = routes[v][:a] + [p] + routes[v][a:b] + [d] + routes[v][b:]
                    if not _feasible(cand, dist, demands, cap, max_m):
                        continue
                    added = (_route_distance(cand, dist) - base) / 1000 * veh["cost_per_km"] * 1000 + fixed
                    if best is None or added < best[0]:
                        best = (added, v, cand)
        if best is not None:
            routes[best[1]] = best[2]
    return routes


def _solve_ortools(dist, demands, vehicles, orders, max_m, time_limit_s) -> list[list[int]]:  # pragma: no cover
    n_nodes, n_veh = len(dist), len(vehicles)
    manager = pywrapcp.RoutingIndexManager(n_nodes, n_veh, 0)
    routing = pywrapcp.RoutingModel(manager)

    def _dist_cb(from_index: int, to_index: int) -> int:
        return dist[manager.IndexToNode(from_index)][manager.IndexToNode(to_index)]

    dist_idx = routing.RegisterTransitCallback(_dist_cb)

    # objective = money: metres × ₹/km (kept integer by working in milli-rupees)
    for v, veh in enumerate(vehicles):
        rate = float(veh["cost_per_km"])

        def _cost_cb(from_index: int, to_index: int, rate: float = rate) -> int:
            return int(dist[manager.IndexToNode(from_index)][manager.IndexToNode(to_index)] * rate)

        routing.SetArcCostEvaluatorOfVehicle(routing.RegisterTransitCallback(_cost_cb), v)
        routing.SetFixedCostOfVehicle(int(float(veh.get("fixed_cost", 0)) * 1000), v)

    routing.AddDimension(dist_idx, 0, int(max_m), True, "Distance")
    distance_dim = routing.GetDimensionOrDie("Distance")

    def _demand_cb(from_index: int) -> int:
        return demands[manager.IndexToNode(from_index)]

    demand_idx = routing.RegisterUnaryTransitCallback(_demand_cb)
    routing.AddDimensionWithVehicleCapacity(
        demand_idx, 0, [int(v["capacity_kg"]) for v in vehicles], True, "Load"
    )

    penalty = 50_000_000  # ≈ ₹50,000 per dropped node: only dropped when truly infeasible
    for i in range(len(orders)):
        p_idx = manager.NodeToIndex(1 + 2 * i)
        d_idx = manager.NodeToIndex(2 + 2 * i)
        routing.AddPickupAndDelivery(p_idx, d_idx)
        solver = routing.solver()
        solver.Add(routing.VehicleVar(p_idx) == routing.VehicleVar(d_idx))
        solver.Add(distance_dim.CumulVar(p_idx) <= distance_dim.CumulVar(d_idx))
        solver.Add(routing.ActiveVar(p_idx) == routing.ActiveVar(d_idx))
        routing.AddDisjunction([p_idx], penalty)
        routing.AddDisjunction([d_idx], penalty)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromSeconds(int(time_limit_s))

    solution = routing.SolveWithParameters(params)
    if solution is None:
        return [[] for _ in vehicles]

    routes: list[list[int]] = []
    for v in range(n_veh):
        idx, seq = routing.Start(v), []
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if node != 0:
                seq.append(node)
            idx = solution.Value(routing.NextVar(idx))
        routes.append(seq)
    return routes


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def optimize_routes(payload: dict[str, Any]) -> dict[str, Any]:
    depot = payload["depot"]
    orders = list(payload["orders"])
    vehicles = list(payload["vehicles"])
    max_route_km = float(payload.get("max_route_km", 400))
    speed = float(payload.get("speed_kmph", 35))
    circuity = float(payload.get("circuity", 1.35))
    time_limit_s = int(payload.get("time_limit_s", 5))
    if not vehicles:
        raise ValueError("at least one vehicle is required")

    max_cap = max(v["capacity_kg"] for v in vehicles)
    too_heavy = [o for o in orders if o["weight_kg"] > max_cap]
    orders = [o for o in orders if o["weight_kg"] <= max_cap]

    unassigned: list[dict[str, Any]] = [
        {"order_id": o["id"], "reason": f"weight {o['weight_kg']:.0f} kg exceeds largest vehicle ({max_cap:.0f} kg)"}
        for o in too_heavy
    ]

    nodes: list[dict[str, Any]] = [{**depot, "name": depot.get("name", "Depot")}]
    demands = [0]
    for o in orders:
        w = int(math.ceil(o["weight_kg"]))
        nodes.append({**o["pickup"], "name": o["pickup"].get("name") or f"Pickup {o['id'][:6]}"})
        demands.append(w)
        nodes.append({**o["delivery"], "name": o["delivery"].get("name") or f"Drop {o['id'][:6]}"})
        demands.append(-w)

    dist = build_distance_matrix(nodes, circuity)
    max_m = int(max_route_km * 1000)

    method = "greedy-insertion"
    if orders:
        if HAS_ORTOOLS:
            try:
                seqs = _solve_ortools(dist, demands, vehicles, orders, max_m, time_limit_s)
                method = "ortools-cvrp-pdp"
            except Exception:  # noqa: BLE001 — never fail the request because of the solver
                seqs = _solve_greedy(dist, demands, vehicles, orders, max_m)
        else:
            seqs = _solve_greedy(dist, demands, vehicles, orders, max_m)
    else:
        seqs = [[] for _ in vehicles]

    served = {(n - 1) // 2 for seq in seqs for n in seq}
    for i, o in enumerate(orders):
        if i not in served:
            unassigned.append({"order_id": o["id"], "reason": "no vehicle could carry it within capacity and distance limits"})

    routes_out = []
    total_km = total_cost = 0.0
    for v, seq in enumerate(seqs):
        if not seq:
            continue
        veh = vehicles[v]
        path = [0, *seq, 0]
        stops, cum_km, load, peak, clock = [], 0.0, 0, 0, 0.0
        for a, b in zip(path, path[1:]):
            leg_km = dist[a][b] / 1000.0
            cum_km += leg_km
            clock += leg_km / speed * 60.0
            if b == 0:
                break
            load += demands[b]
            peak = max(peak, load)
            oi = (b - 1) // 2
            is_pickup = (b % 2 == 1)
            service = float(orders[oi].get("service_min", 10))
            clock += service
            stops.append({
                "seq": len(stops) + 1,
                "order_id": orders[oi]["id"],
                "label": orders[oi].get("label"),
                "type": "pickup" if is_pickup else "delivery",
                "name": nodes[b]["name"],
                "lat": nodes[b]["lat"],
                "lng": nodes[b]["lng"],
                "leg_km": round(leg_km, 2),
                "cumulative_km": round(cum_km, 2),
                "eta_min": round(clock, 0),
                "load_after_kg": load,
            })
        km = _route_distance(seq, dist) / 1000.0
        cost = km * veh["cost_per_km"] + float(veh.get("fixed_cost", 0))
        total_km += km
        total_cost += cost
        routes_out.append({
            "vehicle_id": veh["id"],
            "vehicle_name": veh.get("name"),
            "capacity_kg": veh["capacity_kg"],
            "distance_km": round(km, 2),
            "duration_min": round(clock, 0),
            "peak_load_kg": peak,
            "utilisation_pct": round(peak / veh["capacity_kg"] * 100, 1),
            "cost_inr": round(cost, 2),
            "order_ids": sorted({s["order_id"] for s in stops}),
            "stops": stops,
        })

    # Baseline: every order gets its own dedicated round trip depot → pickup → drop → depot
    baseline_km = 0.0
    for i, _ in enumerate(orders):
        p, d = 1 + 2 * i, 2 + 2 * i
        baseline_km += (dist[0][p] + dist[p][d] + dist[d][0]) / 1000.0
    served_baseline_km = sum(
        (dist[0][1 + 2 * i] + dist[1 + 2 * i][2 + 2 * i] + dist[2 + 2 * i][0]) / 1000.0
        for i in served
    )
    avg_rate = sum(v["cost_per_km"] for v in vehicles) / len(vehicles)
    baseline_cost = served_baseline_km * avg_rate
    saved_km = max(0.0, served_baseline_km - total_km)

    return {
        "method": method,
        "routes": routes_out,
        "unassigned": unassigned,
        "summary": {
            "orders_total": len(payload["orders"]),
            "orders_assigned": len(served),
            "orders_unassigned": len(unassigned),
            "vehicles_used": len(routes_out),
            "total_distance_km": round(total_km, 2),
            "total_cost_inr": round(total_cost, 2),
            "baseline_distance_km": round(served_baseline_km, 2),
            "baseline_cost_inr": round(baseline_cost, 2),
            "distance_saved_km": round(saved_km, 2),
            "distance_saved_pct": round(saved_km / served_baseline_km * 100, 1) if served_baseline_km else 0.0,
            "cost_saved_inr": round(max(0.0, baseline_cost - total_cost), 2),
            "co2_saved_kg_est": round(saved_km * EMISSION_KG_PER_KM, 1),
            "baseline_definition": "one dedicated round trip per order (depot → pickup → delivery → depot)",
        },
    }
