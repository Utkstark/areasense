/**
 * Scoring — pure functions implementing product-spec §6.
 *
 * Every threshold is read from SCORING_CONFIG. No magic numbers inline.
 * Math is the §6.1 formulas verbatim; the four §6.4 worked examples
 * (Locality A, B, C, and the metro-off variant) reproduce exactly.
 *
 * This module has no I/O, no React imports, no Next.js imports.
 * Basis conversion (avg_one_way → total_daily) and toggle-default
 * resolution happen UPSTREAM in the orchestrator — by the time we
 * get here, maxCommuteTotalDaily is already total-daily and toggles
 * are already concrete booleans.
 */

import type {
  ActiveWeights,
  CommuteResult,
  LocalityRecord,
  LocalityScore,
  RatingDroppedReason,
  Society,
  SubScores,
} from '@/types';
import { SCORING_CONFIG } from '@/types';

// ============================================================================
// Public types
// ============================================================================

export interface ScoreParams {
  /** User's max commute, already converted to total-daily minutes upstream. */
  maxCommuteTotalDaily: number;
  /** User toggles, already resolved against defaults upstream. */
  toggles: { metro: boolean; rating: boolean };
}

/** A Society that has rating_data populated — produced by qualifyingSocieties. */
type RatedSociety = Society & { rating_data: NonNullable<Society['rating_data']> };

// ============================================================================
// Shared helper — same buffered_max used by BOTH the commute filter and
// the commute sub-score. filters.ts imports this so the two can't drift.
// ============================================================================

/** product-spec §6.1: buffered_max = max × (1 + COMMUTE_BUFFER). */
export function bufferedCommuteMax(maxTotalDailyMinutes: number): number {
  return maxTotalDailyMinutes * (1 + SCORING_CONFIG.COMMUTE_BUFFER);
}

// ============================================================================
// Sub-scores — each pure, each independently checkable against §6.4
// ============================================================================

/**
 * Commute sub-score. product-spec §6.1.
 *   commute_score = max(0, (buffered_max − actual) / buffered_max)
 *
 * At actual = stated max:        score = COMMUTE_BUFFER / (1+COMMUTE_BUFFER) ≈ 0.13
 * At actual = buffered_max:      score = 0
 * At actual > buffered_max:      excluded upstream; this returns 0 defensively.
 */
export function computeCommuteScore(
  actualTotalDailyMinutes: number,
  maxTotalDailyMinutes: number,
): number {
  const bufferedMax = bufferedCommuteMax(maxTotalDailyMinutes);
  if (bufferedMax <= 0) return 0; // input validation upstream prevents this; safe fallback
  const raw = (bufferedMax - actualTotalDailyMinutes) / bufferedMax;
  return clamp01(raw);
}

/**
 * Metro proximity sub-score. product-spec §6.1.
 *   metro_score = clamp(1 − distance / D_MAX, 0, 1)
 *
 * Distance in the data is km; SCORING_CONFIG.METRO_D_MAX_METERS is meters.
 * Conversion done here in one place.
 */
export function computeMetroScore(locality: LocalityRecord): number {
  const nearest = locality.nearest_metros[0];
  // data-model promises ≥ 1 metro entry per locality; defensive fallback only.
  if (!nearest) return 0;
  const distanceMeters = nearest.distance_km * 1000;
  const raw = 1 - distanceMeters / SCORING_CONFIG.METRO_D_MAX_METERS;
  return clamp01(raw);
}

/**
 * Rating-margin sub-score. product-spec §6.1.
 *   rating_score = (avg_rating_of_qualifying_societies − RATING_FLOOR)
 *                  / (5.0 − RATING_FLOOR)
 *
 * "Qualifying" = rating_data present AND score ≥ RATING_FLOOR AND
 *                review_count ≥ RATING_MIN_REVIEWS.
 *
 * Caller is expected to have already confirmed rating is active for this
 * locality (≥ MIN_QUALIFYING_SOCIETIES). Returns 0 if called with no
 * qualifying societies — defensive only; shouldn't happen in normal flow.
 */
