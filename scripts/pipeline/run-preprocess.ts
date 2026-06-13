/**
 * scripts/pipeline/run-preprocess.ts
 *
 * CLI entry for stage 0. Reads data-raw/rentals.csv, runs preprocessing, writes
 * the cleaned audit CSV to data-raw/rentals-preprocessed.csv, and prints stats
 * + unresolved-row log.
 *
 * Invoke via: `npm run pipeline:preprocess`
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { preprocessRows, type RawCSVRow } from './preprocess';

const INPUT_PATH = path.resolve(process.cwd(), 'data-raw/rentals.csv');
const OUTPUT_PATH = path.resolve(process.cwd(), 'data-raw/rentals-preprocessed.csv');

function main(): void {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`[stage 0] Input CSV not found: ${INPUT_PATH}`);
    console.error('Place the consolidated rentals.csv at data-raw/ and re-run.');
    process.exit(1);
  }

  const csvText = fs.readFileSync(INPUT_PATH, 'utf-8');
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawCSVRow[];

  console.log(`[stage 0] Loaded ${records.length} rows from ${INPUT_PATH}`);

  const { preprocessed, unresolved, stats } = preprocessRows(records);

  console.log('\n[stage 0] Stats:');
  console.log(`  Input rows:                       ${stats.input_rows}`);
  console.log(`  Output rows:                      ${stats.output_rows}`);
  console.log(`    unchanged (not a road agg):     ${stats.unchanged}`);
  console.log(`    decomposed via Title regex:     ${stats.decomposed_via_title_regex}`);
  console.log(`    decomposed via Society lookup:  ${stats.decomposed_via_society_lookup}`);
  console.log(`  Synonym merges applied:           ${stats.synonym_merges_applied}`);
  console.log(`  Unresolved (dropped):             ${stats.unresolved_count}`);

  const csvOutput = stringify(preprocessed, { header: true });
  fs.writeFileSync(OUTPUT_PATH, csvOutput);
  console.log(`\n[stage 0] Wrote ${preprocessed.length} rows to ${OUTPUT_PATH}`);

  if (unresolved.length > 0) {
    console.error(`\n[stage 0] ${unresolved.length} unresolved rows (dropped):\n`);
    for (const u of unresolved) {
      const titleSnippet = (u.title ?? '').slice(0, 80);
      console.error(
        `  row ${u.row_index} [${u.city}] "${u.normalized_locality_sector}" | ` +
        `society="${u.society ?? '(none)'}" | title="${titleSnippet}" | ` +
        `reason=${u.reason}`,
      );
    }
    console.error(
      '\n[stage 0] To resolve: add high-frequency societies to ' +
      'data/society-sector-overrides.json and re-run.',
    );
  }
}

main();