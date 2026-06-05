/**
 * scripts/prewarm-commute-cache.ts
 *
 * Day-1 cache seeding (tech-architecture §8 + §12). For every curated office
 * hub, computes the Mon–Fri averaged commute matrix at default times (09:00
 * outbound, 18:00 return), writes each entry to Upstash Redis via
 * /lib/commute-cache.ts, then snapshots the full Redis state to
 * /data/commute-cache.json.
 *
 * Idempotent: re-runs overwrite existing entries with fresh `computed_at`.
 * Manual-only — never auto-runs on deploy (see tech-architecture §13.3).
 *
 * Usage:
 *   npm run build:cache              # real run — Google + Redis + JSON
 *   npm run build:cache -- --dry-run # print plan; no API, no writes
 */

import fs from 'node:fs';
import path from 'node:path';

import type { CacheKey, City, LocalityRecord, OfficeHub } from '@/types';

import { computeCommuteMatrix } from '@/lib/commute-compute';
import {
  roundOfficeCoords,
  set as cacheSet,
  snapshot as cacheSnapshot,
} from '@/lib/commute-cache';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'commute-cache.json');

const DEFAULT_OUTBOUND_TIME = '09:00';
const DEFAULT_RETURN_TIME = '18:00';

const CITIES: City[] = ['Gurgaon', 'Delhi'];

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AreaSense — commute cache prewarm');
  console.log(
    `  Mode: ${dryRun ? 'DRY RUN (no API calls, no writes)' : 'LIVE'}`,
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
        'matrices. Populate data/locality-data-*.json before running in production.\n',
    );
  }

  const startMs = Date.now();
  let totalElements = 0;
  const allWarnings: string[] = [];

  for (let i = 0; i < hubs.length; i++) {
    const hub = hubs[i]!;
    console.log(`[${i + 1}/${hubs.length}] ${hub.name} (${hub.city})`);

    const { matrix, elements, warnings } = await computeCommuteMatrix(
      hub.centroid,
      DEFAULT_OUTBOUND_TIME,
      DEFAULT_RETURN_TIME,
      localities,
      { dryRun },
    );
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

function loadHubs(): OfficeHub[] {
  const all: OfficeHub[] = [];
  for (const city of CITIES) {
    const file = path.join(DATA_DIR, `office-hubs-${city.toLowerCase()}.json`);
    if (!fs.existsSync(file)) {
      console.warn(`  (skipping ${file} — file not found)`);
      continue;
    }
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim() === '') {
      console.warn(`  (skipping ${file} — file is empty)`);
      continue;
    }
    const parsed = JSON.parse(raw) as unknown;
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
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim() === '') {
      console.warn(`  (skipping ${file} — file is empty)`);
      continue;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${file} does not contain a JSON array`);
    }
    all.push(...(parsed as LocalityRecord[]));
  }
  return all;
}

main().catch((err) => {
  console.error('Prewarm failed:', err);
  process.exit(1);
});