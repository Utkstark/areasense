// scripts/pipeline/compute-rent-ranges.ts
//
// Stage 4 of the build-time data pipeline.
//
// Groups resolved rows by (locality_id, BHK) and computes a base-rent range
// per cell: [25th, 75th] percentile of values within the [5th, 90th] outlier-
// trim window (see PIPELINE_CONFIG in /types/config.ts).
//
// sample_size = raw count of valid rent rows for the cell, BEFORE outlier
// trim. (Chat 1d decision: option b. Outlier removal is a noise step, not a
// data-quality gate. Stage 5's MIN_SAMPLE_SIZE threshold runs against this
// raw count.) trimmedCount is also recorded for audit visibility but not
// used downstream.
//
// Pure function over an in-memory row list — no I/O, no Google calls.
// Output is consumed by Stage 5 (sample-size threshold) and Stage 7 (JSON emit).

import { PIPELINE_CONFIG } from '@/types/config';
import type { BHK, LocalityId } from '@/types/primitives';
import type { ResolvedRow } from '@/types/pipeline';

export interface RentRangeEntry {
  localityId:   LocalityId;
  bhk:          BHK;
  low:          number;  // INR/month, base rent (excludes maintenance), integer
  high:         number;  // INR/month, base rent (excludes maintenance), integer
  sampleSize:   number;  // raw count, pre-trim — drives Stage 5's threshold
  trimmedCount: number;  // count after outlier trim; audit/debug only
}

export interface RentRangeSummary {
  rowsSeen:                number;
  rowsSkippedInvalidRent:  number;  // missing, non-positive, or non-finite Rent_INR
  rowsSkippedInvalidBhk:   number;  // missing or unparseable BHK
  rowsUsed:                number;
  cellsEmitted:            number;
  cellsMeetingMinSamples:  number;  // sampleSize >= MIN_SAMPLE_SIZE
                                     // (preview of Stage 5's filter effect)
}

/**
 * Normalize a raw BHK string to the canonical BHK union. Handles both
 * already-normalized values ('1', 'studio', '4+') and raw CSV variants
 * ('1 BHK', 'Studio', '1 RK', '5 BHK'). Returns null for unrecognizable input.
 *
 * Defensive at the Stage 3/4 boundary — Stage 3's backfill is documented to
 * normalize, but the field type stays `string | undefined`, so we re-validate
 * here. Idempotent on canonical inputs.
 */
export function parseBHK(raw: string | undefined): BHK | null {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim().toLowerCase();
  if (s === '') return null;

  // Studio family
  if (s === 'studio' || s === '1 rk' || s === '1rk') {
    return 'studio';
  }

  // "1", "1 bhk", "1bhk", "4+", "4+ bhk", "5", "5 bhk", etc.
  const m = s.match(/^(\d+)(\+)?(\s*bhk)?$/);
  if (!m) return null;
  const num = parseInt(m[1]!, 10);
  if (!Number.isFinite(num) || num < 1) return null;
  const hasPlus = m[2] === '+';

  if (hasPlus || num >= 4) return '4+';
  if (num === 1) return '1';
  if (num === 2) return '2';
  if (num === 3) return '3';
  return null;
}

/**
 * Linear-interpolation percentile (matches numpy's default).
 * `sorted` must be sorted ascending. `p` is in [0, 100].
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    throw new Error('percentile: empty array');
  }
  const first = sorted[0]!;  // safe: length checked above
  if (sorted.length === 1) {
    return first;
  }
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  // safe: lo, hi ∈ [0, sorted.length - 1] by construction
  const loVal = sorted[lo]!;
  const hiVal = sorted[hi]!;
  if (lo === hi) {
    return loVal;
  }
  const frac = rank - lo;
  return loVal + (hiVal - loVal) * frac;
}

/**
 * Compute rent ranges per (locality_id, BHK) cell.
 *
 * Returns:
 *   - ranges: Map keyed by `${localityId}::${bhk}` for easy iteration in
 *             Stage 5 (threshold filter) and Stage 7 (JSON emit grouping).
 *   - summary: counts for the orchestrator's run summary log.
 */
