// scripts/pipeline/backfill-fields.ts
//
// Stage 3 — residual recovery of missing BHK / Property_Type from Title regex.
// Per product-spec §10.3 Step 2. Most rows already have these populated from
// chat-1a consolidation; this is a light cleanup pass for stragglers.

import type { RawListingRecord, ResolvedRow } from '../../types/pipeline';

// Order matters: studio/RK matchers run before generic "N BHK".
const BHK_STUDIO_RE  = /\b(studio|1\s*RK)\b/i;
const BHK_NUMERIC_RE = /\b(\d+)\s*BHK\b/i;

const PROPERTY_TYPE_PATTERNS: ReadonlyArray<{ re: RegExp; value: string }> = [
  { re: /\bbuilder\s*floor\b/i,                value: 'Builder Floor' },
  { re: /\bpenthouse\b/i,                      value: 'Penthouse' },
  { re: /\b(independent\s*house|villa)\b/i,    value: 'Independent House' },
  { re: /\b(flat|apartment)\b/i,               value: 'Apartment' },
];

function backfillBHK(row: RawListingRecord): string | undefined {
  if (row.BHK) return row.BHK;
  if (!row.Title) return undefined;

  if (BHK_STUDIO_RE.test(row.Title)) return 'studio';
  const m = row.Title.match(BHK_NUMERIC_RE);
  if (m && m[1]) {
    const n = parseInt(m[1], 10);
    if (n >= 4) return '4+';
    if (n >= 1) return String(n);
  }
  return undefined;
}

function backfillPropertyType(row: RawListingRecord): string | undefined {
  if (row.Property_Type) return row.Property_Type;
  if (!row.Title) return undefined;

  for (const { re, value } of PROPERTY_TYPE_PATTERNS) {
    if (re.test(row.Title)) return value;
  }
  return undefined;
}

export interface BackfillStats {
  bhkBackfilled:              number;
  propertyTypeBackfilled:     number;
  bhkStillMissing:            number;
  propertyTypeStillMissing:   number;
}

export interface BackfillResult {
  rows:   ResolvedRow[];
  stats:  BackfillStats;
}

export function backfillFields(rows: ResolvedRow[]): BackfillResult {
  const stats: BackfillStats = {
    bhkBackfilled:            0,
    propertyTypeBackfilled:   0,
    bhkStillMissing:          0,
    propertyTypeStillMissing: 0,
  };

  const out: ResolvedRow[] = rows.map(({ row, localityId, resolvedVia }) => {
    const bhkBefore = row.BHK;
    const ptBefore  = row.Property_Type;
    const bhkAfter  = backfillBHK(row);
    const ptAfter   = backfillPropertyType(row);

    if (!bhkBefore && bhkAfter) stats.bhkBackfilled++;
    if (!ptBefore  && ptAfter)  stats.propertyTypeBackfilled++;
    if (!bhkAfter) stats.bhkStillMissing++;
    if (!ptAfter)  stats.propertyTypeStillMissing++;

    return {
      row: { ...row, BHK: bhkAfter, Property_Type: ptAfter },
      localityId,
      resolvedVia,
    };
  });

  return { rows: out, stats };
}
