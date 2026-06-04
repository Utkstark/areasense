/**
 * Runtime commute cache — backed by Upstash Redis.
 *
 * Filter-independent key: (office_coords_rounded_100m, outbound_time, return_time).
 * Value: Mon–Fri averaged commute matrix to every known locality.
 *
 * Public API:
 *   - get / getRaw / set / markRecomputed   (per-entry ops)
 *   - listKeys / deleteEntry / snapshot     (cron + tooling ops)
 *   - roundOfficeCoords                     (utility — callers must round before keying)
 *
 * Lifecycle: cold-start path calls set(); request path calls get(); the weekly
 * cron uses listKeys + getRaw + markRecomputed + deleteEntry to refresh & prune.
 * See tech-architecture §8 for the full contract.
 */

import { Redis } from '@upstash/redis';

import { CACHE_CONFIG } from '@/types';
import type {
  CacheKey,
  CommuteCacheEntry,
  CommuteMatrixEntry,
  Coordinates,
} from '@/types';

// ───────────────────────── Redis client (lazy) ─────────────────────────
//
// Lazy so module import doesn't require env vars (lets pure-utility tests and
// the typecheck pass without Upstash credentials). First real call validates
// env and instantiates; subsequent calls reuse the cached client.

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      'commute-cache: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set. ' +
        'Install the Upstash integration via Vercel Marketplace, then run ' +
        '`vercel env pull .env.local` locally to sync the credentials.',
    );
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

// ───────────────────────── Key namespacing ─────────────────────────────
//
// The `v1` segment is cheap insurance against future schema changes — flip to
// v2, let v1 entries expire naturally via the cron's prune step. No migration
// script needed.

const KEY_PREFIX = 'commute:v1';
const KEY_PATTERN = `${KEY_PREFIX}:*`;

/**
 * Serialize a CacheKey to its Redis string form.
 * toFixed(6) ≈ 11cm precision — far below the 100m rounding granularity, so
 * two equivalent rounded coords always produce the same string.
 */
function serializeKey(key: CacheKey): string {
  return [
    KEY_PREFIX,
    key.office_coords_rounded.lat.toFixed(6),
    key.office_coords_rounded.lng.toFixed(6),
    key.outbound_time,
    key.return_time,
  ].join(':');
}

/** Inverse of serializeKey. Returns null for malformed strings. */
function parseKey(serialized: string): CacheKey | null {
  const parts = serialized.split(':');
  if (parts.length !== 6) return null;

  // Destructuring lets TS narrow each part from `string | undefined`
  // (the noUncheckedIndexedAccess shape) to `string` once we've checked existence.
  const [prefix, version, latStr, lngStr, outTime, returnTime] = parts;
  if (!prefix || !version || !latStr || !lngStr || !outTime || !returnTime) {
    return null;
  }

  if (prefix !== 'commute' || version !== 'v1') return null;

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // Light HH:MM sanity check — full validation is the API boundary's job.
  if (!/^\d{2}:\d{2}$/.test(outTime)) return null;
  if (!/^\d{2}:\d{2}$/.test(returnTime)) return null;

  return {
    office_coords_rounded: { lat, lng },
    outbound_time: outTime,
    return_time: returnTime,
  };
}

// ───────────────────────── 100m coordinate rounding ────────────────────

/**
 * Round office coordinates to the cache's granularity
 * (CACHE_CONFIG.OFFICE_COORD_ROUND_METERS = 100m).
 *
 * Callers must round before constructing a CacheKey. The CacheKey type
 * encodes this contract via the field name `office_coords_rounded`.
 *
 * Uses a latitude-aware degree-to-meters conversion so the cell size stays
 * ~100m at Indian latitudes (where 1° longitude ≈ 97.5 km, not 111 km).
 */
export function roundOfficeCoords(coords: Coordinates): Coordinates {
  const METERS_PER_DEGREE_LAT = 111_320;
  const meters = CACHE_CONFIG.OFFICE_COORD_ROUND_METERS;

  const latStep = meters / METERS_PER_DEGREE_LAT;
  const lngStep =
    meters / (METERS_PER_DEGREE_LAT * Math.cos((coords.lat * Math.PI) / 180));

  return {
    lat: Math.round(coords.lat / latStep) * latStep,
    lng: Math.round(coords.lng / lngStep) * lngStep,
  };
}

// ───────────────────────── Public API ──────────────────────────────────

/**
 * Read an entry and refresh its `last_accessed` to now.
 *
 * USE FROM THE REQUEST PATH. Updating last_accessed is what tells the cron
 * "this office still matters" — without it, frequently-read entries would
 * look idle and get pruned.
 *
 * The touch is awaited (not fire-and-forget) so the returned entry's
 * last_accessed always reflects what's in Redis. Cost is one extra round-trip
 * on hit, but cache hits are the hot path the user is paying ~50ms for total —
 * 5ms more for an honest write is fine.
 */
