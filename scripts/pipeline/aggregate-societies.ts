// scripts/pipeline/aggregate-societies.ts
//
// Stage 6 of the build-time data pipeline.
//
// Groups resolved rows by (locality_id, normalized_society_name) and produces
// a Society record per group:
//   - id:                       `${locality_id}-${slug(name)}` (composite for
//                               uniqueness across the dataset)
//   - name:                     first-seen original casing (display string)
//   - coordinates:              locality centroid (v0; per-society geocoding
//                               deferred to v1+ enrichment)
//   - tenant_preference_signal: majority vote (chat 1d: threshold lowered to 1)
//   - rent_estimate_by_bhk:     per-BHK median + sample size (chat 1d addition;
//                               no minimum threshold — emit for any sample size)
//   - rating_data:              omitted (Places API enrichment deferred)
//
// Pure function — no I/O, no Google calls. Output is consumed by Stage 7.

import type {
  BHK,
  Coordinates,
  LocalityId,
  SocietyId,
  TenantPreferenceSignal,
} from '@/types/primitives';
import type { Society, SocietyRentEstimateByBhk } from '@/types/data';
import type { ResolvedRow } from '@/types/pipeline';
import { parseBHK } from './compute-rent-ranges';

export interface SocietyAggregationSummary {
  rowsSeen:                  number;
  rowsSkippedNoSociety:      number;  // Society column empty / whitespace
  rowsSkippedNoCentroid:     number;  // resolved locality_id had no record on disk
                                      // (defensive; should be 0 in practice)
  societiesEmitted:          number;
  societiesWithTenantSignal: number;  // tenant_preference_signal !== 'unknown'
  societiesWithRentEstimate: number;  // ≥ 1 BHK cell with valid rent
}

export interface AggregatedSocietiesResult {
  societies: Map<LocalityId, Society[]>;
  summary:   SocietyAggregationSummary;
}

// ── Helpers ──

/** Normalize a society name for grouping (trim + lowercase + collapse internal whitespace). */
function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Slugify a society name for ID generation: lowercase, non-alphanumeric → hyphen, dedupe and trim. */
function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Map a raw CSV Tenant_Preference value to the canonical signal, or null if missing/unrecognized. */
function mapTenantPreference(raw: string | undefined): TenantPreferenceSignal | null {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim();
  if (s === '') return null;
  if (s === 'Bachelors')                       return 'accepts_bachelors';
  if (s === 'Family')                          return 'accepts_family';
  if (s === 'Bachelors/Family' || s === 'Any') return 'accepts_both';
  return null;
}

/**
 * Compute majority-vote tenant signal.
 * - No valid votes → 'unknown'
 * - Tie-break order: 'accepts_both' (most inclusive) → 'accepts_bachelors' → 'accepts_family'
 *   (iteration in this order; first to hit a higher count wins; equal counts leave the
 *   earlier-in-order winner in place — i.e., 'accepts_both' wins ties.)
 */
function computeMajoritySignal(votes: TenantPreferenceSignal[]): TenantPreferenceSignal {
  if (votes.length === 0) return 'unknown';

  const counts = new Map<TenantPreferenceSignal, number>();
  for (const v of votes) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }

  const tieBreakOrder: TenantPreferenceSignal[] = [
    'accepts_both',
    'accepts_bachelors',
    'accepts_family',
  ];

  let winner: TenantPreferenceSignal | null = null;
  let winnerCount = 0;
  for (const candidate of tieBreakOrder) {
    const count = counts.get(candidate) ?? 0;
    if (count > winnerCount) {
      winner      = candidate;
      winnerCount = count;
    }
  }

  return winner ?? 'unknown';
}

/** Median of a non-empty sorted-ascending array. */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) throw new Error('median: empty array');
  if (n % 2 === 1) {
    return sorted[(n - 1) / 2]!;  // safe: bounds checked above
  }
  const mid1 = sorted[n / 2 - 1]!;
  const mid2 = sorted[n / 2]!;
  return (mid1 + mid2) / 2;
}

// ── Main aggregator ──

// Internal accumulator — kept as a local type alias to avoid the multi-line
// generic parser quirk and to keep the public surface clean.
type SocietyAccumulator = {
  displayName: string;
  localityId:  LocalityId;
  tenantVotes: TenantPreferenceSignal[];
  rentsByBhk:  Map<BHK, number[]>;
};

