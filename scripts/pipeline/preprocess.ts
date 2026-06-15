/**
 * scripts/pipeline/preprocess.ts
 *
 * Stage 0 of the data pipeline (product-spec §10.3, technical impl per tech-arch §12).
 *
 * Three sub-steps applied to each row before stages 1+:
 *   0a — Case normalization (Title Case with acronym preservation)
 *   0b — Synonym merge (data/locality-synonyms.json)
 *   0c — Road-aggregator decomposition (Title regex + Society overrides)
 *
 * Unresolved rows (per option U1) are excluded from the output and logged
 * with full context to enable iterative overrides curation.
 *
 * Pure functions — no I/O. CLI wrapper lives in `run-preprocess.ts`.
 */

import type { City } from '@/types';
import localitySynonyms from '@/data/locality-synonyms.json';
import societySectorOverrides from '@/data/society-sector-overrides.json';
import localityJunkValues from '@/data/locality-junk-values.json';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Raw CSV row as parsed by csv-parse (all fields strings or undefined).
 * Stage 0 keeps this loose; stage 1 (chat 1b) tightens via Zod against
 * RawListingRecord.
 */
export interface RawCSVRow {
  City: string;
  'Locality/Sector': string;
  Society?: string;
  Title?: string;
  [key: string]: string | undefined;
}

/** A row that survived all three sub-steps. Same shape as RawCSVRow; only
 *  City and Locality/Sector are touched. */
export type PreprocessedCSVRow = RawCSVRow;

export type UnresolvedReason =
  | 'invalid_city'
  | 'junk_value'
  | 'road_aggregator_unresolved';

export interface UnresolvedRow {
  row_index: number;
  city: string;
  original_locality_sector: string;
  normalized_locality_sector: string;
  society: string | undefined;
  title: string | undefined;
  reason: UnresolvedReason;
}

export interface PreprocessStats {
  input_rows: number;
  output_rows: number;
  decomposed_via_title_regex: number;
  decomposed_via_society_lookup: number;
  unchanged: number;
  unresolved_count: number;
  synonym_merges_applied: number;
  prefix_stripped: number;
  sec_expanded: number;
  bySkipReason: Record<UnresolvedReason, number>;
}

export interface PreprocessOutcome {
  preprocessed: PreprocessedCSVRow[];
  unresolved: UnresolvedRow[];
  stats: PreprocessStats;
}

// ─── Acronym preserve list for Title Case ───────────────────────────────────

const ACRONYMS = new Set<string>([
  'DLF', 'NH', 'BPTP', 'M3M', 'MGF', 'RWA', 'AWHO',
  'IGNOU', 'CR', 'MG', 'GT',
]);

// ─── ROAD_AGGREGATORS (keys are post-normalize, post-synonym) ───────────────

const ROAD_AGGREGATORS = new Set<string>([
  // Gurgaon
  'Gurgaon|Delhi Gurgaon Expressway',
  'Gurgaon|Sohna Road',
  'Gurgaon|Golf Course Extension Road',
  'Gurgaon|Golf Course Road',
  'Gurgaon|Mehrauli Gurgaon Road',
  'Gurgaon|Pataudi Road',
  'Gurgaon|Faridabad Gurgaon Road',
  'Gurgaon|Old Delhi Gurgaon Road',
  'Gurgaon|Dwarka Expressway',
  // Delhi
  'Delhi|Mathura Road',
  'Delhi|Najafgarh Road',
  'Delhi|Mehrauli Badarpur Road',
  'Delhi|Sri Aurobindo Marg',
]);

function aggregatorKey(city: City, value: string): string {
  return `${city}|${value}`;
}

const TITLE_SECTOR_REGEX = /Sector\s+(\d+[A-Za-z]?)/i;

// ─── 0d — Junk-value skip list ──────────────────────────────────────────────

const JUNK_VALUES = new Set<string>(
  (localityJunkValues as string[]).map(v => v.toLowerCase()),
);

const POSTAL_CODE_REGEX = /^\d{6}$/;

/** True if the (post-0a normalized) value is a known junk token or a 6-digit
 *  postal code. Hand-curated tokens live in data/locality-junk-values.json. */
export function isJunkValue(value: string): boolean {
  const trimmed = value.trim();
  if (POSTAL_CODE_REGEX.test(trimmed)) return true;
  return JUNK_VALUES.has(trimmed.toLowerCase());
}

