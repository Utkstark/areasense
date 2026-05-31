/**
 * Server-side wrapper around the Google Maps Geocoding API.
 *
 * Scope (per product-spec §3 + tech-architecture §6):
 *   - Forward geocoding only (address string → coordinates). No reverse geocoding.
 *   - Region-biased to India + viewport-biased to Gurgaon by default for better
 *     matches on informal Indian addresses ("Sector 54", "Near Galleria").
 *   - No caching here — runtime caching deferred to v1 per tech-architecture §8.
 *   - Server-side only. GOOGLE_MAPS_API_KEY must never reach the client.
 *
 * Called from:
 *   - /api/office-suggest (when user picks a freeform address not matching a hub)
 *   - /lib/search-orchestrator.ts (to resolve office address before commute compute)
 */

import type { Coordinates } from '@/types';

// ─── Public types ───────────────────────────────────────────────────────────

export type GeocodeErrorReason =
  | 'config_error'    // missing/invalid key, billing/API not enabled — fix the setup
  | 'quota_exceeded'  // OVER_QUERY_LIMIT / OVER_DAILY_LIMIT — back off, retry later
  | 'not_found'       // ZERO_RESULTS — address didn't match anything (user-facing 400)
  | 'network_error'   // fetch threw (DNS, timeout, etc.) — likely transient
  | 'api_error';      // anything else Google sent us — investigate via logs

export class GeocodeError extends Error {
  constructor(
    public readonly reason: GeocodeErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'GeocodeError';
  }
}

/** A geocoded address. Top result only; the route handler decides how to handle partial_match. */
export interface GeocodeResult {
  coordinates: Coordinates;
  /** Google's cleaned-up, canonical form of the address — safe to echo back to the user. */
  formatted_address: string;
  /** Stable Google identifier for this place. Reserved for v1 caching keys. */
  place_id: string;
  /** True when Google's match was approximate (input was ambiguous or misspelled). */
  partial_match: boolean;
}

/** Axis-aligned geographic bounding box. */
export interface BoundingBox {
  sw: Coordinates;  // south-west corner (min lat, min lng)
  ne: Coordinates;  // north-east corner (max lat, max lng)
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Gurgaon bounding box, used as default viewport bias and as the city-bounds
 * check from product-spec §4.1. Roughly covers Gurgaon district from the
 * Aravalli ridge in the south to the Delhi border in the north, and from
 * Sector 1 in the west to Sohna Road in the east.
 *
 * Exported so route handlers can reuse it for isInBounds() without redefining.
 * v1+ city expansion: add MUMBAI_BBOX, BANGALORE_BBOX alongside.
 */
export const GURGAON_BBOX: BoundingBox = {
  sw: { lat: 28.36, lng: 76.94 },
  ne: { lat: 28.55, lng: 77.16 },
} as const;

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

// ─── Internal types — Google's response shape, kept private to this module ──

interface RawGeocodeResult {
  formatted_address: string;
  place_id: string;
  partial_match?: boolean;
  geometry: {
    location: { lat: number; lng: number };
  };
}

interface RawResponse {
  status: string;
  results?: RawGeocodeResult[];
  error_message?: string;
}

// ─── Public: bounds helper ──────────────────────────────────────────────────

/**
 * Returns true iff `coords` falls inside `bbox` (inclusive of edges).
 *
 * Used by route handlers to enforce product-spec §4.1's "office address must
 * geocode to a point within the active city's bounds" — geocode() returns
 * Google's top result regardless, and the caller decides whether it's in-city.
 *
 * Kept as a separate helper (rather than baked into geocode()) so the route
 * handler can return a tailored 400 ("That address is outside Gurgaon") rather
 * than a generic not_found.
 */
export function isInBounds(coords: Coordinates, bbox: BoundingBox): boolean {
  return (
    coords.lat >= bbox.sw.lat &&
    coords.lat <= bbox.ne.lat &&
    coords.lng >= bbox.sw.lng &&
    coords.lng <= bbox.ne.lng
  );
}

// ─── Public: geocode ────────────────────────────────────────────────────────

/**
 * Resolves a free-text address to coordinates plus metadata.
 *
 * Returns Google's top result only. When the result is approximate, the
 * `partial_match` flag is set — the caller can surface "Did you mean: <formatted_address>?"
 * UX based on that, but this module doesn't paginate alternatives (that's
 * autocomplete's job, in /lib/office-suggest.ts).
 *
 * Region + viewport biasing: defaults to India + Gurgaon. Pass `bounds: null`
 * explicitly to disable viewport bias (e.g., for v2 cross-city geocoding).
 *
 * Set GEOCODE_MOCK=true in the environment to short-circuit to deterministic
 * stub coordinates — known dev addresses get realistic centroids; unknown
 * inputs hash into a stable point inside the Gurgaon viewport. No live API
 * calls in mock mode.
 *
 * Throws GeocodeError with a typed `reason` on any failure. Route handlers
 * should switch on `error.reason` to choose the right HTTP status — `not_found`
 * is the only user-fixable case (400); the rest are 5xx or config bugs.
 */
export async function geocode(
  address: string,
  bounds: BoundingBox | null = GURGAON_BBOX,
): Promise<GeocodeResult> {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    throw new GeocodeError('not_found', 'Empty address');
  }

