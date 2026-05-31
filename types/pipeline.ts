// Pipeline types — CSV in, clean JSON out.
//
// These belong to the BUILD-TIME data pipeline (product-spec §10.3) and are
// NOT used at runtime by the deployed app. Source of truth: data-model.md §7.

import type { LocalityId } from './primitives';

// A row from the source rentals CSV.
//
// Mirrors the 12-column Gurgaon_Rental_Master CSV exactly. Field names
// match the CSV headers; many are optional because the source has gaps.
// Keeping these names verbatim means no translation at parse time and no
// chance of typos drifting from the source.
export interface RawListingRecord {
  Title:               string;
  Property_Type?:      string;
  BHK?:                string;     // "1 BHK" | "2 BHK" | … — needs parsing.
                                   // May also be "Studio" / "1 RK" — pipeline
                                   // maps both to 'studio'.
  Rent_INR?:           number;     // BASE RENT in INR. Excludes society maintenance.
                                   // (Maintenance often appears in Key_Features as
                                   //  free text, e.g. "monthly maintenance is ₹15000/-")
  Area_Sqft?:          number;
  Furnishing?:         string;
  Bathrooms?:          number;
  Floor?:              string;
  Society?:            string;
  Locality?:           string;     // RAW value, needs normalization
  Tenant_Preference?:  'Bachelors' | 'Bachelors/Family' | 'Family' | 'Any';
  Key_Features?:       string;     // free text — sometimes mentions maintenance
}

// The mapping from raw "Locality" strings to canonical LocalityIds.
//
// Hand-curated; lives in /data/locality-mapping.json. Unmapped values are
// flagged for manual review by the pipeline.
//   e.g., { "M3M Heights, Sector 65": "gur-sec-65",
//           "A Block Sushant Lok Phase 1": "gur-sushant-lok-1" }
export type LocalityMapping = Record<string, LocalityId>;

// Pipeline configuration. Concrete values live in config.ts (PIPELINE_CONFIG).
export interface PipelineConfig {
  outlier_trim_percentiles:        readonly [lower: number, upper: number];
  rent_range_percentiles:          readonly [lower: number, upper: number];
  min_sample_size:                 number;
  min_listings_for_society_signal: number;
}