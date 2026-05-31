// Search input types — what the form submits, what the API accepts.
// Source of truth: data-model.md §4.

import type {
  BHK,
  CommuteBasis,
  Coordinates,
  Household,
  TimeOfDay,
} from './primitives';

// An office the user works at.
export interface Office {
  address: string;            // free text as the user typed it
  coordinates: Coordinates;   // resolved by geocoding before the search runs
  label?: string;             // optional human label, used in v1+ for dual-office UI
                              // ("My office", "Aditi's office") — ignored in v0
}

// User-controlled scoring toggles.
//
// Commute is NOT a toggle — it's always active. It's not in this interface
// because it can't be turned off.
export interface ScoringToggles {
  metro:  boolean;   // default: true
  rating: boolean;   // default: false (opt-in)
}

// The full search input — what the API route accepts.
export interface SearchInput {
  offices: Office[];                  // v0: length must be 1
                                      // v1: length 1 or 2 (dual-office).
                                      // The shape is pre-designed so v1 doesn't
                                      // refactor consumers — only the Zod length
                                      // check changes.
  commute: {
    basis:        CommuteBasis;       // 'total_daily' or 'avg_one_way'
    max_minutes:  number;             // 10–180; interpretation depends on basis
    time_of_day?: TimeOfDay;          // optional; defaults to {09:00, 18:00}
  };
  budget_inr: number;                 // monthly base rent budget in INR
                                      // (excludes society maintenance fees)
  bhk:        BHK;
  household:  Household;
  scoring_toggles?: ScoringToggles;   // optional; defaults applied if absent
}