  // Dev escape hatch — gated on env var so it can't accidentally ship to production
  // unless explicitly set there. Mirrors /lib/distance-matrix.ts's DISTANCE_MATRIX_MOCK.
  if (process.env.GEOCODE_MOCK === 'true') {
    return mockGeocode(trimmed);
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new GeocodeError(
      'config_error',
      'GOOGLE_MAPS_API_KEY is not set. This module is server-side only — set the ' +
        'key in .env.local (dev) or in Vercel project settings (prod).',
    );
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set('address', trimmed);
  url.searchParams.set('region', 'in'); // ccTLD bias — improves Indian-address matches
  if (bounds) {
    // Google's `bounds` is a viewport bias (a soft hint), NOT a hard filter — results
    // can fall outside it. The route handler combines this with isInBounds() for the
    // hard city-bounds check per product-spec §4.1.
    url.searchParams.set(
      'bounds',
      `${bounds.sw.lat},${bounds.sw.lng}|${bounds.ne.lat},${bounds.ne.lng}`,
    );
  }
  url.searchParams.set('key', apiKey);

  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GeocodeError(
      'network_error',
      `Failed to reach Geocoding API: ${message}`,
    );
  }

  if (!response.ok) {
    throw new GeocodeError(
      'api_error',
      `Geocoding API returned HTTP ${response.status}`,
    );
  }

  // Encapsulated — RawResponse stays internal; callers only see GeocodeResult.
  const body = (await response.json()) as RawResponse;

  switch (body.status) {
    case 'OK':
      break;
    case 'ZERO_RESULTS':
      throw new GeocodeError(
        'not_found',
        `No geocoding results for "${trimmed}"`,
      );
    case 'REQUEST_DENIED':
      throw new GeocodeError(
        'config_error',
        `Geocoding API rejected the request — likely a bad/disabled API key or ` +
          `billing not enabled. Detail: ${body.error_message ?? '(none)'}`,
      );
    case 'OVER_QUERY_LIMIT':
    case 'OVER_DAILY_LIMIT':
      throw new GeocodeError(
        'quota_exceeded',
        `Geocoding quota exceeded (${body.status}). Detail: ${
          body.error_message ?? '(none)'
        }`,
      );
    case 'INVALID_REQUEST':
      // Malformed request — typically empty/missing address. We guard against the
      // empty case above, so reaching this is a caller bug worth surfacing.
      throw new GeocodeError(
        'api_error',
        `Geocoding API rejected the request as invalid. Detail: ${
          body.error_message ?? '(none)'
        }`,
      );
    default:
      throw new GeocodeError(
        'api_error',
        `Geocoding API returned status "${body.status}". Detail: ${
          body.error_message ?? '(none)'
        }`,
      );
  }

