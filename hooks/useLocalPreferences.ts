// hooks/useLocalPreferences.ts
//
// Persists last-submitted search inputs to localStorage and rehydrates on
// mount. Per tech-arch §11: client-only, no PII to server.
//
// What we persist:
//   - office (address + coordinates — coords don't go stale at v0 scale)
//   - commute (max_minutes, time_of_day) — total-daily; basis removed per
//     product-spec §4.2 (founders: clear localStorage once after deploy)
//   - budget, BHK, household
//   - scoring toggles
//
// What we DO NOT persist:
//   - SearchResults (session-only)
//   - any derived/computed state

'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  BHK,
  Coordinates,
  Household,
  ScoringToggles,
  TimeOfDay,
} from '@/types';

const STORAGE_KEY = 'areasense:last-search';

export interface PersistedPreferences {
  office?: {
    address: string;
    coordinates: Coordinates;
  };
  commute?: {
    max_minutes: number;
    time_of_day?: TimeOfDay;
  };
  budget_inr?: number;
  bhk?: BHK;
  household?: Household;
  scoring_toggles?: ScoringToggles;
}

export function useLocalPreferences() {
  const [preferences, setPreferencesState] = useState<PersistedPreferences | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        setPreferencesState(JSON.parse(raw));
      }
    } catch (err) {
      console.warn('Failed to read preferences from localStorage', err);
    } finally {
      setHydrated(true);
    }
  }, []);

  const setPreferences = useCallback((prefs: PersistedPreferences) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      setPreferencesState(prefs);
    } catch (err) {
      console.warn('Failed to save preferences', err);
    }
  }, []);

  const clearPreferences = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      setPreferencesState(null);
    } catch (err) {
      console.warn('Failed to clear preferences', err);
    }
  }, []);

  return { preferences, setPreferences, clearPreferences, hydrated };
}