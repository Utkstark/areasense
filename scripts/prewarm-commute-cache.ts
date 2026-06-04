/**
 * scripts/prewarm-commute-cache.ts
 *
 * Day-1 cache seeding (tech-architecture §8 + §12). Computes the Mon–Fri
 * averaged commute matrix for every (curated_hub × default 09:00 / 18:00 times)
 * tuple, writes each entry to Upstash Redis via /lib/commute-cache.ts, then
 * snapshots the full Redis state to /data/commute-cache.json.
 *
 * Idempotent: re-runs overwrite existing entries with fresh `computed_at`.
 * Manual-only — never auto-runs on deploy (see tech-architecture §13.3).
 *
 * Cost: ~10 × N Distance Matrix elements per hub (N = total localities across
 * all cities). 7 hubs × 10 localities ≈ 700 elements ≈ a few dollars.
 *
 * Usage:
 *   npm run build:cache              # real run — calls Google + writes Redis + JSON
 *   npm run build:cache -- --dry-run # print what would happen; no API, no writes
 */

import fs from 'node:fs';
import path from 'node:path';

import type { City, LocalityRecord, OfficeHub } from '@/types';
import type { CacheKey, CommuteMatrixEntry } from '@/types';

import {
  getDrivingDurations,
  MAX_ORIGINS,
  nextFiveWeekdaysAtTimeInIST,
} from '@/lib/distance-matrix';

import {
  roundOfficeCoords,
  set as cacheSet,
  snapshot as cacheSnapshot,
} from '@/lib/commute-cache';

// ───────────────────────── Config ─────────────────────────

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'commute-cache.json');

const DEFAULT_OUTBOUND_TIME = '09:00';
const DEFAULT_RETURN_TIME = '18:00';

const CITIES: City[] = ['Gurgaon', 'Delhi'];

const dryRun = process.argv.includes('--dry-run');

// ───────────────────────── Main ─────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AreaSense — commute cache prewarm');
  console.log(
    `  Mode: ${dryRun ? 'DRY RUN (no API calls, no writes)' : 'LIVE (will call Google + write Redis + JSON)'}`,
  );
  console.log('═══════════════════════════════════════════════════════════');

  const hubs = loadHubs();
  const localities = loadLocalities();

  console.log(
    `\nLoaded ${hubs.length} office hubs, ${localities.length} localities.\n`,
  );

  if (hubs.length === 0) {
    console.error('No office hubs found — nothing to prewarm. Exiting.');
    process.exit(1);
  }

  if (localities.length === 0) {
    console.warn(
      'WARNING: no localities found. Cache entries will be written with empty ' +
        'matrices. This is structurally valid but practically useless — populate ' +
        'data/locality-data-*.json before running this script in production.\n',
    );
  }

  const startMs = Date.now();
  let totalElements = 0;
  const allWarnings: string[] = [];

  for (let i = 0; i < hubs.length; i++) {
    const hub = hubs[i]!;
    console.log(`[${i + 1}/${hubs.length}] ${hub.name} (${hub.city})`);

    const { matrix, elements, warnings } = await processHub(hub, localities);
    totalElements += elements;
    allWarnings.push(...warnings.map((w) => `  ${hub.name}: ${w}`));

    if (dryRun) {
      console.log(
        `    Would write ${matrix.length} entries (${elements} Distance Matrix elements)`,
      );
      continue;
    }

    const key: CacheKey = {
      office_coords_rounded: roundOfficeCoords(hub.centroid),
      outbound_time: DEFAULT_OUTBOUND_TIME,
      return_time: DEFAULT_RETURN_TIME,
    };
    await cacheSet(key, matrix);
    console.log(`    Wrote ${matrix.length} entries to Redis (${elements} elements)`);
  }

  // Snapshot to JSON (lockstep with Redis writes)
  if (!dryRun) {
    console.log('\nSnapshotting Redis → data/commute-cache.json …');
    const snap = await cacheSnapshot();
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
    console.log(`Snapshot written: ${Object.keys(snap).length} entries.\n`);
  }

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Done in ${elapsedSec}s. Total elements: ${totalElements}.`);
  if (allWarnings.length > 0) {
    console.log(`  Warnings (${allWarnings.length}):`);
    for (const w of allWarnings) console.log(w);
  }
  console.log('═══════════════════════════════════════════════════════════');
}

// ───────────────────────── Hub-level processing ─────────────────────────

interface HubResult {
  matrix: CommuteMatrixEntry[];
  elements: number;
  warnings: string[];
}

async function processHub(
  hub: OfficeHub,
  localities: LocalityRecord[],
): Promise<HubResult> {
  const warnings: string[] = [];
  let elements = 0;

  // ── Outbound (locality → hub at 09:00, Mon–Fri averaged) ──
  // Batched: many origins → one destination per Distance Matrix call.
  const outboundDepartures = nextFiveWeekdaysAtTimeInIST(DEFAULT_OUTBOUND_TIME);
  const outboundSamples = new Map<string, number[]>();
  for (const loc of localities) outboundSamples.set(loc.id, []);

  if (!dryRun) {
    for (const chunk of chunked(localities, MAX_ORIGINS)) {
      const origins = chunk.map((l) => l.centroid);
      for (const departure of outboundDepartures) {
        const durations = await getDrivingDurations(origins, hub.centroid, departure);
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

  // ── Return (hub → locality at 18:00, Mon–Fri averaged) ──
  // Distance Matrix wrapper is many-origins-to-one-destination, so return
  // leg needs one call per locality (hub as the single origin).
  const returnDepartures = nextFiveWeekdaysAtTimeInIST(DEFAULT_RETURN_TIME);
  const returnSamples = new Map<string, number[]>();
  for (const loc of localities) returnSamples.set(loc.id, []);

  if (!dryRun) {
    for (const loc of localities) {
      for (const departure of returnDepartures) {
        const durations = await getDrivingDurations(
          [hub.centroid],
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

  // ── Average and assemble matrix ──
  const matrix: CommuteMatrixEntry[] = [];
  for (const loc of localities) {
    const outSamples = outboundSamples.get(loc.id)!;
    const retSamples = returnSamples.get(loc.id)!;

    if (!dryRun) {
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
    } else {
      // Dry-run produces placeholder entries so the count reported is honest.
      matrix.push({
        locality_id: loc.id,
        outbound_minutes: 0,
        return_minutes: 0,
      });
    }
  }

  return { matrix, elements, warnings };
}

// ───────────────────────── Helpers ─────────────────────────

function loadHubs(): OfficeHub[] {
  const all: OfficeHub[] = [];
  for (const city of CITIES) {
    const file = path.join(DATA_DIR, `office-hubs-${city.toLowerCase()}.json`);
    if (!fs.existsSync(file)) {
      console.warn(`  (skipping ${file} — file not found)`);
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${file} does not contain a JSON array`);
    }
    all.push(...(parsed as OfficeHub[]));
  }
  return all;
}

function loadLocalities(): LocalityRecord[] {
  const all: LocalityRecord[] = [];
  for (const city of CITIES) {
    const file = path.join(DATA_DIR, `locality-data-${city.toLowerCase()}.json`);
    if (!fs.existsSync(file)) {
      console.warn(`  (skipping ${file} — file not found)`);
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${file} does not contain a JSON array`);
    }
    all.push(...(parsed as LocalityRecord[]));
  }
  return all;
}

function chunked<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunked: size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function avg(arr: number[]): number {
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}

// ───────────────────────── Entry point ─────────────────────────

main().catch((err) => {
  console.error('Prewarm failed:', err);
  process.exit(1);
});