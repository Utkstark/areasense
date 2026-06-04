/**
 * Compute the Mon–Fri averaged commute matrix from an office to a set of
 * localities, at the given outbound and return times.
 *
 * Shared by:
 *   - scripts/prewarm-commute-cache.ts  (day-1 seeding)
 *   - scripts/refresh-commute-cache.ts  (weekly cron)
 *   - /lib/search-orchestrator.ts       (cold-start path — when that lands)
 *
 * Outbound leg: locality → office at outbound_time, averaged across the next
 *   five weekdays. Batched via Distance Matrix (many origins → one destination).
 * Return leg:   office → locality at return_time, averaged across the next
 *   five weekdays. One Distance Matrix call per locality (the wrapper is
 *   many-origins-to-one-destination — see /lib/distance-matrix.ts).
 *
 * Skipped per-locality: if either leg has zero successful samples across the
 * five weekdays, the locality is dropped from the matrix with a warning. The
 * caller decides whether to treat that as a soft warn or a hard failure.
 *
 * Dry-run: when opts.dryRun is true, no API calls are made and no real
 * timings are produced — returns a matrix with placeholder zero values and
 * a correct `elements` count for cost preview.
 */

import type {
  CommuteMatrixEntry,
  Coordinates,
  LocalityRecord,
} from '@/types';

import {
  getDrivingDurations,
  MAX_ORIGINS,
  nextFiveWeekdaysAtTimeInIST,
} from '@/lib/distance-matrix';

export interface ComputeMatrixOptions {
  /** When true, skip live API calls and return placeholder data. */
  dryRun?: boolean;
}

export interface ComputeMatrixResult {
  /** The averaged matrix, ready to pass to /lib/commute-cache.ts → set(). */
  matrix: CommuteMatrixEntry[];
  /** Number of Distance Matrix elements consumed (or would-be-consumed). */
  elements: number;
  /** Per-locality issues — e.g. zero samples on either leg. */
  warnings: string[];
}

export async function computeCommuteMatrix(
  officeCoords: Coordinates,
  outboundTime: string,
  returnTime: string,
  localities: LocalityRecord[],
  opts: ComputeMatrixOptions = {},
): Promise<ComputeMatrixResult> {
  const { dryRun = false } = opts;
  const warnings: string[] = [];
  let elements = 0;

  if (localities.length === 0) {
    return { matrix: [], elements: 0, warnings };
  }

  // ─── Outbound (locality → office at outboundTime, Mon–Fri averaged) ───
  const outboundDepartures = nextFiveWeekdaysAtTimeInIST(outboundTime);
  const outboundSamples = new Map<string, number[]>();
  for (const loc of localities) outboundSamples.set(loc.id, []);

  if (!dryRun) {
    for (const chunk of chunked(localities, MAX_ORIGINS)) {
      const origins = chunk.map((l) => l.centroid);
      for (const departure of outboundDepartures) {
        const durations = await getDrivingDurations(origins, officeCoords, departure);
        elements += chunk.length;
        chunk.forEach((loc, i) => {
          const v = durations[i];
          if (typeof v === 'number') outboundSamples.get(loc.id)!.push(v);
        });
      }
    }
  } else {
    const chunks = Math.ceil(localities.length / MAX_ORIGINS);
    elements +=
      chunks *
      outboundDepartures.length *
      Math.min(MAX_ORIGINS, localities.length);
  }

  // ─── Return (office → locality at returnTime, Mon–Fri averaged) ───
  // Wrapper is many-origins-to-one-destination, so this is one call per locality.
  const returnDepartures = nextFiveWeekdaysAtTimeInIST(returnTime);
  const returnSamples = new Map<string, number[]>();
  for (const loc of localities) returnSamples.set(loc.id, []);

  if (!dryRun) {
    for (const loc of localities) {
      for (const departure of returnDepartures) {
        const durations = await getDrivingDurations(
          [officeCoords],
          loc.centroid,
          departure,
        );
        elements += 1;
        const v = durations[0];
        if (typeof v === 'number') returnSamples.get(loc.id)!.push(v);
      }
    }
  } else {
    elements += localities.length * returnDepartures.length;
  }

  // ─── Average + assemble ───
  const matrix: CommuteMatrixEntry[] = [];
  for (const loc of localities) {
    const outSamples = outboundSamples.get(loc.id)!;
    const retSamples = returnSamples.get(loc.id)!;

    if (dryRun) {
      matrix.push({
        locality_id: loc.id,
        outbound_minutes: 0,
        return_minutes: 0,
      });
      continue;
    }

    if (outSamples.length === 0 || retSamples.length === 0) {
      warnings.push(
        `skipped ${loc.id} (${loc.name}) — outbound=${outSamples.length} samples, return=${retSamples.length} samples`,
      );
      continue;
    }

    matrix.push({
      locality_id: loc.id,
      outbound_minutes: Math.round(avg(outSamples)),
      return_minutes: Math.round(avg(retSamples)),
    });
  }

  return { matrix, elements, warnings };
}

// ───────────────────────── Helpers ─────────────────────────

function chunked<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunked: size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function avg(arr: number[]): number {
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}