// scripts/pipeline/resolve-locality.ts
//
// Stage 2 — three-tier locality resolution.
//   Tier 1: data/locality-mapping.json (manual overrides)
//   Tier 2: data/locality-data-{city}.json (existing canonical records)
//   Tier 3: bootstrapLocality() — Google Geocoding + Places nearby
//
// Per-run cache keyed by (city, raw_value) — same raw string resolves once.
// Tier-3 cap (default 150) prevents runaway API spend; on hit, remaining
// unresolved rows are marked skipped and the orchestrator should exit non-zero.

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import type {
  RawListingRecord,
  ResolvedRow,
  ResolutionOutcome,
  ResolutionSkipReason,
  ResolverStats,
  LocalityMapping,
} from '../../types/pipeline';
import type { City, LocalityId } from '../../types/primitives';
import type { LocalityRecord } from '../../types/data';
import { bootstrapLocality } from './bootstrap-locality';

const DEFAULT_TIER3_CAP = 150;
const MAPPING_FILE = path.resolve('data/locality-mapping.json');
const LOCALITY_DATA_FILES: Record<City, string> = {
  Gurgaon: 'data/locality-data-gurgaon.json',
  Delhi:   'data/locality-data-delhi.json',
};

interface ResolverOptions {
  bootstrapCap?: number;
}

export interface SkippedRow {
  row:     RawListingRecord;
  reason:  ResolutionSkipReason;
  detail?: string;
}

export interface ResolveResult {
  resolved:    ResolvedRow[];
  skipped:     SkippedRow[];
  newRecords:  LocalityRecord[];
  stats:       ResolverStats;
}

export async function resolveLocalities(
  rows: RawListingRecord[],
  options: ResolverOptions = {}
): Promise<ResolveResult> {
  const cap = options.bootstrapCap ?? DEFAULT_TIER3_CAP;

  const mapping        = loadMapping();
  const tier2Index     = buildTier2Index(loadLocalityRecords());
  const outcomeCache   = new Map<string, ResolutionOutcome>();

  const stats: ResolverStats = {
    total:               rows.length,
    resolved:            0,
    byTier:              { mapping: 0, existing: 0, bootstrap: 0 },
    skipped:             0,
    bySkipReason:        {},
    bootstrapCalls:      0,
    bootstrapCapReached: false,
  };

  const resolved:    ResolvedRow[]      = [];
  const skipped:     SkippedRow[]       = [];
  const newRecords:  LocalityRecord[]   = [];

  for (const row of rows) {
    const cityRaw     = row.City?.trim();
    const localityRaw = row.Locality_Sector?.trim();

    if (!cityRaw) {
      recordSkip(row, 'missing_city', undefined, stats, skipped);
      continue;
    }
    if (!localityRaw) {
      recordSkip(row, 'missing_locality_sector', undefined, stats, skipped);
      continue;
    }
    if (cityRaw !== 'Gurgaon' && cityRaw !== 'Delhi') {
      recordSkip(row, 'invalid_city', cityRaw, stats, skipped);
      continue;
    }
    const city = cityRaw as City;

    const cacheKey = `${city}::${localityRaw}`;
    let outcome = outcomeCache.get(cacheKey);

    if (!outcome) {
      // Tier 1 — manual override
      const tier1Id = mapping[city]?.[localityRaw];
      if (tier1Id) {
        outcome = { ok: true, localityId: tier1Id, resolvedVia: 'mapping' };
      } else {
        // Tier 2 — existing canonical record (case-insensitive name match)
        const tier2Id = tier2Index.get(`${city}::${localityRaw.toLowerCase()}`);
        if (tier2Id) {
          outcome = { ok: true, localityId: tier2Id, resolvedVia: 'existing' };
        } else {
          // Tier 3 — bootstrap (capped)
          if (stats.bootstrapCalls >= cap) {
            stats.bootstrapCapReached = true;
            outcome = {
              ok: false,
              reason: 'bootstrap_cap_reached',
              rawCity: city,
              rawValue: localityRaw,
            };
          } else {
            stats.bootstrapCalls++;
            try {
              const bs = await bootstrapLocality({ city, localityValue: localityRaw });
              if (bs.ok) {
                // Add to in-memory tier-2 index so future rows with the same
                // canonical name short-circuit to tier 2 instead of re-bootstrapping.
                tier2Index.set(`${city}::${bs.record.name.toLowerCase()}`, bs.record.id);
                newRecords.push(bs.record);
                outcome = {
                  ok: true,
                  localityId: bs.record.id,
                  resolvedVia: 'bootstrap',
                  newRecord: bs.record,
                };
              } else {
                outcome = {
                  ok: false,
                  reason: `bootstrap_${bs.skip.reason}` as ResolutionSkipReason,
                  rawCity: city,
                  rawValue: localityRaw,
                };
              }
            } catch (e) {
              outcome = {
                ok: false,
                reason: 'bootstrap_geocode_failed',
                rawCity: city,
                rawValue: localityRaw,
              };
              console.error(`[resolve-locality] bootstrap threw for ${city}/${localityRaw}: ${(e as Error).message}`);
            }
          }
        }
      }
      outcomeCache.set(cacheKey, outcome);
    }

    if (outcome.ok) {
      resolved.push({ row, localityId: outcome.localityId, resolvedVia: outcome.resolvedVia });
      stats.resolved++;
      stats.byTier[outcome.resolvedVia]++;
    } else {
      recordSkip(row, outcome.reason, `${outcome.rawCity}/${outcome.rawValue}`, stats, skipped);
    }
  }

  // Surface unresolved set if cap hit — operator should add overrides + re-run.
  if (stats.bootstrapCapReached) {
    const unique = new Set(
      skipped
        .filter((s) => s.reason === 'bootstrap_cap_reached')
        .map((s) => s.detail)
    );
    console.error(
      `\n[resolve-locality] tier-3 cap of ${cap} reached. Unresolved (city/value):\n` +
      [...unique].map((u) => `  ${u}`).join('\n') +
      `\n\nAdd entries to data/locality-mapping.json (manual override) or hand-curate\n` +
      `into data/locality-data-{city}.json, then re-run.\n`
    );
  }

  return { resolved, skipped, newRecords, stats };
}

