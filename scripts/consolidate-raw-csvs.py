#!/usr/bin/env python3
"""
scripts/consolidate-raw-csvs.py — One-time consolidation of raw scraper CSVs
into the canonical 13-column data-raw/rentals.csv used by the data pipeline.

Reads from --input-dir (default: data-raw/sources/), detects each file's
scraper format by column inspection (not filename), extracts a 13-col record
per row, applies dedup Key B (Society + BHK + Rent_INR + Area_Sqft), and
writes the consolidated CSV + a JSON report.

13-column canonical schema (matches RawListingRecord in types/pipeline.ts):
  Title, Property_Type, BHK, Rent_INR, Area_Sqft, Furnishing, Bathrooms,
  Floor, Society, City, Locality/Sector, Tenant_Preference, Key_Features

Studio rows are dropped per v0 product decision.
"""
import argparse
import json
import re
import sys
from pathlib import Path
from collections import Counter

import pandas as pd
import numpy as np

# ============================================================================
# Shared parsing helpers
# ============================================================================

CANONICAL_COLUMNS = [
    "Title", "Property_Type", "BHK", "Rent_INR", "Area_Sqft", "Furnishing",
    "Bathrooms", "Floor", "Society", "City", "Locality/Sector",
    "Tenant_Preference", "Key_Features",
]

VALID_TENANT_PREFS = {"Bachelors", "Bachelors/Family", "Family", "Any"}
VALID_FURNISHING = {"Furnished", "Semi-Furnished", "Unfurnished"}

CITY_PATTERNS = [
    (re.compile(r'\b(?:new\s+delhi|delhi)\b', re.IGNORECASE), "Delhi"),
    (re.compile(r'\b(?:gurgaon|gurugram)\b', re.IGNORECASE), "Gurgaon"),
]


def find_city_rightmost(text):
    """
    Find the RIGHTMOST city match across all CITY_PATTERNS. Handles
    titles like 'Sector 37C, Delhi Gurgaon Expressway Gurgaon' where
    'Delhi' appears as part of a road name but the actual city is
    the trailing 'Gurgaon'.
    Returns (city_name, match_object) or (None, None).
    """
    best = None  # (end_pos, name, match)
    for pat, name in CITY_PATTERNS:
        for m in pat.finditer(text):
            if best is None or m.end() > best[0]:
                best = (m.end(), name, m)
    if best is None:
        return None, None
    return best[1], best[2]


def parse_title(title):
    """
    Parse a listing title into (bhk, property_type, society, locality, city).
    Returns dict or None if unparseable.
    Title pattern: "{N} BHK {Property_Type} for [Rr]ent in {chain...}"
    """
    if not isinstance(title, str) or not title.strip():
        return None

    m = re.match(
        r'^\s*(?P<bhk>\d+|Studio|1\s*RK)\s*(?:BHK)?\s+(?P<ptype>.+?)\s+for\s+[Rr]ent\s+in\s+(?P<rest>.+)$',
        title.strip(),
    )
    if not m:
        return None

    bhk_raw = m.group("bhk").strip()
    if re.match(r'(?i)^(?:studio|1\s*RK)$', bhk_raw):
        bhk = "studio"
    else:
        try:
            n = int(bhk_raw)
        except ValueError:
            return None
        bhk = str(n) if n <= 3 else "4+"

    ptype = m.group("ptype").strip()
    rest = m.group("rest").strip().rstrip(".")

    # City: find the rightmost city match in the last comma-separated part.
    # If not present in the last part, scan the whole rest string. The
    # rightmost-match rule correctly handles titles like 'Delhi Gurgaon
    # Expressway Gurgaon' where city tokens appear inside road names.
    city = None
    parts = [p.strip() for p in rest.split(",") if p.strip()]
    if parts:
        last = parts[-1]
        name, match = find_city_rightmost(last)
        if name:
            city = name
            last_stripped = (last[:match.start()] + last[match.end():]).strip(" ,.-")
            if last_stripped:
                parts[-1] = last_stripped
            else:
                parts.pop()
        else:
            # No city in last comma-part; try the whole rest string
            name, match = find_city_rightmost(rest)
            if name:
                city = name
                rest_no_city = (rest[:match.start()] + rest[match.end():]).strip(" ,.-")
                parts = [p.strip() for p in rest_no_city.split(",") if p.strip()]

    if not parts:
        return None  # nothing left for locality

    if len(parts) == 1:
        society = None
        locality = parts[0]
    else:
        society = parts[0]
        locality = parts[-1]  # locality closest to city

    return {
        "bhk": bhk,
        "property_type": ptype,
        "society": society,
        "locality": locality,
        "city": city,
    }


