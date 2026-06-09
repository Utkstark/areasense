/**
 * Edge cases — relaxation re-filtering and tradeoff-point computation.
 *
 * Invoked by /lib/search-orchestrator.ts ONLY when the initial filter pass
 * (commute + budget) returns zero surviving localities. This module:
 *   1. Tries each relaxation step in order (product-spec §8.1) against the
 *      full commute-annotated locality set IN ISOLATION (not chained on
 *      prior step's survivors). Stops at the first step that yields
 *      survivors.
 *   2. If no step produces survivors, computes the two tradeoff data points
 *      (product-spec §8.2) for the empty-state UI.
 *
 * Out of scope for this module:
 *   - Live API calls (commutes are precomputed by the orchestrator)
 *   - Scoring (orchestrator scores survivors AFTER edge-cases returns)
 *   - Message formatting (frontend formats from typed TradeoffPoint payload)
 *   - Deciding when to invoke edge-cases (orchestrator's call)
 *
 * Note on step 3 (rating floor relaxation): per the current filter design,
 * rating is a SCORING dimension, not a filter constraint. Lowering its floor
 * does not produce new survivors at the filter level (filter is commute +
 * budget only). We retain step 3 in the ladder for spec fidelity (§8.1);
 * mechanically it falls through to the tradeoff branch below. If a future
 * filter-design change introduces rating-based exclusion, the implementation
 * plugs in at the marked location.
 */

import type {
  SearchInput,
  LocalityRecord,
  CommuteResult,
  RelaxationApplied,
  TradeoffPoint,
  BHK,
} from '@/types';
import { SCORING_CONFIG } from '@/types';
import { passesCommuteFilter, computeBudgetFit } from './filters';

// ============================================================================
// Public input / output shapes
// ============================================================================

/**
 * A locality coupled with its already-computed commute data. The orchestrator
 * computes commutes once (the expensive step) before invoking edge-cases.
 *
 * `commutes` is an array for forward-compat with dual-office (v1); v0 length
 * is always 1. Matches LocalityResult.commutes downstream so the orchestrator
 * needn't reshape on success.
 */
export interface AnnotatedLocality {
  locality: LocalityRecord;
  commutes: CommuteResult[];
}

/**
 * Discriminated outcome — forces the orchestrator to handle both branches
 * explicitly. 'relaxed' carries the survivors and what we relaxed; 'empty'
 * carries the tradeoff guidance for the empty-state UI.
 */
export type EdgeCaseResult =
  | {
      kind: 'relaxed';
      survivors: AnnotatedLocality[];
      relaxation_applied: RelaxationApplied;
    }
  | {
      kind: 'empty';
      tradeoff_points: TradeoffPoint[];
    };

// ============================================================================
// Entry point
// ============================================================================

/**
 * Tries each relaxation step in order against the annotated locality set.
 * Returns 'relaxed' on the first step that yields survivors; otherwise
 * computes tradeoff points and returns 'empty'.
 */
export function runEdgeCases(
  input: SearchInput,
  annotated: AnnotatedLocality[],
): EdgeCaseResult {
  // `max_minutes` IS total-daily directly (basis simplification per
  // product-spec §4.2 — no avg_one_way/total_daily toggle in v0).
  const userMaxTotalDaily = input.commute.max_minutes;

  // --- Step 1: budget + 20%, original commute ---
  const relaxedBudget = Math.round(
    input.budget_inr * (1 + SCORING_CONFIG.BUDGET_RELAX_PCT),
  );
  const step1 = filterPass(annotated, {
    maxCommuteTotalDaily: userMaxTotalDaily,
    budget: relaxedBudget,
    bhk: input.bhk,
  });
  if (step1.length > 0) {
    return {
      kind: 'relaxed',
      survivors: step1,
      relaxation_applied: {
        budget_relaxed_by_pct: SCORING_CONFIG.BUDGET_RELAX_PCT,
      },
    };
  }

  // --- Step 2: original budget, commute + 15 min ---
  const relaxedCommute =
    userMaxTotalDaily + SCORING_CONFIG.COMMUTE_RELAX_MINUTES;
  const step2 = filterPass(annotated, {
    maxCommuteTotalDaily: relaxedCommute,
    budget: input.budget_inr,
    bhk: input.bhk,
  });
  if (step2.length > 0) {
    return {
      kind: 'relaxed',
      survivors: step2,
      relaxation_applied: {
        commute_relaxed_by_minutes: SCORING_CONFIG.COMMUTE_RELAX_MINUTES,
      },
    };
  }

  // --- Step 3: rating floor relaxation ---
  // No-op under current filter design. Rating is a SCORING dimension only —
  // not part of the filter pass. Lowering RATING_FLOOR does not change which
  // localities pass (commute + budget) filtering. Step retained per spec §8.1
  // but performs no work here; control falls through to the tradeoff branch.
  //
  // FUTURE PLUG-IN POINT: if a filter-design change introduces rating-based
  // exclusion (e.g., "locality needs ≥ N societies with rating ≥ floor"), the
  // implementation goes here:
  //   - read input.scoring_toggles?.rating to gate the step
  //   - re-filter with SCORING_CONFIG.RATING_FLOOR_RELAXED_TO
  //   - populate relaxation_applied.rating_floor_lowered_to
  // No other module needs to change.

  // --- All relaxation exhausted: tradeoff guidance ---
  return {
    kind: 'empty',
    tradeoff_points: computeTradeoffPoints(input, annotated, userMaxTotalDaily),
  };
}