// ============================================================================
// helpers
// ============================================================================

function recordSkip(
  row: RawListingRecord,
  reason: ResolutionSkipReason,
  detail: string | undefined,
  stats: ResolverStats,
  skipped: SkippedRow[]
): void {
  stats.skipped++;
  stats.bySkipReason[reason] = (stats.bySkipReason[reason] ?? 0) + 1;
  skipped.push({ row, reason, detail });
}

function loadMapping(): LocalityMapping {
  if (!existsSync(MAPPING_FILE)) return {};
  try {
    return JSON.parse(readFileSync(MAPPING_FILE, 'utf-8')) ?? {};
  } catch (e) {
    console.warn(`[resolve-locality] could not parse ${MAPPING_FILE}: ${(e as Error).message}`);
    return {};
  }
}

function loadLocalityRecords(): Record<City, LocalityRecord[]> {
  const out: Record<City, LocalityRecord[]> = { Gurgaon: [], Delhi: [] };
  for (const city of Object.keys(LOCALITY_DATA_FILES) as City[]) {
    const file = LOCALITY_DATA_FILES[city];
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed)) out[city] = parsed as LocalityRecord[];
    } catch (e) {
      console.warn(`[resolve-locality] could not parse ${file}: ${(e as Error).message}`);
    }
  }
  return out;
}

function buildTier2Index(records: Record<City, LocalityRecord[]>): Map<string, LocalityId> {
  const idx = new Map<string, LocalityId>();
  for (const city of Object.keys(records) as City[]) {
    for (const rec of records[city]) {
      idx.set(`${city}::${rec.name.toLowerCase()}`, rec.id);
    }
  }
  return idx;
}
