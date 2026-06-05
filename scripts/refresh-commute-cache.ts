/**
 * scripts/refresh-commute-cache.ts
 *
 * What the weekly GitHub Actions cron runs (tech-architecture §8 + §13.4).
 *
 * For each entry in Upstash Redis:
 *   - if last_accessed > 4 weeks ago → PRUNE  (delete from Redis)
 *   - else if computed_at > 7 days old → REFRESH (recompute via Distance Matrix,
 *       markRecomputed; last_accessed intentionally untouched)
 *   - else → SKIP (still fresh)
 *
 * After processing all entries, snapshot remaining Redis state to
 * data/commute-cache.json. The cron's commit step (patch 12 YAML) then pushes
 * the JSON to main; Vercel auto-deploys harmlessly.
 *
 * Idempotent and safe to re-run. --dry-run flag prints the plan without
 * making API calls, Redis writes, or JSON writes.
 *
 * Usage (from CI):       tsx scripts/refresh-commute-cache.ts
 * Usage (manual debug):  npm run refresh:cache -- --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';

import type { CacheKey, City, LocalityRecord } from '@/types';
import { CACHE_CONFIG } from '@/types';

import { computeCommuteMatrix } from '@/lib/commute-compute';
import {
  deleteEntry,
  getRaw,
  listKeys,
  markRecomputed,
  snapshot as cacheSnapshot,
} from '@/lib/commute-cache';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'commute-cache.json');

const CITIES: City[] = ['Gurgaon', 'Delhi'];

// Per tech-architecture §8: refresh entries computed >7 days ago that are
// still actively read; prune entries untouched for the cache TTL window.
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_THRESHOLD_MS =
  CACHE_CONFIG.CACHE_TTL_WEEKS * 7 * 24 * 60 * 60 * 1000;

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AreaSense — commute cache refresh (weekly cron)');
  console.log(
    `  Mode: ${dryRun ? 'DRY RUN (no API calls, no writes)' : 'LIVE'}`,
  );
  console.log('═══════════════════════════════════════════════════════════');

  const localities = loadLocalities();
  const keys = await listKeys();

  console.log(`\nLocalities loaded: ${localities.length}`);
  console.log(`Cache entries in Redis: ${keys.length}\n`);

  if (keys.length === 0) {
    console.log('Nothing in cache. Snapshotting empty state and exiting.');
    if (!dryRun) await writeSnapshot();
    return;
  }

  const now = Date.now();
  let refreshed = 0;
  let pruned = 0;
  let skippedFresh = 0;
  let skippedMissing = 0;
  let totalElements = 0;
  const allWarnings: string[] = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const label = describeKey(key);
    console.log(`[${i + 1}/${keys.length}] ${label}`);

    const entry = await getRaw(key);
    if (!entry) {
      console.log('    (entry vanished between listKeys and getRaw — skipped)');
      skippedMissing++;
      continue;
    }

    const accessedAgoMs = now - Date.parse(entry.last_accessed);
    const computedAgoMs = now - Date.parse(entry.computed_at);

    if (accessedAgoMs > PRUNE_THRESHOLD_MS) {
      console.log(
        `    PRUNE — last_accessed ${formatAge(accessedAgoMs)} ago (> ${CACHE_CONFIG.CACHE_TTL_WEEKS}wk)`,
      );
      if (!dryRun) await deleteEntry(key);
      pruned++;
      continue;
    }

    if (computedAgoMs > STALE_THRESHOLD_MS) {
      console.log(
        `    REFRESH — computed ${formatAge(computedAgoMs)} ago (> 7d), recomputing`,
      );
      const { matrix, elements, warnings } = await computeCommuteMatrix(
        entry.key.office_coords_rounded,
        entry.key.outbound_time,
        entry.key.return_time,
        localities,
        { dryRun },
      );
      totalElements += elements;
      allWarnings.push(...warnings.map((w) => `  ${label}: ${w}`));

      if (!dryRun) {
        const ok = await markRecomputed(key, matrix);
        if (!ok) {
          // Race: entry deleted between getRaw and markRecomputed. Acceptable.
          console.log('    (entry deleted mid-refresh — no-op)');
        }
      }
      refreshed++;
      continue;
    }

    console.log(`    FRESH — computed ${formatAge(computedAgoMs)} ago, skipping`);
    skippedFresh++;
  }

  if (!dryRun) {
    console.log('\nSnapshotting Redis → data/commute-cache.json …');
    await writeSnapshot();
  }

  const summary = [
    `  Refreshed: ${refreshed}`,
    `  Pruned:    ${pruned}`,
    `  Fresh:     ${skippedFresh}`,
    skippedMissing > 0 ? `  Missing:   ${skippedMissing}` : null,
    `  Total Distance Matrix elements: ${totalElements}`,
  ].filter(Boolean);

  console.log('═══════════════════════════════════════════════════════════');
  console.log(summary.join('\n'));
  if (allWarnings.length > 0) {
    console.log(`  Warnings (${allWarnings.length}):`);
    for (const w of allWarnings) console.log(w);
  }
  console.log('═══════════════════════════════════════════════════════════');
}

async function writeSnapshot(): Promise<void> {
  const snap = await cacheSnapshot();
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
  console.log(`Snapshot written: ${Object.keys(snap).length} entries.`);
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

function describeKey(key: CacheKey): string {
  const lat = key.office_coords_rounded.lat.toFixed(4);
  const lng = key.office_coords_rounded.lng.toFixed(4);
  return `(${lat}, ${lng}) @ ${key.outbound_time}/${key.return_time}`;
}

function formatAge(ms: number): string {
  const days = ms / (24 * 60 * 60 * 1000);
  if (days >= 1) return `${days.toFixed(1)}d`;
  const hours = ms / (60 * 60 * 1000);
  return `${hours.toFixed(1)}h`;
}

main().catch((err) => {
  console.error('Refresh failed:', err);
  process.exit(1);
});