// Primitive types and enums for AreaSense.
// Source of truth: data-model.md §3.

// === Enums (string union types — easier to serialize than TS enums) ===

export type BHK = 'studio' | '1' | '2' | '3' | '4+';

export type Household = 'single' | 'family';

// v0: Gurgaon only. v1 extends to | 'Mumbai'.
// Strict union prevents typo drift ('gurgaon', 'Gurugram') across the codebase.
export type City = 'Gurgaon' | 'Delhi';

export type CommuteBasis = 'total_daily' | 'avg_one_way';

// v0: driving only. v1: 'driving' | 'transit' | 'walking'
export type CommuteMode = 'driving';

// v0: always 'curated'. Field reserved to avoid v2 schema migration.
export type LocalitySource = 'curated' | 'auto-bootstrap' | 'osm-import' | 'user-submitted';

// v0 source data does not distinguish bachelor men vs women. The Indian rental
// market often differentiates these (see product-spec §11). A finer-grained
// split is deferred until source data supports it.
export type TenantPreferenceSignal =
  | 'accepts_bachelors'
  | 'accepts_family'
  | 'accepts_both'
  | 'unknown';

export type BudgetAnnotation =
  | 'below_range'      // excluded (budget < locality's low)
  | 'lower_part'       // 0 ≤ position < 0.5
  | 'most_options'     // 0.5 ≤ position ≤ 1.0
  | 'full_range';      // position > 1.0

export type RatingDroppedReason =
  | 'toggled_off'              // user has rating toggle off
  | 'insufficient_societies';  // fewer than 4 qualifying societies in locality

// === Branded ID types (prevent mixing up IDs at compile time) ===
//
// It's easy to pass a societyId where a localityId is expected when both are
// strings. Branding makes the compiler catch this. The runtime representation
// is still just a string; the brand is erased at runtime.

export type LocalityId  = string & { readonly __brand: 'LocalityId' };
export type SocietyId   = string & { readonly __brand: 'SocietyId' };
export type OfficeHubId = string & { readonly __brand: 'OfficeHubId' };

// === Geographic primitives ===

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface TimeOfDay {
  out: string;     // "HH:MM" 24-hour, validated as a real clock time (00:00-23:59)
  return: string;  // "HH:MM" 24-hour, validated as a real clock time
}