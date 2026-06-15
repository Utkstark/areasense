// Zod schemas — runtime validation at boundaries where untyped data enters.
// Source of truth: data-model.md §11.
//
// Two boundaries:
//   1. API boundary  — SearchInputSchema validates incoming HTTP payloads
//                      in /app/api/search/route.ts.
//   2. Pipeline boundary — BHKRentRangeSchema / LocalityRecordSchema validate
//                          what the build-time pipeline emits AND what the
//                          server loads from /data/*.json on boot. Catches
//                          bugs in OUR code before bad data reaches scoring.
//
// `z.infer<typeof Schema>` keeps the runtime schema and compile-time type
// in lockstep.

import { z } from 'zod';
import type { SearchInput } from './input';

// === API-boundary schemas (incoming SearchInput) ===

export const CoordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const OfficeSchema = z.object({
  address:     z.string().min(1).max(500),
  coordinates: CoordinatesSchema,
  label:       z.string().max(100).optional(),
});

// Hourly-only clock validation. Pattern matches HH:00 where HH is 00–23.
// "09:30" or "25:00" are rejected. The form surfaces 24 dropdown options
// (12 AM through 11 PM); the backend rejects anything off-the-hour.
export const TimeStringSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):00$/, {
    message: 'Time must be on the hour (HH:00 format)',
  });

export const TimeOfDaySchema = z.object({
  out:    TimeStringSchema,
  return: TimeStringSchema,
});

export const SearchInputSchema = z.object({
  offices: z.array(OfficeSchema).length(1),     // v0: enforce length 1
                                                // v1: change to .min(1).max(2)
  commute: z.object({
    max_minutes: z.number().int().min(10).max(180),  // total daily; no basis toggle
    time_of_day: TimeOfDaySchema.optional(),
  }),
  budget_inr: z.number().int().min(3000).max(1_000_000),
  bhk:        z.enum(['studio', '1', '2', '3', '4+']),
  household:  z.enum(['single', 'family']),
  scoring_toggles: z
    .object({
      metro:  z.boolean(),
      rating: z.boolean(),
    })
    .optional(),
});

// Sanity check that the schema and the TS type stay aligned.
// If they drift apart, this line fails to compile.
// `void` discards the value so noUnusedLocals doesn't fire.
type SearchInputFromSchema = z.infer<typeof SearchInputSchema>;
const _typeCheck: SearchInputFromSchema = {} as SearchInput;
void _typeCheck;

// === Pipeline-boundary schemas ===

// The rent-range low ≤ high invariant. The type system can't express this
// constraint without opaque branded types that would obscure the value,
// so Zod enforces it at pipeline output.
export const BHKRentRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([low, high]) => low <= high, {
    message: 'BHKRentRange invariant violated: low must be ≤ high',
  });

// Society-level per-BHK rent estimate (chat 1d addition).
// median = INR/month, base rent, integer (rounded by Stage 6).
// sample_size = listing count for this society × BHK; minimum 1.
export const SocietyBhkRentEstimateSchema = z.object({
  median:      z.number().int().nonnegative(),
  sample_size: z.number().int().min(1),
});

// Per-BHK rent-estimate keys for a society. Mirrors RentRangesByBHK's shape.
export const SocietyRentEstimateByBhkSchema = z.object({
  studio: SocietyBhkRentEstimateSchema.optional(),
  '1':    SocietyBhkRentEstimateSchema.optional(),
  '2':    SocietyBhkRentEstimateSchema.optional(),
  '3':    SocietyBhkRentEstimateSchema.optional(),
  '4+':   SocietyBhkRentEstimateSchema.optional(),
});

// Validates a LocalityRecord at pipeline output and at JSON-load on server
// boot. GeoJSON geometry gets a minimal structural check only — we trust
// the pipeline to emit well-formed geometry, and a malformed polygon would
// surface as a Mapbox rendering error rather than as silently bad data.
export const LocalityRecordSchema = z.object({
  id:           z.string().min(1),
  name:         z.string().min(1),
  sector_label: z.string().optional(),
  city:         z.enum(['Gurgaon', 'Delhi']),
  centroid:     CoordinatesSchema,
  geometry: z.object({
    type:        z.enum(['Polygon', 'MultiPolygon']),
    coordinates: z.array(z.unknown()),   // intentional — deep GeoJSON validation
                                         // is the pipeline's job, not the loader's
  }).optional(),
  source: z.enum(['curated', 'auto-bootstrap', 'osm-import', 'user-submitted']),
  rent_ranges: z.object({
    studio: BHKRentRangeSchema.optional(),
    '1':    BHKRentRangeSchema.optional(),
    '2':    BHKRentRangeSchema.optional(),
    '3':    BHKRentRangeSchema.optional(),
    '4+':   BHKRentRangeSchema.optional(),
  }),
  rent_sample_sizes: z.object({
    studio: z.number().int().nonnegative().optional(),
    '1':    z.number().int().nonnegative().optional(),
    '2':    z.number().int().nonnegative().optional(),
    '3':    z.number().int().nonnegative().optional(),
    '4+':   z.number().int().nonnegative().optional(),
  }),
  nearest_metros: z.array(
    z.object({
      station:     z.string().min(1),
      line:        z.string().min(1).optional(),
      distance_km: z.number().nonnegative(),
    }),
  ),
  societies: z.array(
    z.object({
      id:          z.string().min(1),
      name:        z.string().min(1),
      place_id:    z.string().optional(),
      coordinates: CoordinatesSchema,
      rating_data: z
        .object({
          score:        z.number().min(1).max(5),
          review_count: z.number().int().min(0),
        })
        .optional(),
      tenant_preference_signal: z.enum([
        'accepts_bachelors',
        'accepts_family',
        'accepts_both',
        'unknown',
      ]),
      rent_estimate_by_bhk: SocietyRentEstimateByBhkSchema.optional(),
    }),
  ),
});
