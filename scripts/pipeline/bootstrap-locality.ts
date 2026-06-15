/**
 * scripts/pipeline/bootstrap-locality.ts
 *
 * Tier 3 of the locality resolution chain (product-spec §10.3). Given a
 * (city, raw "Locality/Sector") value that has no manual mapping AND no
 * existing canonical record, attempt to produce a LocalityRecord from
 * Google Geocoding + Google Places nearby search.
 *
 * Returns a discriminated union — successful bootstraps yield a record;
 * skipped values yield a typed skip reason. The pipeline batches over hundreds
 * of values, so we never throw for expected-skip cases (low confidence,
 * out-of-bounds, etc.); skipped values feed a "needs manual review" list
 * that the operator adds to /data/locality-mapping.json by hand.
 *
 * Cost: ~2 Google API calls per bootstrap (1 Geocoding + 1 Places nearby).
 * One-time per new locality at pipeline build, effectively free.
 */

import type {
  City,
  Coordinates,
  LocalityId,
  LocalityRecord,
  MetroStation,
} from '@/types';

import {
  geocode,
  GeocodeError,
  GURGAON_BBOX,
  DELHI_BBOX,
  isInBounds,
  type BoundingBox,
} from '@/lib/geocode';

import { findNearestMetroStations } from '@/lib/places-nearby';

// ───────────────────────── Constants ─────────────────────────

/**
 * Radius (km) for metro-station nearby-search during locality bootstrap.
 * NCR has many residential pockets with the nearest metro 5–8 km out, and
 * legitimately some further still. 15 km comfortably covers the realistic
 * range.
 *
 * Note: this is the SEARCH radius for the bootstrap step (prove a locality
 * has *some* nearest metro to record). The metro proximity SCORING window
 * is separate and tighter — `SCORING_CONFIG.METRO_D_MAX_METERS = 2000`
 * (data-model §9). Localities whose nearest metro lands beyond 2 km simply
 * get `metro_score = 0` at search time — no false amenity claim.
 */
const BOOTSTRAP_METRO_RADIUS_KM = 15;

// ───────────────────────── Public types & API ─────────────────────────

export interface BootstrapInput {
  city: City;
  /** Raw "Locality/Sector" value from the source CSV, e.g. "Sector 54" or "Ghitorni" */
  localityValue: string;
}

export type BootstrapSkipReason =
  | 'geocode_failed'    // GeocodeError thrown — bad input, quota, config, etc.
  | 'low_confidence'    // Google returned a partial_match — input was ambiguous
  | 'out_of_bounds'     // Centroid fell outside the city's bbox — wrong city matched
  | 'no_metros_found';  // No metros within 3 km — data-model §5 requires ≥ 1

export interface BootstrapSkip {
  reason: BootstrapSkipReason;
  detail: string;
}

export type BootstrapOutcome =
  | { ok: true; record: LocalityRecord; warnings: string[] }
  | { ok: false; skip: BootstrapSkip };

/**
 * Attempt to bootstrap a LocalityRecord. See module docstring for behavior.
 */
