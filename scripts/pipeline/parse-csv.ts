// scripts/pipeline/parse-csv.ts
//
// CSV I/O + stage 1 validation.
//
//   readRawCsv(path)    — reads CSV into loose RawCSVRow[] (preprocess input)
//   validateRows(rows)  — Zod-validates preprocessed rows, coerces numerics,
//                         renames "Locality/Sector" → "Locality_Sector"

import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type { RawListingRecord } from '../../types/pipeline';
import type { RawCSVRow } from './preprocess';

// ============================================================================
// readRawCsv — disk → RawCSVRow[] (loose, all strings, "Locality/Sector" intact)
// ============================================================================

export function readRawCsv(path: string): RawCSVRow[] {
  const content = readFileSync(path, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  return records as RawCSVRow[];
}

// ============================================================================
// validateRows — Zod schema for stage-1 validation + type coercion
// ============================================================================

const emptyToUndef = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const numericFromString = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}, z.number().optional());

const stringOpt = z.preprocess(emptyToUndef, z.string().optional());

const RawListingRecordSchema = z.object({
  Title:             z.string().min(1),
  Property_Type:     stringOpt,
  BHK:               stringOpt,
  Rent_INR:          numericFromString,
  Area_Sqft:         numericFromString,
  Furnishing:        stringOpt,
  Bathrooms:         numericFromString,
  Floor:             stringOpt,
  Society:           stringOpt,
  City:              stringOpt,
  Locality_Sector:   stringOpt,
  Tenant_Preference: z.preprocess(
    emptyToUndef,
    z.enum(['Bachelors', 'Bachelors/Family', 'Family', 'Any']).optional()
  ),
  Key_Features:      stringOpt,
});

export interface ParseResult {
  rows:          RawListingRecord[];
  invalidCount:  number;
}

/**
 * Validates the preprocessed rows (output of stage 0) against the
 * RawListingRecord Zod schema. Renames "Locality/Sector" → "Locality_Sector"
 * and coerces numeric strings to numbers. Drops invalid rows with stderr
 * logging.
 */
export function validateRows(rows: RawCSVRow[]): ParseResult {
  const validated: RawListingRecord[] = [];
  let invalidCount = 0;

  rows.forEach((row, idx) => {
    // Rename "Locality/Sector" → "Locality_Sector" so it matches the schema key.
    const normalized: Record<string, unknown> = { ...row };
    if ('Locality/Sector' in normalized) {
      normalized.Locality_Sector = normalized['Locality/Sector'];
      delete normalized['Locality/Sector'];
    }

    const parsed = RawListingRecordSchema.safeParse(normalized);
    if (parsed.success) {
      validated.push(parsed.data as RawListingRecord);
    } else {
      invalidCount++;
      const issue = parsed.error.issues[0];
      if (issue) {
        console.error(
          `[validate-rows] row ${idx + 2} dropped: ${issue.path.join('.') || '<root>'} — ${issue.message}`
        );
      }
    }
  });

  return { rows: validated, invalidCount };
}
