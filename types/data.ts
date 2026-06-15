// Static data record types — the shape of curated locality data on disk.
// Source of truth: data-model.md §5 and §6.

import type { Polygon, MultiPolygon } from 'geojson';
import type {
  BHK,
  City,
  Coordinates,
  LocalityId,
  LocalitySource,
  OfficeHubId,
  SocietyId,
  TenantPreferenceSignal,
} from './primitives';

// Metro station reference (used inside a locality).
export interface MetroStation {
  station: string;       // "Sikanderpur" — canonical capitalization
  line?: string;          // "Yellow Line" | "Rapid Metro" — canonical capitalization
                         // (canonicalized at pipeline output; not a strict union
                         //  because metro lines are an evolving domain — new
                         //  lines open routinely.)
  distance_km: number;   // walking distance from locality centroid
}

// Per-BHK rent estimate for a single society (median + sample size).
// Chat 1d decision: emit median (not average) for robustness; emit for any
// sample size (no minimum threshold); per-BHK split (option B) over overall
// (option A) so the number aligns with what the user searched for. The
// sample_size is surfaced so the UI can render confidence ("based on 2
// listings") and gray out very thin cells if desired.
export interface SocietyBhkRentEstimate {
  median:      number;  // INR/month, base rent (excludes maintenance), integer
  sample_size: number;  // ≥ 1
}

// Society-level rent estimates keyed by BHK. Named alias rather than
// inlining Partial<Record<BHK, ...>> at the use site to dodge the multi-
// line generic parser quirk we hit in chats 1b and 1d.
export type SocietyRentEstimateByBhk = Partial<Record<BHK, SocietyBhkRentEstimate>>;

// A gated society / named residential complex.
export interface Society {
  id:           SocietyId;
  name:         string;                          // "ABW La Lagune"
  place_id?:    string;                          // Google Places ID, if known
  coordinates:  Coordinates;

  // Rating data is COUPLED — score and review_count are meaningless apart.
  // Nesting makes "either both or neither" a structural guarantee instead of
  // a developer-discipline issue.
  rating_data?: {
    score:        number;   // 1.0–5.0
    review_count: number;   // ≥ 10 to qualify (product-spec §6.1)
  };

  // Aggregated from the source CSV's Tenant_Preference field across all
  // listings for this society (majority vote; chat 1d lowered the threshold
  // from 3 to 1, so any society with ≥ 1 valid Tenant_Preference value gets
  // a non-'unknown' signal).
  tenant_preference_signal: TenantPreferenceSignal;

  // Per-BHK median rent within this society. Absent if the society has zero
  // listings with valid Rent_INR; otherwise contains one entry per BHK that
  // had at least one valid listing. Chat 1d addition; product-spec §10.3 Step 6.
  rent_estimate_by_bhk?: SocietyRentEstimateByBhk;
}

// A rent band: [low, high] in INR per month, BASE RENT (excludes maintenance).
//
// Invariant: low ≤ high. Enforced at the pipeline boundary by Zod
// (BHKRentRangeSchema in schemas.ts), not by the type system itself — TS
// can't express that constraint without opaque branded types that would
// obscure the value.
export type BHKRentRange = readonly [low: number, high: number];

// Rent ranges per BHK.
//
// Absence carries meaning: a missing key means we don't have enough data
// for that BHK in this locality and it gets excluded from results when
// the user picks that BHK. Optional keys make the absence explicit and
// force consumers to handle it; a null would be silently dangerous.
export interface RentRangesByBHK {
  studio?: BHKRentRange;
  '1'?:    BHKRentRange;
  '2'?:    BHKRentRange;
  '3'?:    BHKRentRange;
  '4+'?:   BHKRentRange;
}

// Sample sizes per BHK — exposed so the UI can flag low-confidence cells
// (e.g., "based on 6 listings").
export interface RentSampleSizesByBHK {
  studio?: number;
  '1'?:    number;
  '2'?:    number;
  '3'?:    number;
  '4+'?:   number;
}

// The locality record — the central data unit.
export interface LocalityRecord {
  id:            LocalityId;             // e.g., "gur-sec-54"
  name:          string;                 // "Sector 54"
  sector_label?: string;                 // "Sector 28" or "DLF Phase 4"
  city:          City;                   // strict union: 'Gurgaon' in v0

  centroid:      Coordinates;            // for commute computation
  geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  // ^ MultiPolygon is required because real localities can be disjoint:
  //   railways, the Aravalli ridge, or wide highways physically split them.

  source:        LocalitySource;         // v0 = 'curated'

  rent_ranges:       RentRangesByBHK;    // BASE RENT, excludes maintenance
  rent_sample_sizes: RentSampleSizesByBHK;

  nearest_metros: MetroStation[];        // sorted nearest first; at least one
  societies:      Society[];             // can be empty for localities of mostly
                                         // standalone buildings
}

// Office hub — common workplaces. Stored in office-hubs-gurgaon.json.
//
// Two uses (product-spec §5):
//   1. Autocomplete — match user input against name + aliases.
//   2. Pre-warmed commute cache — both legs from each residential locality
//      to each hub are pre-computed and cached, so a search using a
//      recognized hub doesn't hit Distance Matrix.
export interface OfficeHub {
  id:        OfficeHubId;
  name:      string;                     // "DLF Cyber City"
  city:      City;
  centroid:  Coordinates;
  aliases?:  string[];                   // for autocomplete: ["Cyber Hub", "DLF Phase 3 IT"]
}

/**
 * Intrinsic per-leg minutes for one (hub × locality) pair.
 * Stored in the pre-warmed cache; user-dependent fields
 * (total_minutes, basis_value, in_buffer_zone, office_index)
 * are derived by the caller.
 */
export interface CachedCommuteLegs {
  outbound_minutes: number;
  return_minutes: number;
}

/**
 * Pre-warmed (office_hub × residential_locality) commute cache.
 *
 * Produced offline by scripts/prewarm-commute-cache.ts.
 * Read-only at runtime via /lib/commute-cache.ts.
 *
 * v0: stores the default time slot only (9 AM out / 6 PM return).
 * Non-default time_of_day → orchestrator treats as cache miss and
 * falls through to live Distance Matrix.
 */
export interface CommuteCache {
  version: number;
  generated_at: string; // ISO 8601 timestamp, stamped by prewarm script
  hubs: Record<OfficeHubId, Record<LocalityId, CachedCommuteLegs>>;
}