def parse_rent(value):
    """Parse rent value to integer INR. Handles ₹, commas, Lac, Cr, newlines."""
    if value is None:
        return None
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, float):
        if pd.isna(value):
            return None
        return int(value)
    if not isinstance(value, str):
        return None
    s = value.strip().replace("\n", " ").replace("₹", "").strip()
    if not s:
        return None
    lac = re.search(r'([\d,.]+)\s*Lac', s, re.IGNORECASE)
    if lac:
        try:
            return int(float(lac.group(1).replace(",", "")) * 100_000)
        except ValueError:
            return None
    cr = re.search(r'([\d,.]+)\s*Cr', s, re.IGNORECASE)
    if cr:
        try:
            return int(float(cr.group(1).replace(",", "")) * 10_000_000)
        except ValueError:
            return None
    plain = re.search(r'[\d,]+', s)
    if plain:
        try:
            return int(plain.group(0).replace(",", ""))
        except ValueError:
            return None
    return None


# Context-aware rent extraction from free-text descriptions. Strategy: find
# every ₹-amount in the text, then for each candidate, inspect ±60 chars of
# surrounding text. Accept if it's near the word "rent" and NOT near
# maintenance / deposit / brokerage. This catches all the natural phrasings
# in the source data ("rent of ₹X", "₹X is the monthly rent", "rent of the
# 4 BHK flat is ₹X", etc.) without hand-listing each template.
RENT_AMOUNT_PATTERN = re.compile(
    r'₹\s*([\d,]+(?:\.\d+)?)\s*(Lac|Cr)?',
    re.IGNORECASE,
)
RENT_CONTEXT_EXCLUDE = ("maintenance", "deposit", "security", "brokerage", "broker fee")


def parse_rent_from_text(text):
    """
    Fallback rent extractor for cases where the structured rent column is
    missing/NaN — scans description / Key_Features for ₹-amounts whose
    surrounding context mentions 'rent' and not 'maintenance' / 'deposit'.
    Returns the first qualifying amount as integer INR.
    """
    if not isinstance(text, str):
        return None
    lower = text.lower()
    for m in RENT_AMOUNT_PATTERN.finditer(text):
        # ±60 chars window around the match for context
        start = max(0, m.start() - 60)
        end = min(len(text), m.end() + 30)
        ctx = lower[start:end]
        if any(bad in ctx for bad in RENT_CONTEXT_EXCLUDE):
            continue
        if "rent" not in ctx:
            continue
        try:
            n = float(m.group(1).replace(",", ""))
            suffix = m.group(2)
            if suffix and suffix.lower() == "lac":
                value = int(n * 100_000)
            elif suffix and suffix.lower() == "cr":
                value = int(n * 10_000_000)
            else:
                value = int(n)
            # Sanity: realistic Indian rental range
            if 1_000 <= value <= 10_000_000:
                return value
        except ValueError:
            continue
    return None


def parse_area(value):
    """Parse area to integer sqft. Accepts '280 sqft', '1,296 sqft', plain ints."""
    if value is None:
        return None
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, float):
        if pd.isna(value):
            return None
        return int(value)
    if not isinstance(value, str):
        return None
    m = re.search(r'([\d,]+)\s*(?:sqft|sq\.?\s*ft)', value, re.IGNORECASE)
    if m:
        try:
            return int(m.group(1).replace(",", ""))
        except ValueError:
            return None
    m = re.match(r'\s*([\d,]+)\s*$', value)
    if m:
        try:
            return int(m.group(1).replace(",", ""))
        except ValueError:
            return None
    return None