/**
 * Aggregate societies from resolved rows.
 *
 * Input:
 *   - rows:      Stage 3 output (ResolvedRow[])
 *   - centroids: locality_id → centroid; orchestrator pre-loads from the
 *                post-persistence locality-data JSON files
 *
 * Output:
 *   - societies: Map<LocalityId, Society[]> — Stage 7 merges into each
 *                LocalityRecord.societies field
 *   - summary:   counts for the run log
 */
export function aggregateSocieties(
  rows:      ReadonlyArray<ResolvedRow>,
  centroids: ReadonlyMap<LocalityId, Coordinates>,
): AggregatedSocietiesResult {
  // Group by `${localityId}::${normalizedName}` so a same-named society in
  // two different localities stays distinct.
  const accumulators = new Map<string, SocietyAccumulator>();

  let rowsSkippedNoSociety = 0;

  for (const resolved of rows) {
    const rawName = resolved.row.Society;
    if (rawName === undefined || rawName === null || rawName.trim() === '') {
      rowsSkippedNoSociety += 1;
      continue;
    }

    const normalized = normalizeName(rawName);
    const key        = `${resolved.localityId}::${normalized}`;

    let acc = accumulators.get(key);
    if (acc === undefined) {
      acc = {
        displayName: rawName.trim(),
        localityId:  resolved.localityId,
        tenantVotes: [],
        rentsByBhk:  new Map<BHK, number[]>(),
      };
      accumulators.set(key, acc);
    }

    // Tenant-preference vote (null = missing/unrecognized; doesn't count)
    const signal = mapTenantPreference(resolved.row.Tenant_Preference);
    if (signal !== null) {
      acc.tenantVotes.push(signal);
    }

    // Per-BHK rent contribution
    const bhk  = parseBHK(resolved.row.BHK);
    const rent = resolved.row.Rent_INR;
    if (
      bhk !== null &&
      rent !== undefined &&
      rent !== null &&
      Number.isFinite(rent) &&
      rent > 0
    ) {
      const bucket = acc.rentsByBhk.get(bhk);
      if (bucket === undefined) {
        acc.rentsByBhk.set(bhk, [rent]);
      } else {
        bucket.push(rent);
      }
    }
  }

  // ── Build Society objects, grouped by localityId for the output map ──
  const societies = new Map<LocalityId, Society[]>();
  let rowsSkippedNoCentroid     = 0;
  let societiesWithTenantSignal = 0;
  let societiesWithRentEstimate = 0;

  for (const acc of accumulators.values()) {
    const centroid = centroids.get(acc.localityId);
    if (centroid === undefined) {
      // Defensive: every resolved row's locality_id should have a record
      // on disk after Stage 2's persistence. Track and skip if not.
      rowsSkippedNoCentroid += 1;
      continue;
    }

    const tenantSignal = computeMajoritySignal(acc.tenantVotes);
    if (tenantSignal !== 'unknown') societiesWithTenantSignal += 1;

    // Per-BHK median rent
    const rentByBhk: SocietyRentEstimateByBhk = {};
    let hasAnyEstimate = false;
    for (const [bhk, rents] of acc.rentsByBhk) {
      if (rents.length === 0) continue;
      const sorted = [...rents].sort((a, b) => a - b);
      rentByBhk[bhk] = {
        median:      Math.round(median(sorted)),
        sample_size: sorted.length,
      };
      hasAnyEstimate = true;
    }
    if (hasAnyEstimate) societiesWithRentEstimate += 1;

    const id: SocietyId = `${acc.localityId}-${slugify(acc.displayName)}` as SocietyId;

    const society: Society = {
      id,
      name:                     acc.displayName,
      coordinates:              centroid,
      tenant_preference_signal: tenantSignal,
    };
    if (hasAnyEstimate) {
      society.rent_estimate_by_bhk = rentByBhk;
    }

    const list = societies.get(acc.localityId);
    if (list === undefined) {
      societies.set(acc.localityId, [society]);
    } else {
      list.push(society);
    }
  }

  const summary: SocietyAggregationSummary = {
    rowsSeen:                  rows.length,
    rowsSkippedNoSociety:      rowsSkippedNoSociety,
    rowsSkippedNoCentroid:     rowsSkippedNoCentroid,
    societiesEmitted:          accumulators.size - rowsSkippedNoCentroid,
    societiesWithTenantSignal: societiesWithTenantSignal,
    societiesWithRentEstimate: societiesWithRentEstimate,
  };

  return { societies, summary };
}