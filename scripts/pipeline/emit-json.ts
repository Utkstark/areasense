// scripts/pipeline/emit-json.ts
//
// Stage 7 of the build-time data pipeline.
//
// Merges Stage 4/5/6 output into the on-disk LocalityRecord shape and writes
// the final per-city JSON files (data/locality-data-{gurgaon,delhi}.json).
//
// For each on-disk record:
//   - Preserved as-is: id, name, sector_label?, city, source, centroid,
//                      geometry? (only when defined), nearest_metros
//   - Overwritten from Stage 5: rent_ranges + rent_sample_sizes per BHK
//                               (empty {} when no cells survived MIN_SAMPLE_SIZE)
//   - Overwritten from Stage 6: societies array (empty [] when no aggregations)
//   - Dropped at this stage:    RentRangeEntry.trimmedCount (audit-only;
//                               run log keeps it, JSON output doesn't)
//
// Each merged record is Zod-validated before write — fail-the-build policy
// from chat 1d. Per-city write is atomic (.tmp → rename), independent across
// files: a Gurgaon failure doesn't corrupt Delhi.
//
// Sync I/O is intentional — small files, build-time only, matches the
// existing readFileSync pattern in index.ts and persistNewRecords in
// resolve-locality.ts.

import * as fs from 'fs';
import { LocalityRecordSchema } from '@/types/schemas';
import type { BHK, City, LocalityId } from '@/types/primitives';
import type {
  BHKRentRange,
  LocalityRecord,
  RentRangesByBHK,
  RentSampleSizesByBHK,
  Society,
} from '@/types/data';
import type { RentRangeEntry } from './compute-rent-ranges';

const DATA_DIR = 'data';

export interface EmitJsonInput {
  existingRecords:     ReadonlyArray<LocalityRecord>;
  filteredRanges:      ReadonlyMap<string, RentRangeEntry>;   // Stage 5 output
  societiesByLocality: ReadonlyMap<LocalityId, Society[]>;    // Stage 6 output
}

export interface EmitJsonPerCityResult {
  count: number;
  path:  string;
}

export interface EmitJsonResult {
  byCity: Partial<Record<City, EmitJsonPerCityResult>>;
  total:  number;
}

function pathForCity(city: City): string {
  return `${DATA_DIR}/locality-data-${city.toLowerCase()}.json`;
}

/**
 * Regroup Stage 5's filtered ranges (Map<"${id}::${bhk}", RentRangeEntry>)
 * by locality_id for O(1) per-locality lookup during merge.
 */
function groupRangesByLocality(
  ranges: ReadonlyMap<string, RentRangeEntry>,
): Map<LocalityId, Map<BHK, RentRangeEntry>> {
  const result = new Map<LocalityId, Map<BHK, RentRangeEntry>>();
  for (const entry of ranges.values()) {
    let perLoc = result.get(entry.localityId);
    if (perLoc === undefined) {
      perLoc = new Map<BHK, RentRangeEntry>();
      result.set(entry.localityId, perLoc);
    }
    perLoc.set(entry.bhk, entry);
  }
  return result;
}

/**
 * Merge one on-disk record with computed Stage 5/6 data into a complete
 * LocalityRecord ready for emit. sector_label and geometry are conditionally
 * included only when defined on the existing record — preserves the
 * "absent vs null" distinction in the on-disk JSON.
 */
function mergeRecord(
  existing:   LocalityRecord,
  rangeCells: Map<BHK, RentRangeEntry> | undefined,
  societies:  Society[] | undefined,
): LocalityRecord {
  const rentRanges:      RentRangesByBHK      = {};
  const rentSampleSizes: RentSampleSizesByBHK = {};

  if (rangeCells !== undefined) {
    for (const [bhk, entry] of rangeCells) {
      rentRanges[bhk]      = [entry.low, entry.high] as const satisfies BHKRentRange;
      rentSampleSizes[bhk] = entry.sampleSize;
    }
  }

  const merged: LocalityRecord = {
    id:                existing.id,
    name:              existing.name,
    city:              existing.city,
    source:            existing.source,
    centroid:          existing.centroid,
    nearest_metros:    existing.nearest_metros,
    rent_ranges:       rentRanges,
    rent_sample_sizes: rentSampleSizes,
    societies:         societies ?? [],
  };

  if (existing.sector_label !== undefined) merged.sector_label = existing.sector_label;
  if (existing.geometry     !== undefined) merged.geometry     = existing.geometry;

  return merged;
}

/**
 * Stage 7 entry point — see file header for the full contract.
 */
export function emitJson(input: EmitJsonInput): EmitJsonResult {
  const { existingRecords, filteredRanges, societiesByLocality } = input;

  // -------- Pipeline invariant: every computed locality_id has an on-disk record --------
  // Stage 6 already skips localities without a centroid (no on-disk record),
  // so this defensive check shouldn't fire. If it does, it's a pipeline bug,
  // not data drift — fail loud.
  const onDiskIds = new Set<LocalityId>(existingRecords.map((r) => r.id));

  for (const entry of filteredRanges.values()) {
    if (!onDiskIds.has(entry.localityId)) {
      throw new Error(
        `emit-json: Stage 5 produced a rent range for locality_id ` +
        `"${entry.localityId}" / BHK "${entry.bhk}" with no on-disk record. ` +
        `Pipeline invariant violation.`,
      );
    }
  }
  for (const localityId of societiesByLocality.keys()) {
    if (!onDiskIds.has(localityId)) {
      throw new Error(
        `emit-json: Stage 6 produced societies for locality_id "${localityId}" ` +
        `with no on-disk record. Pipeline invariant violation.`,
      );
    }
  }

  // -------- Pre-group Stage 5 ranges by locality_id --------
  const rangesByLocality = groupRangesByLocality(filteredRanges);

  // -------- Merge — preserves on-disk insertion order (stable git diffs) --------
  const merged: LocalityRecord[] = existingRecords.map((existing) =>
    mergeRecord(
      existing,
      rangesByLocality.get(existing.id),
      societiesByLocality.get(existing.id),
    ),
  );

  // -------- Validate every merged record (fail-the-build) --------
  // No JSON gets written if any record fails. Throws with the first issue's
  // locality_id + first 5 issues so the operator can find the offender fast.
  for (const record of merged) {
    const result = LocalityRecordSchema.safeParse(record);
    if (!result.success) {
      throw new Error(
        `emit-json: Zod validation failed for locality "${record.id}":\n` +
        JSON.stringify(result.error.issues.slice(0, 5), null, 2),
      );
    }
  }

  // -------- Group by city --------
  const byCityRecords = new Map<City, LocalityRecord[]>();
  for (const record of merged) {
    const list = byCityRecords.get(record.city);
    if (list === undefined) {
      byCityRecords.set(record.city, [record]);
    } else {
      list.push(record);
    }
  }

  // -------- Atomic write per city --------
  // Independent per file: a Delhi failure leaves the previous Delhi file
  // intact. Temp+rename mirrors resolve-locality.ts → persistNewRecords.
  const byCity: Partial<Record<City, EmitJsonPerCityResult>> = {};
  for (const [city, records] of byCityRecords) {
    const finalPath = pathForCity(city);
    const tmpPath   = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
    byCity[city] = { count: records.length, path: finalPath };
  }

  return {
    byCity,
    total: merged.length,
  };
}