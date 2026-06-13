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
  };
}

function preprocessRow(row: RawCSVRow, row_index: number): PerRowResult {
  const ZERO = { title_regex: 0, society_lookup: 0, unchanged: 0, synonym: 0 } as const;
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
  // 0b
  const after_synonym = applySynonym(row.City, normalized);
  const synonym_delta: 0 | 1 = after_synonym !== normalized ? 1 : 0;
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
      delta: { ...ZERO, synonym: synonym_delta },
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

  for (const [i, row] of rows.entries()) {
    const result = preprocessRow(row, i);
    if (result.preprocessed) preprocessed.push(result.preprocessed);
    if (result.unresolved) unresolved.push(result.unresolved);
    title_regex += result.delta.title_regex;
    society_lookup += result.delta.society_lookup;
    unchanged += result.delta.unchanged;
    synonym += result.delta.synonym;
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
    },
  };
}