export function computeRentRanges(
  rows: ReadonlyArray<ResolvedRow>,
): {
  ranges:  Map<string, RentRangeEntry>;
  summary: RentRangeSummary;
} {
  const [trimLoPct,  trimHiPct]  = PIPELINE_CONFIG.OUTLIER_TRIM_PERCENTILES;
  const [rangeLoPct, rangeHiPct] = PIPELINE_CONFIG.RENT_RANGE_PERCENTILES;
  const minSamples               = PIPELINE_CONFIG.MIN_SAMPLE_SIZE;

  // ── Group valid rents per (localityId, bhk) cell ──
  // Bucket stores the parsed key components alongside the rents so we never
  // need to re-parse the string key downstream. Type extracted to a local
  // named alias rather than inlined as a Map generic — multi-line generic
  // params with complex inline types have caused parser errors in this
  // codebase before (per chat 1b learnings).
  type RentBucket = {
    localityId: LocalityId;
    bhk: BHK;
    rents: number[];
  };
  const buckets = new Map<string, RentBucket>();

  let rowsSkippedInvalidRent = 0;
  let rowsSkippedInvalidBhk  = 0;
  let rowsUsed               = 0;

  for (const resolved of rows) {
    const bhk = parseBHK(resolved.row.BHK);
    if (bhk === null) {
      rowsSkippedInvalidBhk += 1;
      continue;
    }

    const rent = resolved.row.Rent_INR;
    if (
      rent === undefined ||
      rent === null ||
      !Number.isFinite(rent) ||
      rent <= 0
    ) {
      rowsSkippedInvalidRent += 1;
      continue;
    }

    const key = `${resolved.localityId}::${bhk}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, {
        localityId: resolved.localityId,
        bhk,
        rents: [rent],
      });
    } else {
      bucket.rents.push(rent);
    }
    rowsUsed += 1;
  }

  // ── Per bucket: trim outliers, compute [25, 75] of the trimmed set ──
  const ranges = new Map<string, RentRangeEntry>();
  let cellsMeetingMinSamples = 0;

  for (const [key, { localityId, bhk, rents }] of buckets) {
    const sorted     = [...rents].sort((a, b) => a - b);
    const sampleSize = sorted.length;  // raw count (chat 1d decision: option b)

    // Outlier trim window.
    const trimLoVal = percentile(sorted, trimLoPct);
    const trimHiVal = percentile(sorted, trimHiPct);
    const trimmed   = sorted.filter((v) => v >= trimLoVal && v <= trimHiVal);

    // Degenerate guard: if pathological inputs leave us with an empty trimmed
    // set, fall back to the un-trimmed sorted array for the range computation.
    // trimmedCount still reflects the trim result for audit.
    const source = trimmed.length > 0 ? trimmed : sorted;

    const low  = Math.round(percentile(source, rangeLoPct));
    const high = Math.round(percentile(source, rangeHiPct));

    // Defensive invariant — should hold by construction since rangeLoPct
    // < rangeHiPct over a sorted set; surfaced to fail loudly if a future
    // config change breaks this. Stage 7's Zod schema also enforces this
    // at emit time.
    if (low > high) {
      throw new Error(
        `compute-rent-ranges: invariant violated for ${key}: ` +
        `low=${low} > high=${high}`,
      );
    }

    ranges.set(key, {
      localityId,
      bhk,
      low,
      high,
      sampleSize,
      trimmedCount: trimmed.length,
    });

    if (sampleSize >= minSamples) {
      cellsMeetingMinSamples += 1;
    }
  }

  const summary: RentRangeSummary = {
    rowsSeen:                rows.length,
    rowsSkippedInvalidRent:  rowsSkippedInvalidRent,
    rowsSkippedInvalidBhk:   rowsSkippedInvalidBhk,
    rowsUsed:                rowsUsed,
    cellsEmitted:            ranges.size,
    cellsMeetingMinSamples:  cellsMeetingMinSamples,
  };

  return { ranges, summary };
}

/**
 * Stage 5 — apply MIN_SAMPLE_SIZE threshold to the Stage 4 output.
 *
 * Cells with fewer than `minSamples` listings are too thin to compute a
 * trustworthy [25, 75] range and are dropped. v0 uses omit-only (chat 1d
 * decision: option c). Borrow-from-neighbor and manual-estimate fallbacks
 * are deferred to chat 1e+.
 *
 * Stage 7 consumes the filtered map (NOT the raw Stage 4 output) so dropped
 * cells never reach the emitted JSON.
 */
export function filterByMinSamples(
  ranges:     ReadonlyMap<string, RentRangeEntry>,
  minSamples: number,
): {
  filtered: Map<string, RentRangeEntry>;
  kept:     number;
  dropped:  number;
} {
  const filtered = new Map<string, RentRangeEntry>();
  let dropped = 0;
  for (const [key, entry] of ranges) {
    if (entry.sampleSize >= minSamples) {
      filtered.set(key, entry);
    } else {
      dropped += 1;
    }
  }
  return { filtered, kept: filtered.size, dropped };
}