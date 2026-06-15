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
import { computeRentRanges, filterByMinSamples } from './compute-rent-ranges';
import { aggregateSocieties } from './aggregate-societies';
import { emitJson } from './emit-json';
import { PIPELINE_CONFIG } from '@/types/config';
import { readFileSync } from 'fs';
import type { LocalityRecord } from '@/types/data';
import type { Coordinates, LocalityId } from '@/types/primitives';

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

  // -------- Stage 4 — compute per-(locality, BHK) rent ranges --------
  console.log('\n[stage 4] computing per-(locality, BHK) base-rent ranges...');
  const t4 = Date.now();
  const rentRanges = computeRentRanges(backfill.rows);
  console.log(`  done in ${Date.now() - t4}ms`);
  console.log(`    rows used:                     ${rentRanges.summary.rowsUsed}`);
  console.log(`    rows skipped (invalid rent):   ${rentRanges.summary.rowsSkippedInvalidRent}`);
  console.log(`    rows skipped (invalid BHK):    ${rentRanges.summary.rowsSkippedInvalidBhk}`);
  console.log(`    cells emitted:                 ${rentRanges.summary.cellsEmitted}`);
  console.log(`    cells meeting MIN_SAMPLE_SIZE: ${rentRanges.summary.cellsMeetingMinSamples}`);

  // Smoke-test sample — top 10 cells by sample size (highest-confidence signals).
  // If these look reasonable for known localities (DLF Phase 4, Sec 65, etc.)
  // and the rents look like real Indian rental numbers (₹15k–3L range, low < high),
  // Stage 4 is producing sensible output.
  const topCells = Array.from(rentRanges.ranges.values())
    .sort((a, b) => b.sampleSize - a.sampleSize)
    .slice(0, 10);
  if (topCells.length > 0) {
    console.log('\n  top 10 cells by sample size:');
    for (const cell of topCells) {
      const bhkLabel = cell.bhk === 'studio' ? 'Studio' : `${cell.bhk}BHK`;
      const fmt = (n: number) => `₹${(n / 1000).toFixed(0)}k`;
      console.log(
        `    ${cell.localityId} / ${bhkLabel}: ` +
        `${fmt(cell.low)}–${fmt(cell.high)} ` +
        `(n=${cell.sampleSize}, trimmed=${cell.trimmedCount})`,
      );
    }
  }

  // -------- Stage 5 — drop cells below MIN_SAMPLE_SIZE --------
  // Cells with < MIN_SAMPLE_SIZE listings are too thin to compute a trustworthy
  // range. v0 omits them entirely (chat 1d decision: option c — borrow-from-
  // neighbor and manual-estimate fallbacks deferred to chat 1e+).
  console.log('\n[stage 5] applying MIN_SAMPLE_SIZE threshold...');
  const t5 = Date.now();
  const filtered = filterByMinSamples(rentRanges.ranges, PIPELINE_CONFIG.MIN_SAMPLE_SIZE);
  console.log(`  done in ${Date.now() - t5}ms`);
  console.log(`    cells kept    (≥ ${PIPELINE_CONFIG.MIN_SAMPLE_SIZE} listings): ${filtered.kept}`);
  console.log(`    cells dropped (< ${PIPELINE_CONFIG.MIN_SAMPLE_SIZE} listings): ${filtered.dropped}`);

  // -------- Stage 6 — aggregate societies per locality --------
  // Reads post-persistence locality JSON to source centroids (used as society
  // coordinates per v0 — per-society geocoding deferred to v1+). Stage 7 will
  // re-read the same files for the JSON emit; that ~10ms duplication is
  // acceptable for now and can be lifted into a shared util if it bites.
  console.log('\n[stage 6] aggregating societies per locality...');
  const t6 = Date.now();

  const allLocalityRecords: LocalityRecord[] = [
    ...(JSON.parse(readFileSync('data/locality-data-gurgaon.json', 'utf-8')) as LocalityRecord[]),
    ...(JSON.parse(readFileSync('data/locality-data-delhi.json',   'utf-8')) as LocalityRecord[]),
  ];
  const centroids = new Map<LocalityId, Coordinates>();
  for (const r of allLocalityRecords) {
    centroids.set(r.id, r.centroid);
  }

  const societiesAgg = aggregateSocieties(backfill.rows, centroids);
  console.log(`  done in ${Date.now() - t6}ms`);
  console.log(`    rows skipped (no Society):    ${societiesAgg.summary.rowsSkippedNoSociety}`);
  console.log(`    rows skipped (no centroid):   ${societiesAgg.summary.rowsSkippedNoCentroid}`);
  console.log(`    societies emitted:            ${societiesAgg.summary.societiesEmitted}`);
  console.log(`    societies w/ tenant signal:   ${societiesAgg.summary.societiesWithTenantSignal}`);
  console.log(`    societies w/ rent estimate:   ${societiesAgg.summary.societiesWithRentEstimate}`);

  // Smoke-test sample — 5 societies from the locality with the most societies,
  // to eyeball signal quality + per-BHK rent shape.
  const localitiesBySocietyCount = Array.from(societiesAgg.societies.entries())
    .sort((a, b) => b[1].length - a[1].length);
  const top = localitiesBySocietyCount[0];
  if (top) {
    const [topLocalityId, topSocieties] = top;
    console.log(`\n  sample societies from ${topLocalityId} (highest count, ${topSocieties.length} total):`);
    for (const society of topSocieties.slice(0, 5)) {
      let rentSummary = '(no rent data)';
      if (society.rent_estimate_by_bhk) {
        const parts: string[] = [];
        for (const [bhk, est] of Object.entries(society.rent_estimate_by_bhk)) {
          if (est === undefined) continue;
          const label = bhk === 'studio' ? 'Studio' : `${bhk}BHK`;
          parts.push(`${label} ₹${(est.median / 1000).toFixed(0)}k (n=${est.sample_size})`);
        }
        if (parts.length > 0) rentSummary = parts.join(', ');
      }
      console.log(`    ${society.name} [${society.tenant_preference_signal}]: ${rentSummary}`);
    }
  }

  // -------- Stage 7 — emit per-city LocalityRecord JSON --------
  // Merges Stage 5 (filtered rent ranges) + Stage 6 (societies) into the
  // on-disk LocalityRecord shape. Validates every record via Zod and writes
  // atomically per city. Fail-the-build on any validation issue.
  console.log('\n[stage 7] emitting per-city LocalityRecord JSON...');
  const t7 = Date.now();
  const emitResult = emitJson({
    existingRecords:     allLocalityRecords,
    filteredRanges:      filtered.filtered,
    societiesByLocality: societiesAgg.societies,
  });
  console.log(`  done in ${Date.now() - t7}ms`);
  for (const [city, info] of Object.entries(emitResult.byCity)) {
    if (info === undefined) continue;
    console.log(`    ${city}: ${info.count} records → ${info.path}`);
  }
  console.log(`    total records written: ${emitResult.total}`);

  // -------- summary --------
  console.log('\n' + bar);
  console.log(`Done. ${backfill.rows.length} resolved + backfilled rows in memory.`);
  console.log(`New tier-3 locality records produced this run: ${resolve.newRecords.length}`);
  console.log(`Rent-range cells: ${rentRanges.summary.cellsEmitted} computed → ${filtered.kept} kept after MIN_SAMPLE_SIZE filter`);
  console.log(`Societies aggregated: ${societiesAgg.summary.societiesEmitted} across ${societiesAgg.societies.size} localities`);
  console.log(`JSON emit: ${emitResult.total} records written across ${Object.keys(emitResult.byCity).length} files`);
  console.log(bar);
}

main().catch((e) => {
  console.error('\n[pipeline] FATAL:', e);
  process.exit(1);
});

main().catch((e) => {
  console.error('\n[pipeline] FATAL:', e);
  process.exit(1);
});