// ─── 0e — Prefix stripping ──────────────────────────────────────────────────

const PREFIX_STRIP_PATTERNS = [
  /^Block\s+[A-Z]\d*\s+(?=\S)/,    // "Block A Sector 45" → "Sector 45"
  /^Pocket\s+[A-Z]\d*\s+(?=\S)/,   // "Pocket H Sarita Vihar" → "Sarita Vihar"
  /^Phase\s+\d+\s+(?=\S)/,         // "Phase 2 Sector 57" → "Sector 57"
];

/** Strip an overly-specific prefix from a (post-0a normalized) value. Returns
 *  the value unchanged if no pattern matches. The `(?=\S)` lookahead on each
 *  pattern ensures we never strip the entire value (e.g. bare "Block A"
 *  stays "Block A" — there's nothing meaningful after it to keep). */
export function stripGranularPrefix(value: string): string {
  for (const pattern of PREFIX_STRIP_PATTERNS) {
    const stripped = value.replace(pattern, '');
    if (stripped !== value) return stripped;
  }
  return value;
}

// ─── 0f — "Sec" abbreviation expansion ──────────────────────────────────────

const SEC_ABBREV_REGEX = /\b(?:Sec|Sector)[-\s]*(\d+[A-Za-z]?)\b/g;

/** Normalize "Sec N" / "Sec-N" / "SecN" / "Sector-N" / "SectorN" → "Sector N".
 *  No-op when the value is already canonical ("Sector 57"). Does NOT affect
 *  "Section 5", "Sector A", or other patterns where the post-Sec(tor) token
 *  doesn't start with a digit. */
export function expandSecAbbreviation(value: string): string {
  return value.replace(SEC_ABBREV_REGEX, 'Sector $1');
}

// ─── 0a — Title Case normalization ──────────────────────────────────────────

/**
 * Title Case a locality/sector value with two preservation rules:
 *   - Words whose uppercase form is in ACRONYMS stay uppercase.
 *   - Tokens matching /^\d+[a-z]?$/i are uppercased (e.g. "37d" → "37D").
 */
