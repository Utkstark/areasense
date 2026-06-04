import type { Coordinates, LocalityId } from './primitives';

/**
 * Filter-independent cache key for the runtime commute cache.
 *
 * Two users at the same office with different filters share one cache entry;
 * filters apply downstream of the lookup. The key intentionally does NOT
 * include max_minutes, budget_inr, bhk, household, basis, or scoring toggles.
 * See product-spec §5 and tech-architecture §8.
 */
export interface CacheKey {
  /** Already rounded to CACHE_CONFIG.OFFICE_COORD_ROUND_METERS (100m). */
  office_coords_rounded: Coordinates;
  /** "HH:MM" 24-hour — e.g. "09:00". */
  outbound_time: string;
  /** "HH:MM" 24-hour — e.g. "18:00". */
  return_time: string;
}

/** One locality's leg-pair, Mon–Fri averaged at the keyed times. */
export interface CommuteMatrixEntry {
  locality_id: LocalityId;
  outbound_minutes: number;
  return_minutes: number;
}

/**
 * One row of the commute cache.
 *
 * Stored in Upstash Redis as JSON, one row per CacheKey. The cron snapshots
 * the full Redis state to /data/commute-cache.json weekly for audit + recovery.
 */
export interface CommuteCacheEntry {
  key: CacheKey;
  matrix: CommuteMatrixEntry[];
  /** ISO 8601. Set on write, refreshed by the cron after recompute. Drives staleness. */
  computed_at: string;
  /** ISO 8601. Touched on every read via get(). Drives prune. */
  last_accessed: string;
}