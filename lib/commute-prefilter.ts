/**
 * /lib/commute-prefilter.ts
 *
 * Cheap haversine-based prefilter for the cold-start commute computation.
 * Drops localities that cannot possibly fit within ANY user's max-commute
 * (using the system-wide ceiling, INPUT_LIMITS.MAX_COMMUTE_MINUTES.max) —
 * preserving the cache invariant from tech-arch §6:
 *   "matrix is the same for every user at this (office, times) tuple,
 *    regardless of their filters."
 *
 * The prefilter uses optimistic parameters at every step so it only drops
 * localities the actual commute filter would also drop:
 *
 *   straight_line_km          = haversine(office, locality.centroid)
 *   road_km_optimistic        = straight_line_km × URBAN_CIRCUITY_FACTOR
 *   one_way_min_optimistic    = (road_km_optimistic / OPTIMISTIC_URBAN_SPEED_KMH) × 60
 *   total_daily_min_optimistic = one_way_min_optimistic × 2
 *
 * Inverting the formula: any locality whose haversine distance exceeds
 * MAX_PREFILTER_RADIUS_KM cannot fit even the most permissive user.
 *
 * Called from /lib/search-orchestrator.ts only on cold-start. Cache hits
 * read the matrix that was computed at the prefilter ceiling — already
 * bounded.
 */

import type { Coordinates, LocalityRecord } from '@/types';
import { INPUT_LIMITS, SCORING_CONFIG } from '@/types';

// ─── Tuning constants ───────────────────────────────────────────────────
// Infra knobs (not product-spec values). Adjust empirically as needed.

/** Urban road circuity factor — real road distance ÷ straight-line distance.
 *  1.5 is the upper end of typical urban grids; chosen high so the prefilter
 *  errs on the side of inclusion. */
const URBAN_CIRCUITY_FACTOR = 1.5;

/** Optimistic urban driving speed during rush hour (km/h). Chosen high so
 *  the prefilter is conservative about exclusion — only drops localities
 *  that can't fit even under unrealistically favorable traffic. */
const OPTIMISTIC_URBAN_SPEED_KMH = 25;

/** Earth's mean radius (km). Standard haversine constant. */
const EARTH_RADIUS_KM = 6371;

// ─── Derived ceiling radius (computed once at module load) ──────────────

/**
 * Maximum haversine distance (km) at which a locality could possibly fit
 * within the system-wide ceiling max-commute. Derivation:
 *
 *   max_total_daily    = INPUT_LIMITS.MAX_COMMUTE_MINUTES.max
 *   buffered_max       = max_total_daily × (1 + COMMUTE_BUFFER)
 *   one_way_budget     = buffered_max / 2
 *   road_budget_km     = (one_way_budget / 60) × OPTIMISTIC_URBAN_SPEED_KMH
 *   straight_budget_km = road_budget_km / URBAN_CIRCUITY_FACTOR
 *
 * At ceiling=150 with COMMUTE_BUFFER=0.15: ~23.96 km.
 */
export const MAX_PREFILTER_RADIUS_KM = (() => {
  const maxTotalDaily = INPUT_LIMITS.MAX_COMMUTE_MINUTES.max;
  const bufferedMax = maxTotalDaily * (1 + SCORING_CONFIG.COMMUTE_BUFFER);
  const oneWayBudget = bufferedMax / 2;
  const roadBudgetKm = (oneWayBudget / 60) * OPTIMISTIC_URBAN_SPEED_KMH;
  return roadBudgetKm / URBAN_CIRCUITY_FACTOR;
})();

// ─── Haversine math ─────────────────────────────────────────────────────

/**
 * Great-circle distance in km between two lat/lng points on Earth.
 * Standard haversine formula; accurate to within ~0.5% over distances
 * relevant to AreaSense (intra-NCR < few hundred km).
 */
function haversineKm(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ─── Public entry point ─────────────────────────────────────────────────

/**
 * Prefilter a locality set by physical feasibility — drop localities whose
 * straight-line distance from the office exceeds MAX_PREFILTER_RADIUS_KM.
 *
 * Uses the SYSTEM-WIDE ceiling, not the requesting user's max_minutes, so
 * the resulting set is the same for every user at this office. This is
 * what lets the commute cache stay filter-independent (tech-arch §6).
 *
 * Returns a new array — does not mutate input.
 */
export function prefilterByCommuteFeasibility(
  officeCoords: Coordinates,
  localities: LocalityRecord[],
): LocalityRecord[] {
  return localities.filter(
    (loc) =>
      haversineKm(officeCoords, loc.centroid) <= MAX_PREFILTER_RADIUS_KM,
  );
}