export function computeRatingScore(locality: LocalityRecord): number {
  const qualifying = qualifyingSocieties(locality);
  if (qualifying.length === 0) return 0;
  const sum = qualifying.reduce((acc, s) => acc + s.rating_data.score, 0);
  const avg = sum / qualifying.length;
  const raw =
    (avg - SCORING_CONFIG.RATING_FLOOR) / (5.0 - SCORING_CONFIG.RATING_FLOOR);
  return clamp01(raw);
}

// ============================================================================
// Top-level — score one locality
// ============================================================================

/**
 * Compute the full LocalityScore for one locality + commute pair.
 *
 * Commute is always active. Metro is active iff toggles.metro. Rating is
 * active iff toggles.rating AND the locality has ≥ MIN_QUALIFYING_SOCIETIES.
 *
 * rating_dropped_reason is:
 *   - null when rating IS in the blend (explicit, per data-model §8)
 *   - 'toggled_off' when toggles.rating === false (takes precedence even if
 *     the locality also lacks qualifying societies — user opted out, so we
 *     don't surface the data-quality reason they didn't ask about)
 *   - 'insufficient_societies' when toggles.rating === true but the gate fails
 */
export function computeLocalityScore(
  locality: LocalityRecord,
  commute: CommuteResult,
  params: ScoreParams,
): LocalityScore {
  const { maxCommuteTotalDaily, toggles } = params;
  const W = SCORING_CONFIG.DEFAULT_WEIGHTS;

  // --- Commute (always active) ---
  const commuteScore = computeCommuteScore(
    commute.total_minutes,
    maxCommuteTotalDaily,
  );

  // --- Metro (gated by toggle only — distance gates the value, not activity) ---
  const metroActive = toggles.metro;
  const metroScore = metroActive ? computeMetroScore(locality) : undefined;

  // --- Rating (gated by BOTH toggle AND sample size) ---
  const qualifyingCount = qualifyingSocieties(locality).length;
  const hasEnoughSocieties =
    qualifyingCount >= SCORING_CONFIG.MIN_QUALIFYING_SOCIETIES;
  const ratingActive = toggles.rating && hasEnoughSocieties;
  const ratingScore = ratingActive ? computeRatingScore(locality) : undefined;

  // Precedence: toggled_off wins over insufficient_societies.
  let ratingDroppedReason: RatingDroppedReason | null;
  if (ratingActive) {
    ratingDroppedReason = null;
  } else if (!toggles.rating) {
    ratingDroppedReason = 'toggled_off';
  } else {
    ratingDroppedReason = 'insufficient_societies';
  }

  // --- Build sub_scores and active_weights, keyed identically ---
  const sub_scores: SubScores = { commute: commuteScore };
  const active_weights: ActiveWeights = { commute: W.commute };
  if (metroActive && metroScore !== undefined) {
    sub_scores.metro = metroScore;
    active_weights.metro = W.metro;
  }
  if (ratingActive && ratingScore !== undefined) {
    sub_scores.rating = ratingScore;
    active_weights.rating = W.rating;
  }

  const final_score = blend(sub_scores, active_weights);

  return {
    sub_scores,
    active_weights,
    final_score,
    rating_dropped_reason: ratingDroppedReason,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Societies passing the floor + min-reviews gates, with rating_data narrowed. */
function qualifyingSocieties(locality: LocalityRecord): RatedSociety[] {
  return locality.societies.filter((s): s is RatedSociety => {
    const r = s.rating_data;
    return (
      r !== undefined &&
      r.score >= SCORING_CONFIG.RATING_FLOOR &&
      r.review_count >= SCORING_CONFIG.RATING_MIN_REVIEWS
    );
  });
}

/**
 * Weighted blend, normalized by the sum of ACTIVE weights so final_score
 * stays in [0, 1] regardless of how many dimensions are active.
 * product-spec §6.2.
 */
function blend(subScores: SubScores, activeWeights: ActiveWeights): number {
  let weighted = activeWeights.commute * subScores.commute;
  let totalWeight = activeWeights.commute;

  if (activeWeights.metro !== undefined && subScores.metro !== undefined) {
    weighted += activeWeights.metro * subScores.metro;
    totalWeight += activeWeights.metro;
  }
  if (activeWeights.rating !== undefined && subScores.rating !== undefined) {
    weighted += activeWeights.rating * subScores.rating;
    totalWeight += activeWeights.rating;
  }

  return totalWeight > 0 ? weighted / totalWeight : 0;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}