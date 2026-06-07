// lib/office-suggest.ts
//
// Wraps Google Places API (New) for office autocomplete + coordinate resolution.
// Two responsibilities, deliberately split:
//   - suggestOffices(query): partial input → typed predictions (no coords yet)
//   - resolveOfficeCoordinates(placeId): selected place_id → coords
//
// Why Places Autocomplete (New) and not /lib/geocode.ts:
//   - Geocoding is built for FULL addresses; partial-input results are unreliable.
//   - Places Autocomplete is purpose-built for typeahead and cheaper per call
//     (per tech-arch §6).
//
// Why the split is two functions, not one:
//   - Autocomplete fires on every keystroke (potentially many calls per session).
//   - Place Details (for coordinates) only fires on the user's chosen suggestion.
//   - Separating keeps cost bounded to (typed_chars × autocomplete) +
//     (1 × details), instead of (typed_chars × autocomplete+details).

import type { Coordinates } from '@/types';

const PLACES_API_BASE = 'https://places.googleapis.com/v1';

// Gurgaon city center — used to bias autocomplete toward NCR.
// 50km radius covers Gurgaon + most of Delhi + Noida edges.
const NCR_BIAS_CENTER: Coordinates = { lat: 28.4595, lng: 77.0266 };
const NCR_BIAS_RADIUS_METERS = 50_000;

export interface OfficeSuggestion {
  place_id: string;
  description: string;     // "DLF Cyber City, Gurgaon, Haryana, India"
  main_text: string;       // "DLF Cyber City"
  secondary_text: string;  // "Gurgaon, Haryana, India"
}

interface PlacesAutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId: string;
      text: { text: string };
      structuredFormat: {
        mainText: { text: string };
        secondaryText?: { text: string };
      };
    };
  }>;
}

interface PlaceDetailsResponse {
  location?: {
    latitude: number;
    longitude: number;
  };
}

function getApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error('GOOGLE_MAPS_API_KEY is not set');
  }
  return key;
}

export async function suggestOffices(query: string): Promise<OfficeSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return [];
  }

  const response = await fetch(`${PLACES_API_BASE}/places:autocomplete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getApiKey(),
    },
    body: JSON.stringify({
      input: trimmed,
      includedRegionCodes: ['in'],
      locationBias: {
        circle: {
          center: {
            latitude: NCR_BIAS_CENTER.lat,
            longitude: NCR_BIAS_CENTER.lng,
          },
          radius: NCR_BIAS_RADIUS_METERS,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Places Autocomplete failed: ${response.status} ${body}`);
  }

  const data: PlacesAutocompleteResponse = await response.json();
  const suggestions = data.suggestions ?? [];

  return suggestions
    .filter(
      (s): s is { placePrediction: NonNullable<typeof s.placePrediction> } =>
        s.placePrediction !== undefined
    )
    .slice(0, 5)
    .map(({ placePrediction }) => ({
      place_id: placePrediction.placeId,
      description: placePrediction.text.text,
      main_text: placePrediction.structuredFormat.mainText.text,
      secondary_text: placePrediction.structuredFormat.secondaryText?.text ?? '',
    }));
}

export async function resolveOfficeCoordinates(placeId: string): Promise<Coordinates> {
  if (!placeId) {
    throw new Error('placeId is required');
  }

  const response = await fetch(
    `${PLACES_API_BASE}/places/${encodeURIComponent(placeId)}`,
    {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': getApiKey(),
        'X-Goog-FieldMask': 'location',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Place Details failed: ${response.status} ${body}`);
  }

  const data: PlaceDetailsResponse = await response.json();
  if (!data.location) {
    throw new Error(`Place ${placeId} has no location data`);
  }

  return {
    lat: data.location.latitude,
    lng: data.location.longitude,
  };
}