  const top = body.results?.[0];
  if (!top) {
    // Defensive — status OK with no results shouldn't happen per Google's docs,
    // but the type system can't prove that. Treat as not_found to be safe.
    throw new GeocodeError(
      'not_found',
      `Geocoding returned OK status but no results for "${trimmed}"`,
    );
  }

  return {
    coordinates: {
      lat: top.geometry.location.lat,
      lng: top.geometry.location.lng,
    },
    formatted_address: top.formatted_address,
    place_id: top.place_id,
    partial_match: top.partial_match ?? false,
  };
}

// ─── Private: mock mode ─────────────────────────────────────────────────────

/**
 * Known dev addresses → realistic Gurgaon centroids. Lower-cased substrings are
 * matched against the lower-cased input; first match wins. Coordinates here are
 * approximate real-world points so the orchestrator chat sees plausible commute
 * geometry in mock mode.
 *
 * Keep this list small — it's a dev convenience, not a production database. Adding
 * a hub here doesn't replace updating /data/office-hubs-gurgaon.json.
 */
const MOCK_KNOWN_ADDRESSES: ReadonlyArray<{ match: string; coords: Coordinates }> = [
  { match: 'cyber city',  coords: { lat: 28.4949, lng: 77.0890 } },
  { match: 'cyber hub',   coords: { lat: 28.4949, lng: 77.0890 } },
  { match: 'udyog vihar', coords: { lat: 28.5021, lng: 77.0855 } },
  { match: 'golf course', coords: { lat: 28.4434, lng: 77.0966 } },
  { match: 'sector 54',   coords: { lat: 28.4434, lng: 77.0966 } },
  { match: 'sohna road',  coords: { lat: 28.4089, lng: 77.0411 } },
  { match: 'mg road',     coords: { lat: 28.4796, lng: 77.0809 } },
];

/**
 * Stable, fast string hash (FNV-1a 32-bit). Used to map unknown mock inputs to a
 * deterministic point inside the Gurgaon bbox — same input always yields the same
 * coords, so dev iteration is reproducible.
 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // FNV prime multiply — Math.imul keeps it in 32-bit signed land.
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to unsigned 32-bit for downstream modulo math.
  return hash >>> 0;
}

function mockGeocode(address: string): GeocodeResult {
  const lower = address.toLowerCase();

  // 1. Known-address lookup first — gives realistic coords for the addresses you'll
  //    actually type while iterating on the orchestrator / office-suggest flows.
  for (const entry of MOCK_KNOWN_ADDRESSES) {
    if (lower.includes(entry.match)) {
      return {
        coordinates: entry.coords,
        formatted_address: `${address} (mock)`,
        place_id: `mock-known-${entry.match.replace(/\s+/g, '-')}`,
        partial_match: false,
      };
    }
  }

  // 2. Fallback — hash the input into a stable point inside GURGAON_BBOX. Two hash
  //    rotations give independent lat / lng so similar inputs don't cluster.
  const h = fnv1a(lower);
  const latFrac = (h % 10000) / 10000;
  const lngFrac = (fnv1a(lower + '#') % 10000) / 10000;
  const latSpan = GURGAON_BBOX.ne.lat - GURGAON_BBOX.sw.lat;
  const lngSpan = GURGAON_BBOX.ne.lng - GURGAON_BBOX.sw.lng;

  return {
    coordinates: {
      lat: GURGAON_BBOX.sw.lat + latFrac * latSpan,
      lng: GURGAON_BBOX.sw.lng + lngFrac * lngSpan,
    },
    formatted_address: `${address} (mock, hashed)`,
    place_id: `mock-hash-${h.toString(16)}`,
    partial_match: true, // flag hash-based results so dev UI can spot them
  };
}