export async function get(key: CacheKey): Promise<CommuteCacheEntry | null> {
  const redis = getRedis();
  const k = serializeKey(key);

  const entry = await redis.get<CommuteCacheEntry>(k);
  if (!entry) return null;

  const touched: CommuteCacheEntry = {
    ...entry,
    last_accessed: new Date().toISOString(),
  };
  await redis.set(k, touched);
  return touched;
}

/**
 * Read an entry WITHOUT updating `last_accessed`.
 *
 * USE FROM THE CRON. The cron inspects entries to decide what to refresh and
 * what to prune — it must not extend their lifetimes simply by looking at them.
 */
export async function getRaw(key: CacheKey): Promise<CommuteCacheEntry | null> {
  const redis = getRedis();
  return await redis.get<CommuteCacheEntry>(serializeKey(key));
}

/**
 * Write a fresh entry: both `computed_at` and `last_accessed` set to now.
 *
 * USE FROM THE COLD-START PATH and from the prewarm script. The cold-start
 * writes after the live Distance Matrix computation completes; the prewarm
 * writes during day-1 seeding.
 */
export async function set(
  key: CacheKey,
  matrix: CommuteMatrixEntry[],
): Promise<void> {
  const redis = getRedis();
  const now = new Date().toISOString();
  const entry: CommuteCacheEntry = {
    key,
    matrix,
    computed_at: now,
    last_accessed: now,
  };
  await redis.set(serializeKey(key), entry);
}

/**
 * Update `computed_at` and `matrix` after a cron-driven recompute, leaving
 * `last_accessed` untouched.
 *
 * USE FROM THE CRON. Recomputing an entry must NOT extend its lifetime —
 * lifetime is a function of real user reads, not of background refresh work.
 *
 * No-op if the entry was deleted between the cron's listKeys() and this call
 * (race with the prune step in the same cron run, or with a parallel job).
 * Returns true if updated, false if the entry was already gone.
 */
export async function markRecomputed(
  key: CacheKey,
  matrix: CommuteMatrixEntry[],
): Promise<boolean> {
  const redis = getRedis();
  const k = serializeKey(key);

  const existing = await redis.get<CommuteCacheEntry>(k);
  if (!existing) return false;

  const updated: CommuteCacheEntry = {
    ...existing,
    matrix,
    computed_at: new Date().toISOString(),
    // last_accessed intentionally NOT updated.
  };
  await redis.set(k, updated);
  return true;
}

/**
 * Enumerate every cache key currently in Redis.
 *
 * Uses SCAN (cursor pagination) — never KEYS, which blocks Redis on large
 * keyspaces and is rate-limited harder by Upstash.
 *
 * Malformed keys (e.g., schema drift from a future v2 prefix) are silently
 * skipped — they're not the cron's responsibility to clean up.
 */
export async function listKeys(): Promise<CacheKey[]> {
  const redis = getRedis();
  const out: CacheKey[] = [];

  let cursor = '0';
  do {
    const result = await redis.scan(cursor, {
      match: KEY_PATTERN,
      count: 100,
    });
    cursor = String(result[0]);

    for (const raw of result[1]) {
      const parsed = parseKey(raw);
      if (parsed) out.push(parsed);
    }
  } while (cursor !== '0');

  return out;
}

/**
 * Delete one entry. USE FROM THE CRON'S PRUNE STEP.
 *
 * Named `deleteEntry` rather than `delete` because the latter is a reserved
 * word in some JS contexts and confuses dependent tooling.
 */
export async function deleteEntry(key: CacheKey): Promise<void> {
  const redis = getRedis();
  await redis.del(serializeKey(key));
}

/**
 * Full snapshot of the cache, keyed by serialized Redis key.
 *
 * USE FROM THE CRON (for /data/commute-cache.json export) and from the
 * prewarm script (for post-seed verification). Returns an empty object if
 * the cache is empty.
 *
 * The serialized key is preserved as the JSON key (rather than re-parsed
 * into a nested CacheKey) so the JSON file is human-readable and stable
 * across diff-based git history.
 */
export async function snapshot(): Promise<Record<string, CommuteCacheEntry>> {
  const redis = getRedis();
  const out: Record<string, CommuteCacheEntry> = {};

  let cursor = '0';
  do {
    const result = await redis.scan(cursor, {
      match: KEY_PATTERN,
      count: 100,
    });
    cursor = String(result[0]);

    const keys = result[1];
    if (keys.length === 0) continue;

    // Batch fetch — much cheaper than N round-trips.
    const values = await redis.mget<(CommuteCacheEntry | null)[]>(...keys);
    keys.forEach((k, i) => {
      const v = values[i];
      if (v != null) out[k] = v;
    });
  } while (cursor !== '0');

  return out;
}