import type { Coordinates, CommuteMode } from '@/types';

const MAPBOX_API_BASE = 'https://api.mapbox.com/isochrone/v1/mapbox';
const MAPBOX_TIME_CAP_MINUTES = 60;

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export type IsochroneErrorReason =
  | 'config_error'      // missing/invalid token
  | 'quota_exceeded'    // HTTP 429
  | 'invalid_input'     // Mapbox rejected coords/contour (caller bug)
  | 'network_error'     // fetch threw
  | 'api_error';        // anything else

export class IsochroneError extends Error {
  readonly reason: IsochroneErrorReason;
  constructor(reason: IsochroneErrorReason, message: string) {
    super(message);
    this.name = 'IsochroneError';
    this.reason = reason;
  }
}

export interface IsochroneResult {
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  // Present iff caller's maxMinutes exceeded the Mapbox 60-min cap. Carries the
  // ORIGINAL maxMinutes so the UI can render: "Map only shows the 60-min reachable
  // area. Your full {X}-min results are in the list."
  clamped_at_minutes?: number;
}

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

/**
 * Map our CommuteMode to Mapbox's profile name.
 * v0 supports only 'driving'. Adding 'driving-traffic' / 'walking' / 'cycling'
 * in v1 means adding a case here — no change to the wrapper signature.
 */
function toMapboxProfile(mode: CommuteMode): string {
  switch (mode) {
    case 'driving':
      return 'driving';
    default: {
      // Exhaustiveness guard: a new CommuteMode added without a case here
      // will fail to compile.
      const _exhaustive: never = mode;
      throw new IsochroneError(
        'invalid_input',
        `Unsupported commute mode: ${String(_exhaustive)}`,
      );
    }
  }
}

/**
 * Synthetic 16-sided polygon centered on the origin, used when ISOCHRONE_MOCK=true.
 * Radius ≈ maxMinutes × 0.5 km (rough Gurgaon driving heuristic).
 * Produces a circle in real-world km (not in degrees) by scaling lat/lng deltas
 * separately — a degree of longitude at 28°N (Gurgaon) is shorter than a degree
 * of latitude, so equal degree-offsets would visibly squash the shape.
 */
