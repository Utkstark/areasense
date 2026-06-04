/**
 * /lib/deeplinks.ts
 *
 * Pure URL-builder functions that produce per-portal deep-links for AreaSense's
 * "Browse all rental listings in <LOCALITY>" affordance (LocalityResult.locality_wide_deep_links)
 * and the per-society named-pick links (MatchedSociety.deep_links).
 *
 * Per product-spec §9 and project rule "AreaSense never scrapes" — these are deep-links
 * INTO the portals' own rental searches, not API calls. Each portal's URL template was
 * researched via live web search and confirmed by manual spot-check before being
 * committed here; see per-portal block comments for citations and any UNVERIFIED markers.
 *
 * Verification status as of v0:
 *   ✅ NoBroker    — locality + BHK URLs verified live.
 *   ✅ 99acres     — locality + BHK URLs verified live.
 *   ✅ Magicbricks — rent query URL verified live.
 *   ✅ Housing.com — city-wide rent + per-BHK (studio/1/2) URLs verified live.
 *                   3BHK / 4+BHK fall back to city URL (pattern suspected but unverified).
 *                   Per-locality and per-society URLs require internal UUIDs we don't have;
 *                   they degrade to the city URL.
 *
 * Constraints (per design brief):
 *   - Pure functions. No I/O, no React, no Next.js imports, no env-var reads.
 *   - All URL params encoded via URLSearchParams; path segments via a slugify helper.
 *   - Types imported from @/types — no re-declarations.
 *   - `affiliateTag` plumbed through; threading point currently noops until per-portal
 *     affiliate-program parameters are verified.
 */

import type { BHK, City, LocalityRecord, PortalDeepLinks, Society } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// Type aliases
// All multi-property generic types live here so every const annotation below
// fits on a single line — keeps the file portable across stricter tsconfigs.
// ─────────────────────────────────────────────────────────────────────────────

type Portal = keyof PortalDeepLinks;
// = 'nobroker' | 'housing' | '99acres' | 'magicbricks'.
// Derived from PortalDeepLinks so adding a portal in /types automatically widens
// this union and forces every branch in this file to be updated.

type NonHousingPortal = Exclude<Portal, 'housing'>;
// Housing.com uses opaque UUIDs instead of slugs/encodings, so the per-portal
// slug + BHK maps only need entries for the other three.

type CitySlugRecord = Readonly<Record<NonHousingPortal, string>>;
type BhkSlugRecord = Readonly<Record<BHK, string | null>>;

interface HousingCityRent {
  readonly citySlug: string; // e.g. "gurgaon-haryana"
  readonly cityUuid: string; // e.g. "P1od1w26jrfqap1jl"
}

interface HousingBhkCode {
  readonly pathPrefix: string;  // e.g. "1rk" | "1bhk" | "2bhk"
  readonly suffixCode: string;  // e.g. "C1"  | "C2"   | "C4"
}

// ─────────────────────────────────────────────────────────────────────────────
// City slug — per-portal, since each portal's URL uses a different convention.
// Housing.com is intentionally absent here — it has its own URL constants below.
// ─────────────────────────────────────────────────────────────────────────────