export function titleCaseLocality(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map(word => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      if (/^\d+[a-z]?$/i.test(word)) return word.toUpperCase();
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

// ─── 0b — Synonym merge ─────────────────────────────────────────────────────

export function applySynonym(city: City, value: string): string {
  const map = (localitySynonyms as Record<string, Record<string, string>>)[city];
  if (!map) return value;
  return map[value] ?? value;
}

// ─── 0c — Road-aggregator decomposition ─────────────────────────────────────

export type DecomposeResult =
  | { kind: 'unchanged' }
  | { kind: 'title_regex'; rewritten: string }
  | { kind: 'society_lookup'; rewritten: string }
  | { kind: 'unresolved' };

export function decomposeRoadAggregator(
  city: City,
  locality_sector: string,
  society: string | undefined,
  title: string | undefined,
): DecomposeResult {
  if (!ROAD_AGGREGATORS.has(aggregatorKey(city, locality_sector))) {
    return { kind: 'unchanged' };
  }

  if (title) {
    const match = title.match(TITLE_SECTOR_REGEX);
    if (match && match[1]) {
      return { kind: 'title_regex', rewritten: `Sector ${match[1].toUpperCase()}` };
    }
  }

  if (society) {
    const overrides = societySectorOverrides as Record<string, string>;
    const override = overrides[society];
    if (override) {
      return { kind: 'society_lookup', rewritten: override };
    }
  }

  return { kind: 'unresolved' };
}

// ─── Per-row composition ────────────────────────────────────────────────────

function isValidCity(s: string): s is City {
  return s === 'Gurgaon' || s === 'Delhi';
}

interface PerRowResult {
  preprocessed: PreprocessedCSVRow | null;
  unresolved: UnresolvedRow | null;
  delta: {
    title_regex: 0 | 1;
    society_lookup: 0 | 1;
    unchanged: 0 | 1;
    synonym: 0 | 1;
    prefix_stripped: 0 | 1;
    sec_expanded: 0 | 1;
  };
}

function preprocessRow(row: RawCSVRow, row_index: number): PerRowResult {
  const ZERO = { title_regex: 0, society_lookup: 0, unchanged: 0, synonym: 0, prefix_stripped: 0, sec_expanded: 0 } as const;
  const original_locality = row['Locality/Sector'] ?? '';

  if (!isValidCity(row.City)) {
    return {
      preprocessed: null,
      unresolved: {
        row_index,
        city: row.City,
        original_locality_sector: original_locality,
        normalized_locality_sector: original_locality,
        society: row.Society,
        title: row.Title,
        reason: 'invalid_city',
      },
      delta: ZERO,
    };
  }

  // 0a
  const normalized = titleCaseLocality(original_locality);

  // 0d — junk value check
  if (isJunkValue(normalized)) {
    return {
      preprocessed: null,
      unresolved: {
        row_index,
        city: row.City,
        original_locality_sector: original_locality,
        normalized_locality_sector: normalized,
        society: row.Society,
        title: row.Title,
        reason: 'junk_value',
      },
      delta: ZERO,
    };
  }

  // 0e — prefix stripping (Block X / Pocket X / Phase N)
  const stripped = stripGranularPrefix(normalized);
  const prefix_strip_delta: 0 | 1 = stripped !== normalized ? 1 : 0;

  // 0f — "Sec" abbreviation expansion
  const sec_expanded = expandSecAbbreviation(stripped);
  const sec_expanded_delta: 0 | 1 = sec_expanded !== stripped ? 1 : 0;

  // 0b
  const after_synonym = applySynonym(row.City, sec_expanded);
  const synonym_delta: 0 | 1 = after_synonym !== sec_expanded ? 1 : 0;
  // 0c
  const decompose = decomposeRoadAggregator(row.City, after_synonym, row.Society, row.Title);

  if (decompose.kind === 'unresolved') {
    return {
      preprocessed: null,
      unresolved: {
        row_index,
        city: row.City,
        original_locality_sector: original_locality,
        normalized_locality_sector: after_synonym,
        society: row.Society,
        title: row.Title,
        reason: 'road_aggregator_unresolved',
      },
      delta: { ...ZERO, synonym: synonym_delta, prefix_stripped: prefix_strip_delta, sec_expanded: sec_expanded_delta },
    };
  }

  const final_locality = decompose.kind === 'unchanged' ? after_synonym : decompose.rewritten;

  return {
    preprocessed: { ...row, City: row.City, 'Locality/Sector': final_locality },
    unresolved: null,
    delta: {
      title_regex: decompose.kind === 'title_regex' ? 1 : 0,
      society_lookup: decompose.kind === 'society_lookup' ? 1 : 0,
      unchanged: decompose.kind === 'unchanged' ? 1 : 0,
      synonym: synonym_delta,
      prefix_stripped: prefix_strip_delta,
      sec_expanded: sec_expanded_delta,
    },
  };
}

// ─── Public entry point ─────────────────────────────────────────────────────

export function preprocessRows(rows: RawCSVRow[]): PreprocessOutcome {
  const preprocessed: PreprocessedCSVRow[] = [];
  const unresolved: UnresolvedRow[] = [];
  let title_regex = 0;
  let society_lookup = 0;
  let unchanged = 0;
  let synonym = 0;
  let prefix_stripped = 0;
  let sec_expanded = 0;
  const bySkipReason: Record<UnresolvedReason, number> = {
    invalid_city: 0,
    junk_value: 0,
    road_aggregator_unresolved: 0,
  };

  for (const [i, row] of rows.entries()) {
    const result = preprocessRow(row, i);
    if (result.preprocessed) preprocessed.push(result.preprocessed);
    if (result.unresolved) {
      unresolved.push(result.unresolved);
      bySkipReason[result.unresolved.reason]++;
    }
    title_regex += result.delta.title_regex;
    society_lookup += result.delta.society_lookup;
    unchanged += result.delta.unchanged;
    synonym += result.delta.synonym;
    prefix_stripped += result.delta.prefix_stripped;
    sec_expanded += result.delta.sec_expanded;
  }

  return {
    preprocessed,
    unresolved,
    stats: {
      input_rows: rows.length,
      output_rows: preprocessed.length,
      decomposed_via_title_regex: title_regex,
      decomposed_via_society_lookup: society_lookup,
      unchanged,
      unresolved_count: unresolved.length,
      synonym_merges_applied: synonym,
      prefix_stripped,
      sec_expanded,
      bySkipReason,
    },
  };
}