export async function bootstrapLocality(
  input: BootstrapInput,
): Promise<BootstrapOutcome> {
  const { city } = input;
  const trimmed = input.localityValue.trim();

  if (trimmed.length === 0) {
    return skip('geocode_failed', 'Empty locality value');
  }

  const bbox = bboxFor(city);

  // ─── Step 1: Geocode ──────────────────────────────────────────────────
  const query = `${trimmed}, ${city}`;
  let geocoded;
  try {
    geocoded = await geocode(query, bbox);
  } catch (err) {
    if (err instanceof GeocodeError) {
      return skip('geocode_failed', `${err.reason}: ${err.message}`);
    }
    throw err; // Genuinely unexpected — let the pipeline halt and inspect.
  }

  // ─── Step 2: Confidence check ─────────────────────────────────────────
  if (geocoded.partial_match) {
    return skip(
      'low_confidence',
      `partial match for "${query}" → "${geocoded.formatted_address}"`,
    );
  }

  // ─── Step 3: Bounds check ─────────────────────────────────────────────
  // Google's `bounds` parameter is a soft bias, not a hard filter — the
  // result can still fall outside it (e.g., "Sector 12" can match Dwarka
  // in Delhi instead of Gurgaon). The explicit check catches this.
  if (!isInBounds(geocoded.coordinates, bbox)) {
    return skip(
      'out_of_bounds',
      `${formatCoords(geocoded.coordinates)} outside ${city} bbox — ` +
        `geocoder matched "${geocoded.formatted_address}"`,
    );
  }

  // ─── Step 4: Find nearby metros ───────────────────────────────────────
  const nearby = await findNearestMetroStations(geocoded.coordinates, {
    radiusMeters: BOOTSTRAP_METRO_RADIUS_KM * 1000,
  });
  if (nearby.length === 0) {
    return skip(
      'no_metros_found',
      `no metros within ${BOOTSTRAP_METRO_RADIUS_KM} km of ${formatCoords(geocoded.coordinates)}`,
    );
  }

  // ─── Step 5: Build the record ─────────────────────────────────────────
  // `line` is intentionally undefined per data-model §5 — Google Places
  // doesn't expose line info structurally. `distance_km` is straight-line
  // from /lib/places-nearby.ts, not walking.
  const nearest_metros: MetroStation[] = nearby.map((station) => ({
    station: station.station,
    distance_km: station.straight_line_km,
  }));

  const record: LocalityRecord = {
    id: generateLocalityId(city, trimmed),
    name: trimmed,
    city,
    centroid: geocoded.coordinates,
    // geometry intentionally omitted — auto-bootstrapped localities render as
    // a centroid marker on the map (data-model §5).
    source: 'auto-bootstrap',
    rent_ranges: {},        // Populated by Step 4 of the pipeline (rent compute).
    rent_sample_sizes: {},  // Same.
    nearest_metros,
    societies: [],          // Populated by Step 6 of the pipeline (society aggregation).
  };

  // No warnings emitted in v0 — `source: 'auto-bootstrap'` on the record itself
  // signals the structural caveats (unknown metro lines, no polygon, no rent yet).
  // Future pipeline checks can populate this field if needed.
  return { ok: true, record, warnings: [] };
}

// ───────────────────────── Helpers (exported for tests/debugging) ─────────────────────────

/**
 * Generate a LocalityId from a (city, raw value).
 *
 * Convention (matches data-model.md §12 example "gur-sec-54"):
 *   - City prefix: 'gur-' / 'del-'
 *   - "Sector N" → "sec-N" (handles both "Sector 54" and "Sector-54")
 *   - Everything else: lowercased, non-alphanumeric runs collapsed to hyphens
 *
 * Examples:
 *   ("Gurgaon", "Sector 54")       → "gur-sec-54"
 *   ("Delhi",   "Ghitorni")         → "del-ghitorni"
 *   ("Gurgaon", "DLF Phase 4")     → "gur-dlf-phase-4"
 *   ("Delhi",   "Dwarka Sector 12") → "del-dwarka-sec-12"
 */
export function generateLocalityId(city: City, value: string): LocalityId {
  return `${cityPrefix(city)}-${slugifyLocalityValue(value)}` as LocalityId;
}

function cityPrefix(city: City): string {
  // Switch (not ternary) so v1 adding 'Mumbai' fails the build until we
  // pick a prefix here, rather than silently producing a weird ID.
  switch (city) {
    case 'Gurgaon':
      return 'gur';
    case 'Delhi':
      return 'del';
  }
}

function slugifyLocalityValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bsector[\s-]+(\d+)/g, 'sec-$1')  // "sector 54" or "sector-54" → "sec-54"
    .replace(/[^a-z0-9]+/g, '-')                 // any other run of non-alnum → hyphen
    .replace(/^-+|-+$/g, '');                    // trim leading/trailing hyphens
}

// ───────────────────────── Internals ─────────────────────────

function bboxFor(city: City): BoundingBox {
  switch (city) {
    case 'Gurgaon':
      return GURGAON_BBOX;
    case 'Delhi':
      return DELHI_BBOX;
  }
}

function formatCoords(c: Coordinates): string {
  return `(${c.lat.toFixed(4)}, ${c.lng.toFixed(4)})`;
}

function skip(reason: BootstrapSkipReason, detail: string): BootstrapOutcome {
  return { ok: false, skip: { reason, detail } };
}