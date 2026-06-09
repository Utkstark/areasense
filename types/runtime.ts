// Runtime computation types — produced per search.
// Source of truth: data-model.md §8.

import type {
  BudgetAnnotation,
  Coordinates,
  LocalityId,
  RatingDroppedReason,
} from './primitives';
import type { BHKRentRange, LocalityRecord, Society } from './data';

// Commute computation result, per office, per locality.
export interface CommuteResult {
  office_index:     number;     // which office in input.offices (v0 always 0)
  outbound_minutes: number;     // locality → office at outbound_time
  return_minutes:   number;     // office → locality at return_time
  total_minutes:    number;     // outbound + return — the user-facing number.
                                // (basis simplification per product-spec §4.2:
                                //  no one-way/total toggle in v0.)
  in_buffer_zone:   boolean;    // true if over user's stated max but within buffered max
}

// Score breakdown for one locality.
// Optional keys = dimension inactive for this locality (toggled off, or
// dropped out per product-spec §6.3).
export interface SubScores {
  commute: number;              // always present, 0–1
  metro?:  number;              // present iff metro toggle on, 0–1
  rating?: number;              // present iff rating active for this locality, 0–1
}

export interface ActiveWeights {
  commute: number;              // always present
  metro?:  number;              // present iff metro toggle on
  rating?: number;              // present iff rating active for this locality
}

export interface LocalityScore {
  sub_scores:     SubScores;
  active_weights: ActiveWeights;
  final_score:    number;       // 0–1, blended per product-spec §6.2

  // null when rating IS in the blend; enum value when it isn't.
  // Lets the UI explain "rating not used for this locality because…".
  // Explicit null (not optional) so we never confuse "we evaluated and rating
  // is active" with "we forgot to set this field".
  rating_dropped_reason: RatingDroppedReason | null;
}

// Budget fit signal — see product-spec §4.3.
export interface BudgetFit {
  in_range:   boolean;          // budget ≥ low for selected BHK?
  position:   number;           // (budget − low) / (high − low); can be > 1 or < 0
  annotation: BudgetAnnotation;
}

// Deep-links into each portal's filtered rental search.
export interface PortalDeepLinks {
  nobroker:    string;
  housing:     string;
  '99acres':   string;
  magicbricks: string;
}

// Society as it appears in results — composition over inheritance.
//
// MatchedSociety is a search-time decoration of a Society, not a subtype of
// one. Inheritance creates implicit coupling — any change to Society would
// silently change MatchedSociety. Composition keeps the boundaries clean
// and makes both types independently testable and refactorable.
export interface MatchedSociety {
  society:    Society;          // the static record, nested (NOT extended)
  deep_links: PortalDeepLinks;
  passes_household_filter: boolean;
  // Bachelor single user against an 'accepts_family' society = false.
  // Filter UI may hide failing societies or show them grayed out.
}

// One ranked locality in the results.
export interface LocalityResult {
  locality:        LocalityRecord;
  commutes:        CommuteResult[];          // v0 length 1, v1 length 1 or 2
  joint_commute?:  JointCommuteSummary;      // v1+ only; absent in v0
  score:           LocalityScore;
  budget_fit:      BudgetFit;
  rent_range_used: BHKRentRange;             // BASE RENT for the selected BHK
  matched_societies:        MatchedSociety[];
  locality_wide_deep_links: PortalDeepLinks;
}

// RESERVED for v1+; not produced in v0.
// Pre-declared so v1 doesn't reshape LocalityResult.
export interface JointCommuteSummary {
  sum_minutes:      number;
  max_minutes:      number;
  weighted_minutes: number;
}

// Edge-case metadata — see product-spec §8.1.
export interface RelaxationApplied {
  budget_relaxed_by_pct?:      number;       // 0.20 if applied
  commute_relaxed_by_minutes?: number;       // 15 if applied
  rating_floor_lowered_to?:    number;       // 3.5 if applied
}

// Tradeoff points — discriminated union, no overloaded `value` field.
//
// The discriminator `type` lets the compiler narrow to exactly one shape.
// When `type === 'cheapest_at_commute'`, only `commute_minutes` is accessible;
// `rent_inr` doesn't exist on that variant. The earlier overloaded
// `value: number` design (whose meaning depended on a sibling `type` field)
// is the structural ambiguity TS exists to prevent.
//
// No UI `message` field — string formatting (and localization) is a
// frontend concern. Backend ships raw data.
export type TradeoffPoint =
  | {
      type: 'cheapest_at_commute';
      locality_id:     LocalityId;
      locality_name:   string;
      commute_minutes: number;     // the actual minutes for THIS locality
    }
  | {
      type: 'closest_at_budget';
      locality_id:   LocalityId;
      locality_name: string;
      rent_inr:      number;       // the actual base rent for the selected BHK
    };

// The top-level API response.
export interface SearchResult {
  results: LocalityResult[];
  relaxation_applied?: RelaxationApplied;
  tradeoff_points?:    TradeoffPoint[];      // populated when filters returned zero,
                                             // shown alongside the relaxed results
  search_metadata: {
    offices_resolved: Coordinates[];            // array — aligns with offices[] in input
                                                // and commutes[] in results

    // True iff this request triggered a synchronous live computation
    // (Upstash Redis miss). Required (not optional) so an explicit `false`
    // carries real information — "we did NOT cold-start, the cache was warm."
    // See tech-architecture.md §8 for the cold-start contract; product-spec
    // §5 for the user-facing copy.
    cold_start: boolean;

    // Optional — Mapbox isochrone polygon for the map overlay. Absent when
    // the isochrone call failed (graceful degrade — search still 200s).
    // `clamped_at_minutes` is present iff the caller's max_minutes exceeded
    // the Mapbox 60-min cap, carrying the ORIGINAL max so the UI can render
    // "Map only shows the 60-min reachable area. Your full {X}-min results
    // are in the list." See tech-architecture.md §10.
    isochrone?: {
      geometry:            GeoJSON.Polygon | GeoJSON.MultiPolygon;
      clamped_at_minutes?: number;
    };

    timestamp:                  string;         // ISO 8601
    total_localities_evaluated: number;
  };
}