def parse_bathrooms(value):
    """Parse bathroom count. Accepts ints or strings like '2 Baths'."""
    if value is None:
        return None
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, float):
        if pd.isna(value):
            return None
        return int(value)
    if isinstance(value, str):
        m = re.search(r'(\d+)', value)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                return None
    return None


def normalize_tenant_pref(value):
    """Validate tenant pref value is in the expected set; else None."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    return v if v in VALID_TENANT_PREFS else None


def normalize_furnishing(value):
    """Validate furnishing value is in the expected set; else None."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    return v if v in VALID_FURNISHING else None


def safe_str(value):
    """Return str(value) if string-and-nonempty, else None."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


# ============================================================================
# Bucket detection + per-bucket row parsers
# ============================================================================

def detect_bucket(df_columns):
    """Detect scraper bucket from columns. Order matters."""
    cols = set(df_columns)
    if "mb-srp__card--title" in cols:
        return "magicbricks"
    if "Property_Type" in cols:
        return "master"
    if "Title_URL" in cols:
        return "99acres"
    return "unknown"


def parse_magicbricks_row(row, df_columns):
    """Bucket A: Magicbricks per-BHK + raw magicbricks files.
    Structured columns are unreliable across files (positions drift); rely
    on Title parsing for the location/BHK essentials.
    """
    title = row.get("mb-srp__card--title")
    if not isinstance(title, str):
        return None, "missing_title"

    parsed = parse_title(title)
    if not parsed or not parsed["city"] or not parsed["locality"]:
        return None, "title_unparseable"

    # Rent: 'rent' column preferred, fall back to 'mb-srp__card__price--amount',
    # then to scanning the description text (handles magicbricks.csv which has
    # no structured rent column at all).
    rent_raw = row.get("rent") if "rent" in df_columns else row.get("mb-srp__card__price--amount")
    rent = parse_rent(rent_raw)
    key_features = safe_str(row.get("mb-srp__card--desc--text"))
    if rent is None:
        rent = parse_rent_from_text(key_features)
    if rent is None:
        return None, "missing_rent"

    # Society: prefer dedicated column when present and non-empty
    society = safe_str(row.get("mb-srp__card__society--name")) or parsed["society"]

    # Furnishing: try 'status- furnishing' first, then the value column.
    furnishing = (
        normalize_furnishing(row.get("status- furnishing"))
        or normalize_furnishing(row.get("mb-srp__card__summary--value"))
    )

    tenant_pref = normalize_tenant_pref(row.get("tenant preference"))

    area = parse_area(row.get("area"))

    floor = safe_str(row.get("floor"))

    return {
        "Title": title,
        "Property_Type": parsed["property_type"],
        "BHK": parsed["bhk"],
        "Rent_INR": rent,
        "Area_Sqft": area,
        "Furnishing": furnishing,
        "Bathrooms": None,  # unreliable in Bucket A
        "Floor": floor,
        "Society": society,
        "City": parsed["city"],
        "Locality/Sector": parsed["locality"],
        "Tenant_Preference": tenant_pref,
        "Key_Features": key_features,
    }, None


def parse_99acres_row(row, df_columns):
    """Bucket B: 99acres-scraped. Cleaner structured columns."""
    title = row.get("Title")
    if not isinstance(title, str):
        return None, "missing_title"

    parsed = parse_title(title)
    if not parsed or not parsed["city"] or not parsed["locality"]:
        return None, "title_unparseable"

    rent = parse_rent(row.get("Price"))
    if rent is None:
        return None, "missing_rent"

    area = parse_area(row.get("tuplenew_areawrap"))

    # Society: prefer 'Location' column (cleaner than Title-parsed)
    society = safe_str(row.get("Location")) or parsed["society"]

    bathrooms = parse_bathrooms(row.get("Type4"))

    key_features = safe_str(row.get("Description"))

    return {
        "Title": title,
        "Property_Type": parsed["property_type"],
        "BHK": parsed["bhk"],
        "Rent_INR": rent,
        "Area_Sqft": area,
        "Furnishing": None,
        "Bathrooms": bathrooms,
        "Floor": None,
        "Society": society,
        "City": parsed["city"],
        "Locality/Sector": parsed["locality"],
        "Tenant_Preference": None,  # not in 99acres data
        "Key_Features": key_features,
    }, None


def parse_master_row(row, df_columns):
    """Bucket C: Existing 12-col master file."""
    title = row.get("Title")
    if not isinstance(title, str):
        return None, "missing_title"

    parsed = parse_title(title)
    if not parsed:
        return None, "title_unparseable"

    # Master is Gurgaon-only by convention; default if title didn't carry city
    city = parsed["city"] or "Gurgaon"

    rent = parse_rent(row.get("Rent_INR"))
    if rent is None:
        # Fallback: extract from Key_Features text
        rent = parse_rent_from_text(safe_str(row.get("Key_Features")))
    if rent is None:
        return None, "missing_rent"

    area = parse_area(row.get("Area_Sqft"))

    # Society: prefer structured column
    society = safe_str(row.get("Society")) or parsed["society"]

    # Locality: prefer title-parsed (cleaner). Master's Locality field is messy.
    locality = parsed["locality"]
    if not locality:
        loc_field = safe_str(row.get("Locality"))
        if loc_field:
            tail = [p.strip() for p in loc_field.split(",") if p.strip()]
            if tail:
                locality = tail[-1]
    if not locality:
        return None, "missing_locality"

    return {
        "Title": title,
        "Property_Type": safe_str(row.get("Property_Type")) or parsed["property_type"],
        "BHK": parsed["bhk"],
        "Rent_INR": rent,
        "Area_Sqft": area,
        "Furnishing": normalize_furnishing(row.get("Furnishing")),
        "Bathrooms": parse_bathrooms(row.get("Bathrooms")),
        "Floor": safe_str(row.get("Floor")),
        "Society": society,
        "City": city,
        "Locality/Sector": locality,
        "Tenant_Preference": normalize_tenant_pref(row.get("Tenant_Preference")),
        "Key_Features": safe_str(row.get("Key_Features")),
    }, None


BUCKET_PARSERS = {
    "magicbricks": parse_magicbricks_row,
    "99acres": parse_99acres_row,
    "master": parse_master_row,
}


# ============================================================================
# Main
# ============================================================================

def consolidate(input_dir, output_csv, report_json):
    input_dir = Path(input_dir)
    csv_files = sorted(input_dir.glob("*.csv"))
    if not csv_files:
        print(f"ERROR: No CSVs found in {input_dir}", file=sys.stderr)
        sys.exit(1)

    per_file_stats = []
    all_rows = []
    drop_reasons_total = Counter()

    for f in csv_files:
        try:
            df = pd.read_csv(f, low_memory=False)
        except Exception as e:
            per_file_stats.append({"file": f.name, "error": str(e)})
            continue

        bucket = detect_bucket(df.columns)
        parser = BUCKET_PARSERS.get(bucket)
        if parser is None:
            per_file_stats.append({
                "file": f.name, "bucket": bucket, "rows_in": len(df),
                "rows_out": 0, "drops": {"unknown_bucket": len(df)},
            })
            drop_reasons_total["unknown_bucket"] += len(df)
            continue

        df_columns = set(df.columns)
        rows_out = 0
        file_drops = Counter()

        for _, row in df.iterrows():
            parsed, drop_reason = parser(row.to_dict(), df_columns)
            if parsed is None:
                file_drops[drop_reason] += 1
                drop_reasons_total[drop_reason] += 1
                continue
            if parsed["BHK"] == "studio":
                file_drops["studio_dropped"] += 1
                drop_reasons_total["studio_dropped"] += 1
                continue
            parsed["_source_file"] = f.name
            all_rows.append(parsed)
            rows_out += 1

        per_file_stats.append({
            "file": f.name, "bucket": bucket,
            "rows_in": len(df), "rows_out": rows_out,
            "drops": dict(file_drops),
        })

    if not all_rows:
        print("ERROR: No rows extracted from any file.", file=sys.stderr)
        sys.exit(1)

    combined = pd.DataFrame(all_rows)
    pre_dedup = len(combined)

    # Dedup Key B: Society + BHK + Rent_INR + Area_Sqft.
    # NaN values would normally NOT match each other in pandas drop_duplicates,
    # which would defeat dedup for rows missing Society or Area. Fill with
    # explicit sentinels for the dedup key only.
    combined["_d_society"] = (
        combined["Society"].fillna("__NONE__").astype(str).str.strip().str.lower()
    )
    combined["_d_area"] = combined["Area_Sqft"].fillna(-1).astype(int)
    deduped = combined.drop_duplicates(
        subset=["_d_society", "BHK", "Rent_INR", "_d_area"],
        keep="first",
    ).copy()
    deduped = deduped.drop(columns=["_d_society", "_d_area"])
    post_dedup = len(deduped)
    collapse_count = pre_dedup - post_dedup

    source_contribution = deduped["_source_file"].value_counts().to_dict()
    final = deduped.drop(columns=["_source_file"])[CANONICAL_COLUMNS]

    output_csv = Path(output_csv)
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    final.to_csv(output_csv, index=False)

    # BHK × City matrix on final
    bhk_x_city = pd.crosstab(final["BHK"], final["City"], dropna=False, margins=True)

    # Top localities by row count, for spot-checking
    top_localities = (
        final.groupby(["City", "Locality/Sector"]).size()
        .sort_values(ascending=False).head(25).to_dict()
    )
    # JSON keys must be strings, not tuples
    top_localities_json = {f"{k[0]} | {k[1]}": v for k, v in top_localities.items()}

    # Per-(locality, BHK) cells passing MIN_SAMPLE_SIZE=5
    cell_counts = final.groupby(["City", "Locality/Sector", "BHK"]).size().reset_index(name="n")
    cells_above = (cell_counts["n"] >= 5).sum()
    cells_below = (cell_counts["n"] < 5).sum()
    distinct_localities = final.groupby("City")["Locality/Sector"].nunique().to_dict()

    report = {
        "summary": {
            "total_rows_in": sum(p.get("rows_in", 0) for p in per_file_stats),
            "rows_after_parsing": pre_dedup,
            "rows_collapsed_by_dedup": collapse_count,
            "final_row_count": post_dedup,
            "dedup_key": "Society + BHK + Rent_INR + Area_Sqft",
            "drop_reasons_total": dict(drop_reasons_total),
        },
        "coverage": {
            "distinct_localities_per_city": distinct_localities,
            "cells_locality_x_bhk_total": int(len(cell_counts)),
            "cells_above_min_sample_5": int(cells_above),
            "cells_below_min_sample_5": int(cells_below),
        },
        "bhk_x_city_matrix": bhk_x_city.to_dict(),
        "per_file": per_file_stats,
        "source_file_contribution_post_dedup": source_contribution,
        "top_25_localities_by_row_count": top_localities_json,
    }

    Path(report_json).parent.mkdir(parents=True, exist_ok=True)
    with open(report_json, "w") as fp:
        json.dump(report, fp, indent=2, default=str)

    print(f"\n{'='*64}")
    print("CONSOLIDATION COMPLETE")
    print(f"{'='*64}")
    print(f"  Rows in:        {report['summary']['total_rows_in']}")
    print(f"  After parse:    {pre_dedup}")
    print(f"  Dedup collapse: {collapse_count}")
    print(f"  Final output:   {post_dedup}  →  {output_csv}")
    print(f"  Report:         {report_json}")
    print(f"\n  BHK × City:")
    print(bhk_x_city.to_string())
    print(f"\n  Drop reasons: {dict(drop_reasons_total)}")
    print(f"\n  Distinct localities per city: {distinct_localities}")
    print(f"  (locality × BHK) cells: {len(cell_counts)} total, "
          f"{cells_above} ≥5 listings, {cells_below} <5")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--input-dir", default="data-raw/sources",
                   help="Directory containing raw scraper CSVs (default: data-raw/sources)")
    p.add_argument("--output", default="data-raw/rentals.csv",
                   help="Path for canonical 13-col CSV (default: data-raw/rentals.csv)")
    p.add_argument("--report", default="data-raw/consolidation-report.json",
                   help="Path for JSON consolidation report (default: data-raw/consolidation-report.json)")
    args = p.parse_args()
    consolidate(args.input_dir, args.output, args.report)
