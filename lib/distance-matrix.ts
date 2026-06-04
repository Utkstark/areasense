/**
 * Server-side wrapper around the Google Maps Distance Matrix API.
 *
 * Scope (per product-spec §5 + tech-architecture §6):
 *   - Driving mode only (v0). Traffic-aware via departure_time + traffic_model.
 *   - Batch in: up to 25 origins → 1 destination per call (Google's per-request cap).
 *   - No caching here — that lives in /lib/commute-cache.ts.
 *   - Server-side only. GOOGLE_MAPS_API_KEY must never reach the client.
 */

import type { Coordinates } from '@/types';

// ─── Public types ───────────────────────────────────────────────────────────

export type DistanceMatrixErrorReason =
  | 'config_error'      // missing/invalid key, billing not enabled — fix the setup
  | 'quota_exceeded'    // OVER_QUERY_LIMIT / OVER_DAILY_LIMIT — back off, retry later
  | 'too_many_origins'  // > MAX_ORIGINS sent in one call — caller bug
  | 'network_error'     // fetch threw (DNS, timeout, etc.) — likely transient
  | 'api_error';        // anything else Google sent us — investigate via logs

export class DistanceMatrixError extends Error {
  constructor(
    public readonly reason: DistanceMatrixErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'DistanceMatrixError';
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Google's per-request cap. The orchestrator has ~8 localities in v0; this is a defensive guard. */
export const MAX_ORIGINS = 25;

const ENDPOINT = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // UTC+5:30, no DST in India

// ─── Internal types — Google's response shape, kept private to this module ──

interface RawElement {
  status: string;
  duration?: { value: number; text: string };
  duration_in_traffic?: { value: number; text: string };
}

interface RawRow {
  elements: RawElement[];
}

interface RawResponse {
  status: string;
  rows?: RawRow[];
  error_message?: string;
}

// ─── Public: time-of-day helper ─────────────────────────────────────────────

/**
 * Given a wall-clock time in IST ("HH:MM", 24-hour) and a base date, return the Unix
 * seconds timestamp for the NEXT occurrence of that time in IST. If the time has
 * already passed today (in IST), advances to tomorrow.
 *
 * Distance Matrix rejects past departure_time values, so we always send a future one.
 *
 * Orchestrator usage: call once with `timeOfDay.out` (for the outbound leg) and once
 * with `timeOfDay.return` (for the return leg) — two separate API calls, one per leg.
 */
export function nextOccurrenceInIST(
  timeHHMM: string,
  baseDate: Date = new Date(),
): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeHHMM);
  if (!match) {
    throw new DistanceMatrixError(
      'config_error',
      `Invalid HH:MM time: "${timeHHMM}"`,
    );
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  // Shift baseDate by +5:30 so its UTC components READ as IST wall-clock components.
  const nowAsIST = new Date(baseDate.getTime() + IST_OFFSET_MS);
  const year = nowAsIST.getUTCFullYear();
  const month = nowAsIST.getUTCMonth();
  const day = nowAsIST.getUTCDate();

  // Build the target time as if it were UTC, then subtract the offset to get true UTC.
  let targetMs = Date.UTC(year, month, day, hours, minutes, 0) - IST_OFFSET_MS;

  // If that target is already in the past, jump to the same time tomorrow.
  if (targetMs <= baseDate.getTime()) {
    targetMs += 24 * 60 * 60 * 1000;
  }

  return Math.floor(targetMs / 1000);
}

/**
 * Returns five Unix-seconds timestamps for the next Mon, Tue, Wed, Thu, Fri at
 * the given IST wall-clock time. Used for Mon–Fri averaged commute computation
 * by the prewarm script, the weekly cron, and the cold-start path. All five
 * are guaranteed to be in the future (Distance Matrix rejects past departure_time).
 *
 * If today is Monday and the requested time has already passed in IST, the
 * function jumps to NEXT Monday — the returned five timestamps span Mon–Fri
 * of next week, never partially this week.
 */
export function nextFiveWeekdaysAtTimeInIST(
  timeHHMM: string,
  baseDate: Date = new Date(),
): number[] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeHHMM);
  if (!match) {
    throw new DistanceMatrixError(
      'config_error',
      `Invalid HH:MM time: "${timeHHMM}"`,
    );
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  // Same shift trick as nextOccurrenceInIST — read baseDate as IST wall-clock.
  const baseAsIST = new Date(baseDate.getTime() + IST_OFFSET_MS);
  const year = baseAsIST.getUTCFullYear();
  const month = baseAsIST.getUTCMonth();
  const day = baseAsIST.getUTCDate();
  const dayOfWeek = baseAsIST.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  // Days until next Monday. (8 - dayOfWeek) % 7 maps Mon→0, Tue→6, ..., Sun→1.
  const daysUntilMon = (8 - dayOfWeek) % 7;

  // Build Monday-at-HH:MM-IST timestamp.
  let mondayMs =
    Date.UTC(year, month, day + daysUntilMon, hours, minutes, 0) - IST_OFFSET_MS;

  // Edge case: today IS Monday and the time has already passed in IST.
  if (mondayMs <= baseDate.getTime()) {
    mondayMs += 7 * 24 * 60 * 60 * 1000;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  return [0, 1, 2, 3, 4].map((offset) =>
    Math.floor((mondayMs + offset * dayMs) / 1000),
  );
}

// ─── Public: batch duration fetch ───────────────────────────────────────────

/**
 * Fetches driving durations from each origin to the single destination at the given
 * departure time, returned in minutes (rounded), aligned with the input order.
 *
 * Per-element failures (no driving route found for one origin) return `null` for that
 * slot, NOT a thrown error — one bad origin shouldn't kill the whole batch. Top-level
 * failures (bad key, quota, network) throw DistanceMatrixError with a typed reason.
 *
 * Set DISTANCE_MATRIX_MOCK=true in the environment to short-circuit to deterministic
 * haversine-based estimates (no live API calls). Used for dev iteration only.
 */
export async function getDrivingDurations(
  origins: Coordinates[],
  destination: Coordinates,
  departureUnixSeconds: number,
): Promise<(number | null)[]> {
  if (origins.length === 0) return [];
  if (origins.length > MAX_ORIGINS) {
    throw new DistanceMatrixError(
      'too_many_origins',
      `Got ${origins.length} origins; Distance Matrix caps at ${MAX_ORIGINS} per call. ` +
        `Add chunking to the caller if you need more.`,
    );
  }

  // Dev escape hatch — gated on env var so it can't accidentally ship to production
  // unless explicitly set there.
  if (process.env.DISTANCE_MATRIX_MOCK === 'true') {
    return origins.map((o) => mockDurationMinutes(o, destination));
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new DistanceMatrixError(
      'config_error',
      'GOOGLE_MAPS_API_KEY is not set. This module is server-side only — set the ' +
        'key in .env.local (dev) or in Vercel project settings (prod).',
    );
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set(
    'origins',
    origins.map((c) => `${c.lat},${c.lng}`).join('|'),
  );
  url.searchParams.set('destinations', `${destination.lat},${destination.lng}`);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('departure_time', String(departureUnixSeconds));
  url.searchParams.set('traffic_model', 'best_guess');
  url.searchParams.set('key', apiKey);

  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DistanceMatrixError(
      'network_error',
      `Failed to reach Distance Matrix: ${message}`,
    );
  }

  if (!response.ok) {
    throw new DistanceMatrixError(
      'api_error',
      `Distance Matrix returned HTTP ${response.status}`,
    );
  }

  // Encapsulated — RawResponse stays internal; callers only see (number | null)[].
  const body = (await response.json()) as RawResponse;

  switch (body.status) {
    case 'OK':
      break;
    case 'REQUEST_DENIED':
      throw new DistanceMatrixError(
        'config_error',
        `Distance Matrix rejected the request — likely a bad/disabled API key or ` +
          `billing not enabled. Detail: ${body.error_message ?? '(none)'}`,
      );
    case 'OVER_QUERY_LIMIT':
    case 'OVER_DAILY_LIMIT':
      throw new DistanceMatrixError(
        'quota_exceeded',
        `Distance Matrix quota exceeded (${body.status}). Detail: ${
          body.error_message ?? '(none)'
        }`,
      );
    default:
      throw new DistanceMatrixError(
        'api_error',
        `Distance Matrix returned status "${body.status}". Detail: ${
          body.error_message ?? '(none)'
        }`,
      );
  }

  if (!body.rows || body.rows.length !== origins.length) {
    throw new DistanceMatrixError(
      'api_error',
      `Distance Matrix returned ${body.rows?.length ?? 0} rows for ${origins.length} origins`,
    );
  }

  return body.rows.map((row, idx) => {
    const element = row.elements?.[0];
    if (!element) {
      console.error(`[distance-matrix] origin[${idx}]: missing element`);
      return null;
    }
    if (element.status === 'OK') {
      // Prefer duration_in_traffic (what we asked for); fall back to duration in the
      // rare case Google omits traffic data for an element with an otherwise OK status.
      const seconds = element.duration_in_traffic?.value ?? element.duration?.value;
      if (typeof seconds !== 'number') {
        console.error(`[distance-matrix] origin[${idx}]: OK status but no duration value`);
        return null;
      }
      return Math.round(seconds / 60);
    }
    // ZERO_RESULTS / NOT_FOUND — no driving route for this specific origin.
    // Logged at warn; the orchestrator drops nulls during the commute filter.
    console.warn(`[distance-matrix] origin[${idx}]: ${element.status}`);
    return null;
  });
}

// ─── Private helpers ────────────────────────────────────────────────────────

/** Haversine great-circle distance in km. Used only for mock mode. */
function haversineKm(a: Coordinates, b: Coordinates): number {
  const EARTH_KM = 6371;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(x));
}

/**
 * Deterministic mock used when DISTANCE_MATRIX_MOCK=true. ~2.5 min per km of
 * straight-line distance, floored at 3 minutes — a crude but defensible Gurgaon-
 * traffic approximation that produces consistent, plausible numbers without burning
 * API quota during dev iteration.
 */
function mockDurationMinutes(origin: Coordinates, destination: Coordinates): number {
  const km = haversineKm(origin, destination);
  return Math.max(3, Math.round(km * 2.5));
}