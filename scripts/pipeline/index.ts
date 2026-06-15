#!/usr/bin/env tsx
// scripts/pipeline/index.ts
//
// Pipeline orchestrator — runs read → stage 0 (preprocess) → stage 1 (validate)
// → stage 2 (resolve) → stage 3 (backfill) in-process. Single command:
// `npm run build:data`.
//
// Output: ResolvedRow[] in memory. Disk emit (rent ranges, society aggregation,
// JSON write) comes in later chats — see product-spec §10.3 stages 4–7.

import { readRawCsv, validateRows } from './parse-csv';
import { preprocessRows } from './preprocess';
import { resolveLocalities, persistNewRecords } from './resolve-locality';
import { backfillFields } from './backfill-fields';

const RAW_CSV = 'data-raw/rentals.csv';

async function main() {
  const bar = '━'.repeat(64);
  console.log(bar);
  console.log('AreaSense data pipeline — read → stage 0 → 1 → 2 → 3');
  console.log(bar);

  // -------- Read raw CSV (loose RawCSVRow[]) --------
  console.log('\n[read] loading raw CSV...');
  const tRead = Date.now();
  const rawRows = readRawCsv(RAW_CSV);
  console.log(`  ${rawRows.length} rows loaded in ${Date.now() - tRead}ms`);

  // -------- Stage 0 — preprocess --------
  console.log('\n[stage 0] preprocessing (case-norm → synonyms → road-agg decompose)...');
  const t0 = Date.now();
  const pre = preprocessRows(rawRows);
  console.log(`  kept ${pre.stats.output_rows} of ${pre.stats.input_rows} (${Date.now() - t0}ms)`);
  console.log(`    title_regex decomposed:    ${pre.stats.decomposed_via_title_regex}`);
  console.log(`    society_lookup decomposed: ${pre.stats.decomposed_via_society_lookup}`);
  console.log(`    unchanged:                 ${pre.stats.unchanged}`);
  console.log(`    synonym_merges_applied:    ${pre.stats.synonym_merges_applied}`);
  console.log(`    prefix_stripped:           ${pre.stats.prefix_stripped}`);
  console.log(`    sec_expanded:              ${pre.stats.sec_expanded}`);
  console.log(`    unresolved (dropped):      ${pre.stats.unresolved_count}`);
  if (pre.stats.unresolved_count > 0) {
    console.log('    by reason:');
    for (const [reason, count] of Object.entries(pre.stats.bySkipReason)) {
      if (count > 0) console.log(`      ${reason}: ${count}`);
    }
  }

  // -------- Stage 1 — validate preprocessed rows --------
  console.log('\n[stage 1] validating + type-coercing preprocessed rows...');
  const t1 = Date.now();
  const validated = validateRows(pre.preprocessed);
  console.log(`  validated ${validated.rows.length} rows (${validated.invalidCount} invalid dropped) in ${Date.now() - t1}ms`);

  // -------- Stage 2 — resolve localities --------
  console.log('\n[stage 2] resolving localities (tier 1 mapping → tier 2 existing → tier 3 bootstrap)...');
  const t2 = Date.now();
  const resolve = await resolveLocalities(validated.rows);
  console.log(`  resolved: ${resolve.stats.resolved} / ${resolve.stats.total} (${Date.now() - t2}ms)`);
  console.log(`    tier 1 (mapping):   ${resolve.stats.byTier.mapping}`);
  console.log(`    tier 2 (existing):  ${resolve.stats.byTier.existing}`);
  console.log(`    tier 3 (bootstrap): ${resolve.stats.byTier.bootstrap} (${resolve.stats.bootstrapCalls} API calls)`);
  console.log(`  new locality records: ${resolve.newRecords.length}`);
  console.log(`  skipped: ${resolve.stats.skipped}`);
  if (resolve.stats.skipped > 0) {
    console.log('    by reason:');
    for (const [reason, count] of Object.entries(resolve.stats.bySkipReason)) {
      console.log(`      ${reason}: ${count}`);
    }
  }
  // -------- Tier-3 persistence (chat 1c item 4) --------
  // Runs BEFORE the cap-hit warning so successful bootstraps are saved
  // even when the cap fires later in the run. Without this ordering, every
  // cap-hit run would discard the records it paid for.
  if (resolve.newRecords.length > 0) {
    console.log('\n[persist] writing new tier-3 locality records to disk...');
    const persistResult = persistNewRecords(resolve.newRecords);
    for (const [city, counts] of Object.entries(persistResult.perCity)) {
      if (counts.added > 0 || counts.duplicates > 0) {
        console.log(`  ${city}: +${counts.added} added, ${counts.duplicates} duplicates, total now ${counts.total}`);
      }
    }
    console.log(`  files written: ${persistResult.filesWritten.join(', ') || '(none)'}`);
  }

  if (resolve.stats.bootstrapCapReached) {
    console.warn('\n[orchestrator] WARN — tier-3 bootstrap cap reached; resolution is partial.');
    console.warn('  Successful bootstraps from this run have been persisted above.');
    console.warn('  Re-run `npm run build:data` to continue resolving the remainder');
    console.warn('  (previously-persisted records will hit tier 2 and free up the cap).');
    process.exitCode = 1; // non-zero for CI; doesn't abort, so stage 3 still runs
  }

  // -------- Stage 3 — backfill BHK / Property_Type --------
  console.log('\n[stage 3] backfilling BHK / Property_Type from Title...');
  const t3 = Date.now();
  const backfill = backfillFields(resolve.resolved);
  console.log(`  done in ${Date.now() - t3}ms`);
  console.log(`    BHK backfilled:              ${backfill.stats.bhkBackfilled}`);
  console.log(`    Property_Type backfilled:    ${backfill.stats.propertyTypeBackfilled}`);
  console.log(`    BHK still missing:           ${backfill.stats.bhkStillMissing}`);
  console.log(`    Property_Type still missing: ${backfill.stats.propertyTypeStillMissing}`);

  // -------- summary --------
  console.log('\n' + bar);
  console.log(`Done. ${backfill.rows.length} resolved + backfilled rows in memory.`);
  console.log(`New tier-3 locality records produced this run: ${resolve.newRecords.length}`);
  console.log('Next: disk emit (rent ranges + society aggregation + JSON write) — later chats.');
  console.log(bar);
}

main().catch((e) => {
  console.error('\n[pipeline] FATAL:', e);
  process.exit(1);
});