// ============================================================================
// Helpers
// ============================================================================

interface FilterThresholds {
  maxCommuteTotalDaily: number;
  budget: number;
  bhk: BHK;
}

/**
 * Re-runs the commute + budget filter with the given thresholds. Reuses
 * passesCommuteFilter and computeBudgetFit from /lib/filters.ts — does NOT
 * reimplement filter logic. The 15% commute buffer is applied internally by
 * passesCommuteFilter; we pass the raw (possibly relaxed) max here.
 */
function filterPass(
  annotated: AnnotatedLocality[],
  thresholds: FilterThresholds,
): AnnotatedLocality[] {
  return annotated.filter((entry) => {
    const totalDaily = entry.commutes[0]?.total_minutes;
    if (totalDaily === undefined) return false;

    if (!passesCommuteFilter(totalDaily, thresholds.maxCommuteTotalDaily)) {
      return false;
    }

    const fit = computeBudgetFit(
      entry.locality,
      thresholds.budget,
      thresholds.bhk,
    );
    if (!fit || !fit.in_range) return false;

    return true;
  });
}

// ----------------------------------------------------------------------------
// Tradeoff points (product-spec §8.2)
// ----------------------------------------------------------------------------

/**
 * When all relaxation fails, surface two data points so the user can see the
 * shape of their tradeoff:
 *
 *   cheapest_at_commute — drop commute; among localities in budget, the one
 *                         with the SHORTEST total commute.
 *   closest_at_budget   — drop budget; among localities in commute, the one
 *                         with the LOWEST base-rent low for the selected BHK.
 *
 * Stable order: [cheapest_at_commute, closest_at_budget]. Absent ones are
 * omitted (not nulled), so array length tells the frontend how many to
 * render. Either can be absent if no locality satisfies the inverse
 * constraint, or — for closest_at_budget — if no in-commute locality has
 * data for the selected BHK.
 */
function computeTradeoffPoints(
  input: SearchInput,
  annotated: AnnotatedLocality[],
  userMaxTotalDaily: number,
): TradeoffPoint[] {
  const points: TradeoffPoint[] = [];

  // --- cheapest_at_commute: in budget (ignoring commute), shortest commute ---
  const inBudget = annotated.filter((entry) => {
    const fit = computeBudgetFit(entry.locality, input.budget_inr, input.bhk);
    return fit?.in_range === true;
  });
  if (inBudget.length > 0) {
    const cheapest = pickMinBy(inBudget, (entry) => {
      const minutes = entry.commutes[0]?.total_minutes;
      return minutes === undefined ? Infinity : minutes;
    });
    const cheapestMinutes = cheapest.commutes[0]?.total_minutes;
    if (cheapestMinutes !== undefined) {
      points.push({
        type: 'cheapest_at_commute',
        locality_id: cheapest.locality.id,
        locality_name: cheapest.locality.name,
        commute_minutes: cheapestMinutes,
      });
    }
  }

  // --- closest_at_budget: in commute (ignoring budget), lowest BHK low ---
  // Skip localities lacking data for the selected BHK — we can't sort by rent
  // without a value, and reporting "lowest rent: undefined" isn't honest.
  const inCommuteWithRent = annotated.flatMap((entry) => {
    const totalDaily = entry.commutes[0]?.total_minutes;
    if (totalDaily === undefined) return [];
    if (!passesCommuteFilter(totalDaily, userMaxTotalDaily)) return [];

    const range = entry.locality.rent_ranges[input.bhk];
    if (!range) return [];
    return [{ entry, lowRent: range[0] }];
  });
  if (inCommuteWithRent.length > 0) {
    const closest = pickMinBy(inCommuteWithRent, (x) => x.lowRent);
    points.push({
      type: 'closest_at_budget',
      locality_id: closest.entry.locality.id,
      locality_name: closest.entry.locality.name,
      rent_inr: closest.lowRent,
    });
  }

  return points;
}

/**
 * Generic "argmin by key" — returns the element with the smallest key.
 * Computes each key once; cleaner than reduce-with-recomputing-comparator.
 *
 * Precondition: arr is non-empty (callers check before invoking).
 */
function pickMinBy<T>(arr: T[], key: (item: T) => number): T {
  // Non-null assertions safe by precondition; arr.length > 0 at all call sites.
  let best = arr[0]!;
  let bestKey = key(best);
  for (let i = 1; i < arr.length; i++) {
    const item = arr[i]!;
    const k = key(item);
    if (k < bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}