// Config constants — every magic number in one place.
// Source of truth: data-model.md §9. Each value traces back to a
// product-spec section in the inline comment.
//
// `as const` turns these into literal types (0.15, not number) so the
// compiler catches accidental reassignment, and preserves tuples as
// named-position rather than degenerating to number[].

import type { TimeOfDay } from './primitives';

export const SCORING_CONFIG = {
  // === Rating filter — product-spec §6.1, §6.3 ===
  // Used both as floor filter AND in rating_score numerator.
  // Both this AND the user toggle gate rating.
  RATING_FLOOR:             3.8,
  RATING_MIN_REVIEWS:       10,
  MIN_QUALIFYING_SOCIETIES: 4,    // rating dimension drops out below this

  // === Metro proximity — product-spec §6.1 ===
  // 2 km = ~25 min walk. Past this, treat metro as a non-amenity.
  METRO_D_MAX_METERS: 2000,

  // === Commute buffer — product-spec §6.1 ===
  // 15% — applied to BOTH filter and score.
  // Filter passes if actual ≤ max × 1.15. Score uses buffered_max in denominator,
  // so a locality at exactly the user's stated max scores positive (not zero).
  COMMUTE_BUFFER: 0.15,

  // === Default weights when dimension is active — product-spec §6.2 ===
  DEFAULT_WEIGHTS: {
    commute: 0.50,
    metro:   0.20,
    rating:  0.30,
  },

  // === Edge-case relaxation — product-spec §8.1 ===
  RELAXATION_ORDER:        ['budget', 'commute', 'rating'] as const,
  BUDGET_RELAX_PCT:        0.20,    // budget × 1.20 on first relax step
  COMMUTE_RELAX_MINUTES:   15,      // max + 15 (on top of the 15% buffer)
  RATING_FLOOR_RELAXED_TO: 3.5,     // rating floor dropped on third relax step
} as const;

export const PIPELINE_CONFIG = {
  // Upper trim tightened from 95 to 90 because the Indian rental market is
  // upper-skewed by ultra-luxury / serviced apartments. Empirically reduces
  // median drag without losing useful signal. (data-model.md §7, product-spec §10.3)
  OUTLIER_TRIM_PERCENTILES:        [5, 90]  as const,
  RENT_RANGE_PERCENTILES:          [25, 75] as const,
  MIN_SAMPLE_SIZE:                 5,
  MIN_LISTINGS_FOR_SOCIETY_SIGNAL: 3,
} as const;

export const INPUT_LIMITS = {
  MAX_COMMUTE_MINUTES: { min: 10,   max: 180 },
  // Min ₹3,000: below this there is effectively no Indian rental market.
  // Still permissive enough for shared-PG / hostel-style queries.
  // (product-spec §4.2)
  BUDGET_INR:          { min: 3000, max: 1_000_000 },
} as const;

export const DEFAULT_TIME_OF_DAY: TimeOfDay = {
  out:    '09:00',
  return: '18:00',
};