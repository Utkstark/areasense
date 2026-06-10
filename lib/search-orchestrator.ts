/**
 * /lib/search-orchestrator.ts
 *
 * Single entry point composing all /lib modules into one search() function.
 * Called from /app/api/search/route.ts after Zod validation.
 *
 * Lifecycle per request:
 *   1. Round office coords, build cache key
 *   2. Fire isochrone in parallel with cache lookup (independent of cache state)
 *   3. On cache miss: compute live (~10s), write to Redis, set cold_start=true
 *   4. Annotate every loaded locality with its commute
 *   5. Filter (commute w/ buffer → budget)
 *   6. If zero survivors: runEdgeCases (relaxation OR tradeoff points)
 *   7. Score, sort by final_score desc
 *   8. Per-locality: household-filter, build deep-links
 *   9. Resolve isochrone (degrade-on-fail), assemble SearchResult
 *
 * Error contract:
 *   - DistanceMatrixError: cold-start compute failed → route handler maps to 503
 *   - CacheUnavailableError: Redis read failed → route handler maps to 503
 *   - Isochrone failure: caught at promise creation, field omitted from response (still 200)
 *   - Cache write failure post-compute: swallowed, data still returned
 *   - Other errors: bubble to route handler as 500
 */

import type {
  CacheKey,
  CommuteMatrixEntry,
  CommuteResult,
  LocalityRecord,
  LocalityResult,
  MatchedSociety,
  RelaxationApplied,
  SearchInput,
  SearchResult,
  TradeoffPoint,
} from '@/types';
import { DEFAULT_TIME_OF_DAY } from '@/types';

import {
  get as cacheGet,
  set as cacheSet,
  roundOfficeCoords,
} from '@/lib/commute-cache';
import { computeCommuteMatrix } from '@/lib/commute-compute';
import { runEdgeCases } from '@/lib/edge-cases';
import {
  computeBudgetFit,
  isInBufferZone,
  passesCommuteFilter,
} from '@/lib/filters';
import {
  buildLocalityDeeplinks,
  buildSocietyDeeplinks,
} from '@/lib/deeplinks';
import { passesHouseholdFilter } from '@/lib/household-filter';
import { getIsochrone } from '@/lib/isochrone';
import { computeLocalityScore } from '@/lib/scoring';

import gurgaonLocalitiesRaw from '@/data/locality-data-gurgaon.json';
import delhiLocalitiesRaw from '@/data/locality-data-delhi.json';

// ─────────────────────────────────────────────────────────────────────────
// Custom error classes — let the route handler map to specific HTTP statuses
// without inspecting message strings. See module header for status mapping.
// ─────────────────────────────────────────────────────────────────────────

export class DistanceMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistanceMatrixError';
  }
}

export class CacheUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheUnavailableError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Locality data — committed JSON, imported once at module load. Per
// tech-architecture §3, these are inlined into the bundle (~100KB total).
//
// City scoping: we load BOTH cities and let the commute filter naturally
// exclude unreachable localities. City is a locality ATTRIBUTE (where it
// sits), NOT a search constraint — a Gurgaon office may well match Delhi
// localities like Mahipalpur / Vasant Kunj / Dwarka. See data-model.md §3.
// ─────────────────────────────────────────────────────────────────────────

const ALL_LOCALITIES: LocalityRecord[] = [
  ...(gurgaonLocalitiesRaw as unknown as LocalityRecord[]),
  ...(delhiLocalitiesRaw as unknown as LocalityRecord[]),
];

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

/** Apply spec defaults to optional scoring_toggles (data-model §4). */
function resolveToggles(
  input: SearchInput,
): { metro: boolean; rating: boolean } {
  return {
    metro: input.scoring_toggles?.metro ?? true,
    rating: input.scoring_toggles?.rating ?? false,
  };
}

/** Build a CommuteResult from a raw matrix entry. */
function buildCommuteResult(
  entry: CommuteMatrixEntry,
  maxTotalDaily: number,
): CommuteResult {
  const total = entry.outbound_minutes + entry.return_minutes;
  return {
    office_index: 0,
    outbound_minutes: entry.outbound_minutes,
    return_minutes: entry.return_minutes,
    total_minutes: total,
    in_buffer_zone: isInBufferZone(total, maxTotalDaily),
  };
}

type AnnotatedLocality = {
  locality: LocalityRecord;
  commutes: CommuteResult[];
};

// ─────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────

