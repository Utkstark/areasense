/**
 * Google Places API (New) — nearby-search wrapper.
 *
 * Single job: given a centroid, return up to N metro stations within some
 * radius, sorted nearest-first by straight-line distance. Used by the
 * auto-bootstrap step in scripts/pipeline/bootstrap-locality.ts (patch 9)
 * to populate a freshly discovered locality's `nearest_metros` field.
 *
 * Returns raw geographic data — NOT a MetroStation directly. MetroStation.line
 * can't be reliably populated from Places (line info isn't a structured field
 * on a subway_station place), so line resolution stays in patch 9.
 *
 * Distance is straight-line (Haversine), not walking. Walking-distance upgrade
 * (via Distance Matrix in walking mode) is left to the caller — bootstrap
 * accepts the approximation; v1 enrichment may refine it per-station.
 *
 * Mock mode: set PLACES_MOCK=true to skip live API calls and return synthetic
 * stations centered on the query coordinate. Useful for offline iteration.
 * Never set in production.
 */

import type { Coordinates } from '@/types';

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
const FIELD_MASK = 'places.id,places.displayName,places.location,places.primaryType';

// ───────────────────────── Public types & API ─────────────────────────

export interface NearbyMetroStation {
  /** displayName from Google, with trailing " Metro Station" suffix stripped */
  station: string;
  /** Google place_id — kept for downstream enrichment (walking-distance upgrade) */
  place_id: string;
  /** Where the station physically is */
  coordinates: Coordinates;
  /** Straight-line distance from the query centroid in km. NOT walking distance. */
  straight_line_km: number;
}

export interface FindNearestMetroStationsOptions {
  /** Search radius around the centroid in meters. Default 3000m (3 km). */
  radiusMeters?: number;
  /** Max stations to return, sorted nearest-first. Default 3. Capped at 20 (Google's limit). */
  maxResults?: number;
}

/**
 * Find up to N nearest metro stations to a centroid, sorted by straight-line distance.
 * Returns an empty array if there are no matches in radius (not an error).
 *
 * Throws on HTTP failure, missing env vars, or a malformed response.
 */
export async function findNearestMetroStations(
  centroid: Coordinates,
  opts: FindNearestMetroStationsOptions = {},
): Promise<NearbyMetroStation[]> {
  const radius = opts.radiusMeters ?? 3000;
  const max = Math.min(opts.maxResults ?? 3, 20);

  // Mock-mode short-circuit BEFORE env validation, so offline iteration
  // doesn't need a real API key.
  if (process.env.PLACES_MOCK === 'true') {
    return mockResults(centroid, max);
  }

  const apiKey = getApiKey();

  const body = {
    includedTypes: ['subway_station'],
    maxResultCount: max,
    rankPreference: 'DISTANCE',
    locationRestriction: {
      circle: {
        center: { latitude: centroid.lat, longitude: centroid.lng },
        radius,
      },
    },
  };

  const res = await fetch(PLACES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `places-nearby: HTTP ${res.status} ${res.statusText} from Google Places. ` +
        `Body: ${text || '(empty)'}`,
    );
  }

  const data: unknown = await res.json();
  const places = parsePlacesResponse(data);

  return places.map((p) => ({
    station: stripMetroSuffix(p.displayName.text),
    place_id: p.id,
    coordinates: { lat: p.location.latitude, lng: p.location.longitude },
    straight_line_km: round2(
      haversineKm(centroid, {
        lat: p.location.latitude,
        lng: p.location.longitude,
      }),
    ),
  }));
  // Google already sorts by distance when rankPreference=DISTANCE; no resort needed.
}

// ───────────────────────── Internals ─────────────────────────

function getApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error(
      'places-nearby: GOOGLE_MAPS_API_KEY must be set. ' +
        'For local dev, add it to .env.local. For production, set it in Vercel ' +
        'project settings.',
    );
  }
  return key;
}

/** Strip " Metro Station" / " metro station" suffix; leave names like "Saket" intact. */
function stripMetroSuffix(name: string): string {
  return name.replace(/\s+metro\s+station$/i, '').trim();
}

/** Standard Haversine; Earth radius 6371 km. */
function haversineKm(a: Coordinates, b: Coordinates): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface ParsedPlace {
  id: string;
  displayName: { text: string };
  location: { latitude: number; longitude: number };
  primaryType: string;
}

/**
 * Defensive parse of the Places response. Throws on a malformed top-level
 * shape; silently drops individual entries that are missing required fields.
 * Rationale: we'd rather skip one bad station than fail an entire bootstrap.
 */
function parsePlacesResponse(data: unknown): ParsedPlace[] {
  if (typeof data !== 'object' || data === null) {
    throw new Error('places-nearby: response is not an object');
  }
  // Google omits `places` entirely when there are zero results.
  const places = (data as { places?: unknown }).places;
  if (places === undefined) return [];
  if (!Array.isArray(places)) {
    throw new Error('places-nearby: response.places is not an array');
  }

  const out: ParsedPlace[] = [];
  for (const p of places) {
    if (typeof p !== 'object' || p === null) continue;
    const obj = p as Record<string, unknown>;

    const id = obj.id;
    const displayName = obj.displayName as Record<string, unknown> | undefined;
    const location = obj.location as Record<string, unknown> | undefined;

    if (typeof id !== 'string') continue;
    if (!displayName || typeof displayName.text !== 'string') continue;
    if (
      !location ||
      typeof location.latitude !== 'number' ||
      typeof location.longitude !== 'number'
    ) {
      continue;
    }

    // Strict primary-type filter — guards against railway stations and
    // other non-metro transit places that Google's permissive `includedTypes`
    // matching can leak through (e.g., interchanges tagged with both
    // train_station AND subway_station).
    const primaryType = obj.primaryType;
    if (typeof primaryType !== 'string' || primaryType !== 'subway_station') {
      continue;
    }

    out.push({
      id,
      displayName: { text: displayName.text },
      location: { latitude: location.latitude, longitude: location.longitude },
      primaryType,
    });
  }
  return out;
}

/**
 * Mock stations for offline iteration. Returns up to `max` stations arranged
 * around the centroid with realistic-looking distances, computed via the same
 * Haversine helper as the real path so callers can't distinguish them by shape.
 */
function mockResults(centroid: Coordinates, max: number): NearbyMetroStation[] {
  // ~0.005° latitude ≈ 556m at Indian latitudes.
  const offsets: Array<[number, number, string]> = [
    [0.005, 0.005, 'Mock Station A'],
    [-0.008, 0.003, 'Mock Station B'],
    [0.012, -0.006, 'Mock Station C'],
    [-0.015, -0.010, 'Mock Station D'],
    [0.020, 0.015, 'Mock Station E'],
  ];

  return offsets.slice(0, max).map(([dLat, dLng, name], i) => {
    const coords = { lat: centroid.lat + dLat, lng: centroid.lng + dLng };
    return {
      station: name,
      place_id: `ChIJ_mock_${String.fromCharCode(97 + i)}`,
      coordinates: coords,
      straight_line_km: round2(haversineKm(centroid, coords)),
    };
  });
}