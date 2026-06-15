// types/pipeline.ts
//
// Pipeline-only types: CSV row shape, locality resolution outcomes, resolver
// stats. Runtime/app types live in /types/runtime.ts and /types/data.ts.

import type { City, LocalityId } from './primitives';
import type { LocalityRecord } from './data';

// ============================================================================
// Source CSV row — 13-col canonical shape
// Headers: Title, Property_Type, BHK, Rent_INR, Area_Sqft, Furnishing,
//          Bathrooms, Floor, Society, City, Locality/Sector,
//          Tenant_Preference, Key_Features
// ============================================================================

export interface RawListingRecord {
  Title:              string;
  Property_Type?:     string;
  BHK?:               string;     // "1 BHK" | "Studio" | "1 RK" | …
  Rent_INR?:          number;     // base rent only, excludes maintenance
  Area_Sqft?:         number;
  Furnishing?:        string;
  Bathrooms?:         number;
  Floor?:             string;
  Society?:           string;
  City?:              string;     // 'Gurgaon' | 'Delhi' (validated downstream)
  Locality_Sector?:   string;     // CSV header "Locality/Sector", normalized at parse
  Tenant_Preference?: 'Bachelors' | 'Bachelors/Family' | 'Family' | 'Any';
  Key_Features?:      string;
}

// ============================================================================
// Tier-1 manual override mapping
// data/locality-mapping.json shape — nested by city to disambiguate values
// like "Sector 12" (exists in both Gurgaon and Delhi/Dwarka).
// ============================================================================

export type LocalityMapping = Partial<Record<City, Record<string, LocalityId>>>;

// ============================================================================
// Pipeline config — values pulled from /types/config.ts at runtime
// ============================================================================

export interface PipelineConfig {
  outlier_trim_percentiles:        readonly [lower: number, upper: number];
  rent_range_percentiles:          readonly [lower: number, upper: number];
  min_sample_size:                 number;
  min_listings_for_society_signal: number;
}

// ============================================================================
// Resolver output (chat 1b)
// ============================================================================

export type ResolutionTier = 'mapping' | 'existing' | 'bootstrap';

export interface ResolvedRow {
  row:          RawListingRecord;
  localityId:   LocalityId;
  resolvedVia:  ResolutionTier;
}

export type ResolutionSkipReason =
  | 'missing_city'
  | 'missing_locality_sector'
  | 'invalid_city'
  | 'bootstrap_cap_reached'
  | 'bootstrap_geocode_failed'
  | 'bootstrap_low_confidence'
  | 'bootstrap_out_of_bounds'
  | 'bootstrap_no_metros_found';

export type ResolutionOutcome =
  | { ok: true;  localityId: LocalityId; resolvedVia: ResolutionTier; newRecord?: LocalityRecord }
  | { ok: false; reason: ResolutionSkipReason; rawCity?: string; rawValue?: string };

export interface ResolverStats {
  total:                number;
  resolved:             number;
  byTier:               Record<ResolutionTier, number>;
  skipped:              number;
  bySkipReason:         Partial<Record<ResolutionSkipReason, number>>;
  bootstrapCalls:       number;
  bootstrapCapReached:  boolean;
}