function mockIsochrone(origin: Coordinates, maxMinutes: number): IsochroneResult {
  const clampedMinutes = Math.min(maxMinutes, MAPBOX_TIME_CAP_MINUTES);
  const wasClamped = maxMinutes > MAPBOX_TIME_CAP_MINUTES;
  const radiusKm = clampedMinutes * 0.5;

  // 1° latitude ≈ 111 km worldwide.
  // 1° longitude ≈ 111 × cos(latitude) km — shrinks toward the poles.
  const latDegPerKm = 1 / 111;
  const lngDegPerKm = 1 / (111 * Math.cos((origin.lat * Math.PI) / 180));
  const dLat = radiusKm * latDegPerKm;
  const dLng = radiusKm * lngDegPerKm;

  const N_SIDES = 16;

  // Compute the first point outside the loop so the ring-closing push references
  // a definitely-defined variable, not an indexed lookup (which TS sees as
  // possibly-undefined under noUncheckedIndexedAccess).
  const firstPoint: GeoJSON.Position = [
    origin.lng + dLng * Math.cos(0),
    origin.lat + dLat * Math.sin(0),
  ];

  const ring: GeoJSON.Position[] = [firstPoint];
  for (let i = 1; i < N_SIDES; i++) {
    const angle = (i / N_SIDES) * 2 * Math.PI;
    ring.push([
      origin.lng + dLng * Math.cos(angle),
      origin.lat + dLat * Math.sin(angle),
    ]);
  }
  // GeoJSON LinearRing requires first point === last point.
  ring.push(firstPoint);

  const geometry: GeoJSON.Polygon = {
    type: 'Polygon',
    coordinates: [ring],
  };

  return wasClamped
    ? { geometry, clamped_at_minutes: maxMinutes }
    : { geometry };
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch a reachable-area polygon for a given origin, time budget, and travel mode.
 *
 * Output is DECORATIVE — used only for the map overlay. The orchestrator must NOT
 * derive per-locality commute times from this polygon; those come from
 * `/lib/distance-matrix.ts`. (See product-spec §5 on why these two stay separate.)
 *
 * If `maxMinutes > 60`, the result is clamped to 60 (Mapbox's hard cap) and the
 * caller's original value is returned in `clamped_at_minutes` for UI surfacing.
 *
 * On any failure, throws `IsochroneError`. The orchestrator is expected to catch
 * and degrade gracefully (return a 200 with the polygon omitted) — see
 * tech-architecture.md §10.
 */
export async function getIsochrone(
  origin: Coordinates,
  maxMinutes: number,
  mode: CommuteMode,
): Promise<IsochroneResult> {
  if (maxMinutes <= 0) {
    throw new IsochroneError(
      'invalid_input',
      `maxMinutes must be > 0, got ${maxMinutes}`,
    );
  }

  // Offline-dev escape hatch — skip network entirely.
  if (process.env.ISOCHRONE_MOCK === 'true') {
    return mockIsochrone(origin, maxMinutes);
  }

  const token = process.env.MAPBOX_SECRET_TOKEN;
  if (!token) {
    throw new IsochroneError(
      'config_error',
      'MAPBOX_SECRET_TOKEN is not set',
    );
  }

  // Clamp + remember the original for the UI flag.
  let contourMinutes = maxMinutes;
  let clamped_at_minutes: number | undefined;
  if (maxMinutes > MAPBOX_TIME_CAP_MINUTES) {
    contourMinutes = MAPBOX_TIME_CAP_MINUTES;
    clamped_at_minutes = maxMinutes;
    console.warn(
      `[isochrone] maxMinutes ${maxMinutes} exceeds Mapbox cap of ${MAPBOX_TIME_CAP_MINUTES}; clamping`,
    );
  }

  const profile = toMapboxProfile(mode);
  const url = new URL(
    `${MAPBOX_API_BASE}/${profile}/${origin.lng},${origin.lat}`,
  );
  url.searchParams.set('contours_minutes', String(contourMinutes));
  url.searchParams.set('polygons', 'true');
  // denoise=0 keeps ALL reachable pockets. Mapbox's default (1.0) would silently
  // drop smaller disjoint areas — but those represent real places the user can
  // reach (across a highway, around a hill), so we explicitly keep them.
  url.searchParams.set('denoise', '0');
  url.searchParams.set('access_token', token);

  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new IsochroneError(
      'network_error',
      `Failed to reach Mapbox Isochrone: ${message}`,
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new IsochroneError(
        'config_error',
        `Mapbox auth failed (HTTP ${response.status})`,
      );
    }
    if (response.status === 429) {
      throw new IsochroneError(
        'quota_exceeded',
        'Mapbox rate limit hit (HTTP 429)',
      );
    }
    if (response.status >= 400 && response.status < 500) {
      throw new IsochroneError(
        'invalid_input',
        `Mapbox rejected the request (HTTP ${response.status})`,
      );
    }
    throw new IsochroneError(
      'api_error',
      `Mapbox returned HTTP ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new IsochroneError(
      'api_error',
      `Mapbox response was not valid JSON: ${message}`,
    );
  }

  // Narrow the unknown payload step by step. Mapbox returns a FeatureCollection;
  // with a single contour, features[0] holds the polygon (or multipolygon).
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('features' in payload) ||
    !Array.isArray((payload as { features: unknown }).features) ||
    (payload as { features: unknown[] }).features.length === 0
  ) {
    throw new IsochroneError(
      'api_error',
      'Mapbox response missing or empty features array',
    );
  }

  const firstFeature = (payload as { features: Array<{ geometry?: unknown }> })
    .features[0];
  const geometry = firstFeature?.geometry;

  if (
    !geometry ||
    typeof geometry !== 'object' ||
    !('type' in geometry) ||
    (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')
  ) {
    const observedType =
      geometry && typeof geometry === 'object' && 'type' in geometry
        ? String((geometry as { type: unknown }).type)
        : 'unknown';
    throw new IsochroneError(
      'api_error',
      `Expected Polygon or MultiPolygon geometry; got ${observedType}`,
    );
  }

  // Verified above that geometry.type is 'Polygon' | 'MultiPolygon'.
  const polygon = geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;

  return clamped_at_minutes !== undefined
    ? { geometry: polygon, clamped_at_minutes }
    : { geometry: polygon };
}