export async function search(input: SearchInput): Promise<SearchResult> {
  // v0: single office. Zod enforces .length === 1 at the route boundary;
  // this guard is defense-in-depth for non-route callers (CLI, tests).
  const office = input.offices[0];
  if (!office) {
    throw new Error('search: input.offices is empty');
  }

  const outboundTime =
    input.commute.time_of_day?.out ?? DEFAULT_TIME_OF_DAY.out;
  const returnTime =
    input.commute.time_of_day?.return ?? DEFAULT_TIME_OF_DAY.return;
  // `max_minutes` is total-daily directly (basis simplification per
  // product-spec §4.2 — no avg_one_way/total_daily toggle in v0).
  const maxTotalDaily = input.commute.max_minutes;

  const cacheKey: CacheKey = {
    office_coords_rounded: roundOfficeCoords(office.coordinates),
    outbound_time: outboundTime,
    return_time: returnTime,
  };

  // ─── Step 1+2: fire isochrone in parallel with cache lookup ───
  //
  // Isochrone depends only on (office_coords, max_minutes) — independent of
  // cache state. Launching it now overlaps its ~1-2s with whatever the cache
  // lookup + cold-start compute end up taking. We deliberately do NOT use
  // Promise.all — isochrone failure must degrade (omit field), not abort.
  //
  // The `.catch()` attached HERE (at creation, not at the eventual await) is
  // critical: it guarantees the rejection is handled regardless of what the
  // orchestrator does later. If `cacheGet` throws (Redis down) and we exit
  // before step 8's await, the catch still fires when Mapbox eventually
  // rejects — no unhandled rejection. Without this, simultaneous Redis +
  // Mapbox failure would bubble as `unhandledRejection` and crash the lambda.
  // Mapbox Isochrone is one-way ("places reachable in N min FROM origin"),
  // but maxTotalDaily is morning + evening combined. Halve to approximate
  // the one-way budget that the polygon should visualize. Decorative only —
  // the actual ranked list comes from the full both-legs Distance Matrix
  // computation below. See product-spec.md §5, tech-architecture.md §6.
  const isochronePromise = getIsochrone(
    office.coordinates,
    Math.floor(maxTotalDaily / 2),
    'driving',
  ).catch((err: unknown) => {
    console.error('isochrone failed; degrading (response omits field)', err);
    return null;
  });

  let cacheEntry;
  try {
    cacheEntry = await cacheGet(cacheKey);
  } catch (err) {
    throw new CacheUnavailableError(
      `commute cache read failed: ${(err as Error).message ?? 'unknown'}`,
    );
  }

  let matrix: CommuteMatrixEntry[];
  let coldStart: boolean;

  if (cacheEntry) {
    matrix = cacheEntry.matrix;
    coldStart = false;
  } else {
    // ─── Step 3: cold-start path ───
    //
    // Synchronous live compute (~10s). UI shows the cold-start loading copy
    // from product-spec §5 while this resolves. No streaming, no placeholder.
    coldStart = true;
    let result;
    try {
      result = await computeCommuteMatrix(
        office.coordinates,
        outboundTime,
        returnTime,
        ALL_LOCALITIES,
      );
    } catch (err) {
      throw new DistanceMatrixError(
        `cold-start commute compute failed: ${(err as Error).message ?? 'unknown'}`,
      );
    }
    matrix = result.matrix;

    // Cache write. Race accepted: two simultaneous cold-starts at the same
    // key both compute, both write, last-write-wins. Both clients receive
    // their own correct data. Vanishingly rare at v0 scale.
    //
    // Write failure: swallowed. We have the result, return it. Next request
    // at this key will cold-start again — annoying, not broken.
    try {
      await cacheSet(cacheKey, matrix);
    } catch (err) {
      console.error(
        'commute-cache: write failed after successful compute (ignored)',
        err,
      );
    }
  }

  // ─── Step 4: annotate every loaded locality with its commute ───
  const commuteByLocality = new Map<string, CommuteResult>();
  for (const entry of matrix) {
    commuteByLocality.set(
      entry.locality_id,
      buildCommuteResult(entry, maxTotalDaily),
    );
  }

  const annotated: AnnotatedLocality[] = [];
  for (const locality of ALL_LOCALITIES) {
    const commute = commuteByLocality.get(locality.id);
    if (commute) {
      annotated.push({ locality, commutes: [commute] });
    }
  }
  const totalEvaluated = annotated.length;

  // ─── Step 5: filter (commute → budget) ───
  // Order matters: spec §3 mandates filter-then-score, commute first.
  let survivors: AnnotatedLocality[] = annotated.filter(({ commutes }) => {
    const commute = commutes[0];
    if (!commute) return false;
    return passesCommuteFilter(commute.total_minutes, maxTotalDaily);
  });
  survivors = survivors.filter(({ locality }) => {
    const fit = computeBudgetFit(locality, input.budget_inr, input.bhk);
    return fit !== null && fit.in_range;
  });

  // ─── Step 6: edge cases (zero survivors) ───
  let relaxationApplied: RelaxationApplied | undefined;
  let tradeoffPoints: TradeoffPoint[] | undefined;

  if (survivors.length === 0) {
    // Pass the FULL annotated set (not the empty filtered array) so
    // relaxation can re-filter against every locality with widened thresholds.
    // The cached matrix is filter-independent — no new Distance Matrix calls
    // needed for relaxation. (Confirmed in kickoff Q.)
    const result = await runEdgeCases(input, annotated);
    if (result.kind === 'relaxed') {
      survivors = result.survivors;
      relaxationApplied = result.relaxation_applied;
    } else {
      // 'empty': survivors stay [], tradeoff points populate alongside.
      tradeoffPoints = result.tradeoff_points;
    }
  }

  // ─── Step 7: score + assemble LocalityResults ───
  const toggles = resolveToggles(input);
  const scoreParams = { maxCommuteTotalDaily: maxTotalDaily, toggles };

  const scored: LocalityResult[] = survivors.map(({ locality, commutes }) => {
    const commute = commutes[0];
    if (!commute) {
      // Annotated localities always carry exactly one commute in v0.
      throw new Error(`search: locality ${locality.id} missing commute`);
    }

    const score = computeLocalityScore(locality, commute, scoreParams);

    // Budget fit is annotated against the user's ORIGINAL budget — not any
    // relaxed budget — so the UI shows the honest position-in-range signal.
    const budgetFit = computeBudgetFit(
      locality,
      input.budget_inr,
      input.bhk,
    );
    if (!budgetFit) {
      throw new Error(
        `search: locality ${locality.id} has no rent_range for bhk=${input.bhk}`,
      );
    }
    const rentRangeUsed = locality.rent_ranges[input.bhk];
    if (!rentRangeUsed) {
      // Structurally guaranteed by computeBudgetFit returning non-null,
      // but TS can't see that. Re-check for type narrowing.
      throw new Error(
        `search: locality ${locality.id} rent_range missing post budget-fit`,
      );
    }

    // Per-society: household filter as annotation (not exclusion), plus
    // deep-links. Per product-spec §7, the UI may hide/gray societies that
    // fail the household filter — we ship all of them with the flag and let
    // the UI decide.
    const matchedSocieties: MatchedSociety[] = locality.societies.map(
      (society) => ({
        society,
        deep_links: buildSocietyDeeplinks(society, locality, locality.city),
        passes_household_filter: passesHouseholdFilter(
          society,
          input.household,
        ),
      }),
    );

    const localityWideDeepLinks = buildLocalityDeeplinks(
      locality,
      locality.city,
      input.bhk,
      input.budget_inr,
    );

    return {
      locality,
      commutes,
      score,
      budget_fit: budgetFit,
      rent_range_used: rentRangeUsed,
      matched_societies: matchedSocieties,
      locality_wide_deep_links: localityWideDeepLinks,
    };
  });

  // Sort by final score, descending.
  scored.sort((a, b) => b.score.final_score - a.score.final_score);

  // ─── Step 8: resolve isochrone (launched at top, awaited here) ───
  // Polygon is decorative. Failure was already caught at the promise's
  // creation site (returning null), so we just check for null here.
  let isochroneField: SearchResult['search_metadata']['isochrone'];
  const iso = await isochronePromise;
  if (iso) {
    // If the wrapper clamped (one-way budget > 60), surface the user's
    // ORIGINAL total-daily input to the UI — not the one-way value that
    // got clamped. Keeps MapView's clamp message ("your full {X}-min
    // results are in the list") consistent with the form input.
    isochroneField =
      iso.clamped_at_minutes !== undefined
        ? { geometry: iso.geometry, clamped_at_minutes: maxTotalDaily }
        : { geometry: iso.geometry };
  }

  // ─── Step 9: assemble typed SearchResult ───
  const searchResult: SearchResult = {
    results: scored,
    search_metadata: {
      offices_resolved: [office.coordinates],
      cold_start: coldStart,
      timestamp: new Date().toISOString(),
      total_localities_evaluated: totalEvaluated,
      ...(isochroneField ? { isochrone: isochroneField } : {}),
    },
    ...(relaxationApplied ? { relaxation_applied: relaxationApplied } : {}),
    ...(tradeoffPoints ? { tradeoff_points: tradeoffPoints } : {}),
  };

  return searchResult;
}