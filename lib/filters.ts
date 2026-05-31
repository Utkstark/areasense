/**
 * Filters — pure functions for the commute and budget filter passes.
 *
 * Lives between commute computation (distance-matrix.ts) and scoring
 * (scoring.ts) in the pipeline (product-spec §3): filter first, rank survivors.
 *
 * No I/O, no React, no orchestration. The orchestrator loops over localities
 * and calls these per-locality.
 *
 * The 15% buffer formula is intentionally NOT redefined here — it's imported
 * from scoring.ts so the commute filter and the commute sub-score share
 * exactly one source of truth for buffered_max.
 */

import type {
  BHK,
  BudgetAnnotation,
  BudgetFit,
  LocalityRecord,
} from '@/types';
import { bufferedCommuteMax } from './scoring';

// ============================================================================
// Commute filter
// ============================================================================

/**
 * product-spec §3 + §6.1: a locality passes if its actual total-daily commute
 * is within the buffered max (max × 1.15).
 *
 * Caller passes basis-converted total-daily values (orchestrator's job).
 */
export function passesCommuteFilter(
  actualTotalDailyMinutes: number,
  maxCommuteTotalDaily: number,
): boolean {
  return actualTotalDailyMinutes <= bufferedCommuteMax(maxCommuteTotalDaily);
}

/**
 * product-spec §6.1: a commute is in the buffer zone when it's STRICTLY over
 * the user's stated max but within the 15% buffer. The UI flags these rows
 * ("~N min over your stated max") so soft-edge results are visible as such.
 *
 *   actual = max         → not in buffer zone (user said they'd tolerate max)
 *   actual = max + 1     → in buffer zone
 *   actual = buffered_max → in buffer zone (last point that still passes)
 *   actual > buffered_max → excluded by passesCommuteFilter
 */
export function isInBufferZone(
  actualTotalDailyMinutes: number,
  maxCommuteTotalDaily: number,
): boolean {
  const bufferedMax = bufferedCommuteMax(maxCommuteTotalDaily);
  return (
    actualTotalDailyMinutes > maxCommuteTotalDaily &&
    actualTotalDailyMinutes <= bufferedMax
  );
}

// ============================================================================
// Budget fit (filter decision + annotation, one pass)
// ============================================================================

/**
 * product-spec §4.3: compute where the user's budget falls within a locality's
 * BHK rent range. Produces both the filter decision (`in_range`) and the
 * display annotation in a single computation.
 *
 * Returns null when the locality has no rent data for the selected BHK
 * (data-model §5: absence of a BHK key means "not enough data"). The
 * orchestrator treats null as filter-fail and excludes the locality.
 *
 * Budget passed here is always the user's ORIGINAL budget, even during
 * edge-case relaxation (§8.1). The relaxation flag is shown separately so
 * users always see where their actual budget sits.
 *
 * Bands per §4.3:
 *   budget < low          → below_range,  in_range=false (excluded)
 *   0 ≤ position < 0.5    → lower_part
 *   0.5 ≤ position ≤ 1.0  → most_options
 *   position > 1.0        → full_range
 *
 * Edge case: tight rent band (low === high). The standard formula would
 * divide by zero. Handled by direct comparison —
 *   below the point  → below_range
 *   at-or-above      → full_range (the entire "range" is one point you can afford)
 */
export function computeBudgetFit(
  locality: LocalityRecord,
  budgetInr: number,
  bhk: BHK,
): BudgetFit | null {
  const range = locality.rent_ranges[bhk];
  if (!range) return null;

  const [low, high] = range;

  // --- Below the range: excluded ---
  if (budgetInr < low) {
    // Position is negative per §4.3. For tight ranges (high===low) the formula
    // would divide by zero, so use a sentinel; only the sign matters for display.
    const position = high > low ? (budgetInr - low) / (high - low) : -1;
    return { in_range: false, position, annotation: 'below_range' };
  }

  // --- In range, tight band (single rent point) ---
  if (high === low) {
    return { in_range: true, position: 1.0, annotation: 'full_range' };
  }

  // --- Normal in-range case ---
  const position = (budgetInr - low) / (high - low);

  let annotation: BudgetAnnotation;
  if (position > 1.0) {
    annotation = 'full_range';
  } else if (position >= 0.5) {
    annotation = 'most_options';
  } else {
    annotation = 'lower_part';
  }

  return { in_range: true, position, annotation };
}