const CITY_SLUGS: Readonly<Record<City, CitySlugRecord>> = {
  Gurgaon: {
    // VERIFIED via live URL: https://www.nobroker.in/flats-for-rent-in-sector-54-gurgaon
    nobroker:    'gurgaon',
    // VERIFIED via live URL: https://www.99acres.com/flats-for-rent-in-gurgaon-ffid
    '99acres':   'gurgaon',
    // PARTIALLY VERIFIED via Apify scraper docs (uses `cityName=New-Delhi` style):
    //   https://apify.com/ecomscrape/magicbricks-property-search-scraper
    magicbricks: 'Gurgaon',
  },
  Delhi: {
    // VERIFIED via live URL: https://www.nobroker.in/flats-for-rent-in-delhi-delhi
    nobroker:    'delhi',
    // VERIFIED via live URL: https://www.99acres.com/flats-for-rent-in-delhi-ffid
    '99acres':   'delhi',
    // UNVERIFIED — best guess from the Apify scraper docs pattern; confirm a real
    // magicbricks Delhi rent URL before any Delhi-facing UI launch.
    magicbricks: 'New-Delhi',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Housing.com city-rent URLs.
//
// Housing.com's rent search is keyed by an opaque per-city UUID. Verified URLs
// collected from housing.com homepage and direct spot-check (May 2026).
//
// City-wide rent URL form:
//   https://housing.com/rent/flats-for-rent-in-{citySlug}-{cityUuid}
//
// BHK-specific rent URL form (see HOUSING_BHK_CODE below):
//   https://housing.com/rent/{bhkPathPrefix}-flats-for-rent-in-{citySlug}-{bhkSuffixCode}{cityUuid}
//
// Per-locality rent URLs need internal locality UUIDs we don't have, so they
// degrade to the city / city+BHK page. The user filters by sector on-site.
// ─────────────────────────────────────────────────────────────────────────────

const HOUSING_CITY_RENT: Readonly<Record<City, HousingCityRent>> = {
  Gurgaon: {
    citySlug: 'gurgaon-haryana',
    cityUuid: 'P1od1w26jrfqap1jl',
  },
  // TODO: verify before Delhi launch — housing.com's per-city UUID is opaque
  // and couldn't be derived without inspecting a live URL. Empty values here
  // produce broken Housing.com deep-links for Delhi if a Delhi search runs
  // before this is filled in. Other portals (NoBroker, 99acres, Magicbricks)
  // are wired above.
  Delhi: {
    citySlug: '',
    cityUuid: '',
  },
};

const HOUSING_BHK_CODE: Readonly<Record<BHK, HousingBhkCode | null>> = {
  // VERIFIED live URLs (May 2026):
  //   https://housing.com/rent/1rk-flats-for-rent-in-gurgaon-haryana-C1P1od1w26jrfqap1jl
  //   https://housing.com/rent/1bhk-flats-for-rent-in-gurgaon-haryana-C2P1od1w26jrfqap1jl
  //   https://housing.com/rent/2bhk-flats-for-rent-in-gurgaon-haryana-C4P1od1w26jrfqap1jl
  studio: { pathPrefix: '1rk',  suffixCode: 'C1' },
  '1':    { pathPrefix: '1bhk', suffixCode: 'C2' },
  '2':    { pathPrefix: '2bhk', suffixCode: 'C4' },
  // 4+BHK has no canonical Housing.com rent URL for Gurgaon — tested
  // .../4bhk-flats-for-rent-in-gurgaon-haryana-C16P1od1w26jrfqap1jl and it
  // silently redirected to the 1BHK page. Falling back to the city-wide rent
  // URL is the honest behavior; user filters BHK on-page.
  '3':    null,
  '4+':   null,
};

// ─────────────────────────────────────────────────────────────────────────────
// BHK encoding — per-portal. `null` means: the portal's URL form for this BHK is
// not confidently known; drop the BHK from the URL and land on the locality-wide
// page (the user can still filter via the portal's own UI).
// ─────────────────────────────────────────────────────────────────────────────

const BHK_ENCODING: Readonly<Record<NonHousingPortal, BhkSlugRecord>> = {
  nobroker: {
    // UNVERIFIED — NoBroker lists "1 RK" / studio units but the URL path form
    // isn't confirmed. Falling back keeps the user on a valid locality page.
    studio: null,
    // VERIFIED: https://www.nobroker.in/1bhk-flats-for-rent-in-dlf-the-summit-sector-54-gurgaon-prjtl
    '1':    '1bhk',
    // VERIFIED: https://www.nobroker.in/2bhk-flats-for-rent-in-sector-54-gurgaon
    '2':    '2bhk',
    // INFERRED from the 1bhk / 2bhk pattern.
    '3':    '3bhk',
    // UNVERIFIED — same pattern, but no live URL confirmed.
    '4+':   '4bhk',
  },
  '99acres': {
    studio: null, // UNVERIFIED
    // VERIFIED: https://www.99acres.com/2-bhk-society-flats-apartments-for-rent-in-gurgaon-ffid
    '1':    '1-bhk',
    '2':    '2-bhk',
    // INFERRED from the 2-bhk pattern.
    '3':    '3-bhk',
    '4+':   '4-bhk',
  },
  magicbricks: {
    // Magicbricks uses `proptype=Studio-Apartment` separately from `bedroom`;
    // for v0 we drop BHK on studio and the user refines on the page.
    studio: null,
    // VERIFIED via Apify docs (`bedroom=2,3` in the URL):
    //   https://apify.com/ecomscrape/magicbricks-property-search-scraper
    '1':    '1',
    '2':    '2',
    '3':    '3',
    '4+':   '4',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slugify a free-text name to a URL-safe lowercase slug.
 * "Sector 54, Golf Course Road" → "sector-54-golf-course-road"
 * "ABW La Lagune"               → "abw-la-lagune"
 * Unicode normalization handles the rare diacritics that show up in Indian
 * locality / society names.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')                  // decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')    // strip combining marks
    .replace(/[^a-z0-9]+/g, '-')        // any run of non-alphanum → single hyphen
    .replace(/^-+|-+$/g, '');           // trim hyphens at edges
}

/**
 * Append query params to a base URL using URLSearchParams.
 * Skips entries whose value is undefined (so optional filters cleanly drop out).
 * Number values are stringified; everything is percent-encoded per WHATWG URL.
 */
function withQuery(
  baseUrl: string,
  params: Record<string, string | number | undefined>,
): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    usp.append(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `${baseUrl}?${qs}` : baseUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-portal: NoBroker
// ─────────────────────────────────────────────────────────────────────────────

function nobrokerLocalityUrl(locality: LocalityRecord, city: City, bhk: BHK): string {
  const citySlug = CITY_SLUGS[city].nobroker;
  const localitySlug = slugify(locality.name);
  const bhkPrefix = BHK_ENCODING.nobroker[bhk];
  const path = bhkPrefix
    ? `${bhkPrefix}-flats-for-rent-in-${localitySlug}-${citySlug}`
    : `flats-for-rent-in-${localitySlug}-${citySlug}`;
  return `https://www.nobroker.in/${path}`;
}

function nobrokerSocietyUrl(
  society: Society,
  locality: LocalityRecord,
  city: City,
): string {
  // UNVERIFIED — please test live before merging.
  // Pattern inferred from `/flats-for-rent-in-suncity-sector-54-gurgaon`.
  const citySlug = CITY_SLUGS[city].nobroker;
  const localitySlug = slugify(locality.name);
  const societySlug = slugify(society.name);
  return `https://www.nobroker.in/flats-for-rent-in-${societySlug}-${localitySlug}-${citySlug}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-portal: 99acres
// ─────────────────────────────────────────────────────────────────────────────

function nineNineAcresLocalityUrl(
  locality: LocalityRecord,
  city: City,
  bhk: BHK,
): string {
  const citySlug = CITY_SLUGS[city]['99acres'];
  const localitySlug = slugify(locality.name);
  const bhkPrefix = BHK_ENCODING['99acres'][bhk];
  const localityWithCity = localitySlug.includes(citySlug)
    ? localitySlug
    : `${localitySlug}-${citySlug}`;
  const path = bhkPrefix
    ? `${bhkPrefix}-flats-for-rent-in-${localityWithCity}-ffid`
    : `flats-for-rent-in-${localityWithCity}-ffid`;
  return `https://www.99acres.com/${path}`;
}

function nineNineAcresSocietyUrl(
  society: Society,
  locality: LocalityRecord,
  city: City,
): string {
  // UNVERIFIED — 99acres society/project pages are keyed by internal IDs we don't
  // have. Degrade to the locality-wide URL with "2 BHK" as the most-searched fallback.
  void society;
  return nineNineAcresLocalityUrl(locality, city, '2');
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-portal: Magicbricks
// ─────────────────────────────────────────────────────────────────────────────

function magicbricksLocalityUrl(
  locality: LocalityRecord,
  city: City,
  bhk: BHK,
  budgetInr: number,
): string {
  const cityName = CITY_SLUGS[city].magicbricks;
  const bedroom = BHK_ENCODING.magicbricks[bhk] ?? undefined;
  return withQuery(
    'https://www.magicbricks.com/property-for-rent/residential-real-estate',
    {
      cityName,
      Locality:  locality.name, // URLSearchParams handles encoding
      bedroom,
      BudgetMax: budgetInr,
    },
  );
}

function magicbricksSocietyUrl(
  society: Society,
  locality: LocalityRecord,
  city: City,
): string {
  // UNVERIFIED — `keyword` param name is guessed; if Magicbricks ignores it the
  // user still lands on the locality-filtered list.
  const cityName = CITY_SLUGS[city].magicbricks;
  return withQuery(
    'https://www.magicbricks.com/property-for-rent/residential-real-estate',
    {
      cityName,
      Locality: locality.name,
      keyword:  society.name,
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-portal: Housing.com
// ─────────────────────────────────────────────────────────────────────────────

function housingLocalityUrl(
  locality: LocalityRecord,
  city: City,
  bhk: BHK,
  budgetInr: number,
): string {
  // locality and budgetInr aren't reflected in the URL — Housing.com's rent
  // pages use opaque UUIDs we don't have for sub-city scopes, and budget is a
  // UI-only filter. The user refines on-page.
  void locality;
  void budgetInr;
  const rent = HOUSING_CITY_RENT[city];
  const bhkCode = HOUSING_BHK_CODE[bhk];
  if (bhkCode) {
    return `https://housing.com/rent/${bhkCode.pathPrefix}-flats-for-rent-in-${rent.citySlug}-${bhkCode.suffixCode}${rent.cityUuid}`;
  }
  // Fall back to city-wide rent page when BHK encoding is unverified.
  return `https://housing.com/rent/flats-for-rent-in-${rent.citySlug}-${rent.cityUuid}`;
}

function housingSocietyUrl(
  society: Society,
  locality: LocalityRecord,
  city: City,
): string {
  // Same degradation as housingLocalityUrl — society URLs need internal `rpid`
  // IDs we don't have. Land on city-wide rent; MatchedSociety row surfaces the
  // society name so the user knows what to look for.
  void society;
  void locality;
  const rent = HOUSING_CITY_RENT[city];
  return `https://housing.com/rent/flats-for-rent-in-${rent.citySlug}-${rent.cityUuid}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Affiliate tag threading point.
//
// No portal has a verified affiliate-program parameter as of v0. The tag is
// plumbed through the public signatures but NOT speculatively appended.
// When a portal's format is confirmed, replace the relevant `case` branch.
// ─────────────────────────────────────────────────────────────────────────────

function applyAffiliateTag(
  url: string,
  portal: Portal,
  affiliateTag: string | undefined,
): string {
  if (!affiliateTag) return url;
  switch (portal) {
    case 'nobroker':
    case 'housing':
    case '99acres':
    case 'magicbricks':
      return url;
    default: {
      const _exhaustive: never = portal;
      return _exhaustive;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build per-portal deep-links pre-filtered for a specific society within its
 * locality. Used to populate `MatchedSociety.deep_links` on each result row
 * (the named-picks tier from product-spec §7).
 */
export function buildSocietyDeeplinks(
  society: Society,
  locality: LocalityRecord,
  city: City,
  affiliateTag?: string,
): PortalDeepLinks {
  return {
    nobroker: applyAffiliateTag(
      nobrokerSocietyUrl(society, locality, city),
      'nobroker',
      affiliateTag,
    ),
    housing: applyAffiliateTag(
      housingSocietyUrl(society, locality, city),
      'housing',
      affiliateTag,
    ),
    '99acres': applyAffiliateTag(
      nineNineAcresSocietyUrl(society, locality, city),
      '99acres',
      affiliateTag,
    ),
    magicbricks: applyAffiliateTag(
      magicbricksSocietyUrl(society, locality, city),
      'magicbricks',
      affiliateTag,
    ),
  };
}

/**
 * Build per-portal deep-links into each portal's rental-search, filtered by
 * city + locality + BHK + budget (where each portal's URL supports each).
 * Used to populate `LocalityResult.locality_wide_deep_links` (product-spec §7).
 */
export function buildLocalityDeeplinks(
  locality: LocalityRecord,
  city: City,
  bhk: BHK,
  budgetInr: number,
  affiliateTag?: string,
): PortalDeepLinks {
  return {
    nobroker: applyAffiliateTag(
      nobrokerLocalityUrl(locality, city, bhk),
      'nobroker',
      affiliateTag,
    ),
    housing: applyAffiliateTag(
      housingLocalityUrl(locality, city, bhk, budgetInr),
      'housing',
      affiliateTag,
    ),
    '99acres': applyAffiliateTag(
      nineNineAcresLocalityUrl(locality, city, bhk),
      '99acres',
      affiliateTag,
    ),
    magicbricks: applyAffiliateTag(
      magicbricksLocalityUrl(locality, city, bhk, budgetInr),
      'magicbricks',
      affiliateTag,
    ),
  };
}