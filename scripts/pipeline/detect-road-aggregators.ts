/**
 * scripts/pipeline/detect-road-aggregators.ts
 *
 * One-shot audit. Scans data-raw/rentals.csv for (City, Locality/Sector) values
 * containing road indicators (road, expressway, highway, marg, bypass, NH),
 * sorted by row count. Use to verify the ROAD_AGGREGATORS list in
 * preprocess.ts stays in sync as the source CSV grows.
 *
 * Invoke via: `npm run pipeline:detect-roads`
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const INPUT_PATH = path.resolve(process.cwd(), 'data-raw/rentals.csv');

const ROAD_INDICATORS = ['road', 'expressway', 'highway', 'marg', 'bypass', 'nh-', 'nh '];

function isRoadName(value: string): boolean {
  const lower = value.toLowerCase();
  return ROAD_INDICATORS.some(ind => lower.includes(ind));
}

interface CountedRow { city: string; locality: string; rows: number; }

function main(): void {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`Input CSV not found: ${INPUT_PATH}`);
    process.exit(1);
  }

  const csvText = fs.readFileSync(INPUT_PATH, 'utf-8');
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<{ City: string; 'Locality/Sector': string }>;

  const counts = new Map<string, CountedRow>();
  for (const r of records) {
    const key = `${r.City}|${r['Locality/Sector']}`;
    const existing = counts.get(key);
    if (existing) existing.rows++;
    else counts.set(key, { city: r.City, locality: r['Locality/Sector'], rows: 1 });
  }

  const hits = Array.from(counts.values())
    .filter(e => isRoadName(e.locality))
    .sort((a, b) => b.rows - a.rows);

  const totalRows = hits.reduce((sum, h) => sum + h.rows, 0);

  console.log(`Distinct road-name values: ${hits.length}`);
  console.log(`Total rows in road buckets: ${totalRows}\n`);
  console.log(`City    | Locality/Sector                          | Rows`);
  console.log(`--------+------------------------------------------+-----`);
  for (const h of hits) {
    console.log(
      `${h.city.padEnd(7)} | ${h.locality.padEnd(40).slice(0, 40)} | ${String(h.rows).padStart(4)}`,
    );
  }
}

main();