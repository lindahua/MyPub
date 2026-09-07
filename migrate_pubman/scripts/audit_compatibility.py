#!/usr/bin/env python3
"""Read-only, aggregate inventory for the PubMan2 design compatibility review.

Uses only the frozen SQLite snapshot; does not connect to Supabase, convert
records, or print source payloads, names, account data, or credentials.
This is an inventory, not a version-2 catalog validator.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import uuid


def audit(path):
    result = {"snapshot_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only = ON")
        result["integrity_check"] = db.execute("PRAGMA integrity_check").fetchone()[0]
        tables = {}
        result["columns"] = {}
        for table in ("publications", "authors", "venues", "publication_authors", "gs_entries"):
            tables[table] = [dict(row) for row in db.execute(f'SELECT * FROM "mypubs.{table}"')]
            result["columns"][table] = {
                col[1]: {
                    "non_null": sum(row[col[1]] is not None for row in tables[table]),
                    "blank": sum(isinstance(row[col[1]], str) and not row[col[1]].strip()
                                 for row in tables[table]),
                }
                for col in db.execute(f'PRAGMA table_info("mypubs.{table}")')
            }
        result["rows"] = {table: len(rows) for table, rows in tables.items()}
        result["rows"]["editing_history"] = db.execute('SELECT count(*) FROM "mypubs.editing_history"').fetchone()[0]
        pubs, authors, venues, links, scholar = (tables[t] for t in tables)
        venue_by_id = {row["id"]: row for row in venues}
        pub_ids = {row["id"] for row in pubs}
        author_ids = {row["id"] for row in authors}
        all_uuids = [row["uid"] for rows in (pubs, authors, venues, scholar) for row in rows]
        result["identity"] = {
            "noncanonical_uuids": sum(str(uuid.UUID(value)) != value for value in all_uuids),
            "duplicate_uuids_across_entities": len(all_uuids) - len(set(all_uuids)),
            "orphan_authors": len(author_ids - {row["author_id"] for row in links}),
            "orphan_venues": len(set(venue_by_id) - {row["venue_id"] for row in pubs}),
            "broken_author_links": sum(row["author_id"] not in author_ids or row["publication_id"] not in pub_ids for row in links),
            "broken_venue_links": sum(row["venue_id"] not in venue_by_id for row in pubs),
            "broken_scholar_links": sum(row["publication_id"] is not None and row["publication_id"] not in pub_ids for row in scholar),
        }
        result["venue_types"] = dict(Counter(row["type"] for row in venues))
        result["publication_types_from_venue"] = dict(Counter(venue_by_id[row["venue_id"]]["type"] for row in pubs))
        result["publications"] = {
            "missing_year": sum(row["year"] is None for row in pubs),
            "year_min": min(row["year"] for row in pubs if row["year"] is not None),
            "year_max": max(row["year"] for row in pubs if row["year"] is not None),
            "date_year_conflicts": sum(row["pub_date"] is not None and row["year"] is not None and int(row["pub_date"][:4]) != row["year"] for row in pubs),
            "nonpreprint_eprints": sum(bool(row["eprint"]) and venue_by_id[row["venue_id"]]["type"] != "preprint" for row in pubs),
            "preprints_without_eprint": sum(not row["eprint"] and venue_by_id[row["venue_id"]]["type"] == "preprint" for row in pubs),
        }
        for field in ("doi", "eprint"):
            groups = defaultdict(list)
            for row in pubs:
                if row[field]:
                    value = row[field].strip().lower()
                    if field == "eprint":
                        value = re.sub(r"^arxiv:\s*", "", value)
                        value = re.sub(r"v\d+$", "", value)
                    else:
                        value = re.sub(r"^(?:doi:\s*|https?://(?:dx\.)?doi.org/)", "", value)
                    groups[value].append(row["id"])
            duplicates = [ids for ids in groups.values() if len(ids) > 1]
            result["publications"][field + "_duplicate_groups"] = duplicates

        by_pub = defaultdict(list)
        for row in links:
            by_pub[row["publication_id"]].append(row)
        marked, cleaned = set(), defaultdict(list)
        for row in authors:
            name = " ".join(row[key] for key in ("first_name", "mid_name", "last_name") if row[key])
            if "*" in name:
                marked.add(row["id"])
            cleaned[re.sub(r"\s*\*\s*$", "", name).strip()].append(row["id"])
        result["authorship"] = {
            "marked_authors": len(marked),
            "standalone_star_surnames": sum(row["last_name"].strip() == "*" for row in authors),
            "marked_slots": sum(row["author_id"] in marked for row in links),
            "marked_publications": len({row["publication_id"] for row in links if row["author_id"] in marked}),
            "marked_unreferenced_authors": len(marked - {row["author_id"] for row in links}),
            "cleaned_duplicate_name_groups": sum(len(ids) > 1 for ids in cleaned.values()),
            "cleaned_duplicate_name_rows": sum(len(ids) for ids in cleaned.values() if len(ids) > 1),
            "empty_bylines": len(pub_ids - set(by_pub)),
            "order_anomalies": sum(sorted(row["author_order"] for row in rows) != list(range(1, len(rows) + 1)) for rows in by_pub.values()),
            "repeated_author_in_publication": sum(len({row["author_id"] for row in rows}) != len(rows) for rows in by_pub.values()),
            "audit_bylines_with_star": db.execute('''SELECT count(*) FROM "mypubs.editing_history"
                WHERE entity_type = 'publication' AND json_extract(details, '$.authors') LIKE '%*%' ''').fetchone()[0],
        }
        gs = Counter()
        pub_by_id = {row["id"]: row for row in pubs}
        match_counts = Counter(row["publication_id"] for row in scholar if row["publication_id"] is not None)
        for row in scholar:
            names, bars, payload = (json.loads(row[key]) for key in ("author_names", "citations_by_year", "source_payload"))
            detail, overview = payload["detail"], payload["overview"]
            gs["active"] += bool(row["is_active"])
            gs["excluded"] += bool(row["excluded_from_matching"])
            gs["matched"] += row["publication_id"] is not None
            gs["zero_counts"] += row["cited_by_count"] == 0
            gs["empty_author_arrays"] += not names
            gs["empty_author_arrays_with_patent_office"] += not names and bool(row["patent_office"])
            gs["overview_author_ellipsis"] += "..." in row["authors"] or "…" in row["authors"]
            gs["annual_snapshots_with_bars"] += bool(bars)
            gs["annual_bars"] += len(bars)
            gs["annual_duplicate_years"] += len({bar["year"] for bar in bars}) != len(bars)
            gs["missing_year"] += row["year"] is None
            gs["citation_profile_prefix_mismatches"] += not row["citation_id"].startswith(row["profile_user_id"] + ":")
            gs["counts_newer_than_details"] += datetime.fromisoformat(row["last_seen_at"]) > datetime.fromisoformat(row["detail_fetched_at"])
            gs["detail_timestamp_matches_payload"] += datetime.fromisoformat(row["detail_fetched_at"]) == datetime.fromisoformat(detail["fetched_at"])
            gs["detail_count_differs_latest"] += detail["cited_by_count"] != row["cited_by_count"]
            gs["overview_count_differs_latest"] += overview["cited_by_count"] != row["cited_by_count"]
            for field in ("title", "venue", "year"):
                fallback = detail[field] in (None, "")
                gs[field + "_overview_fallback"] += fallback
                gs[field + "_matches_payload"] += row[field] == (overview[field] if fallback else detail[field])
            if row["publication_id"] in pub_by_id:
                pub = pub_by_id[row["publication_id"]]
                gs["linked_year_conflicts"] += row["year"] is not None and pub["year"] is not None and row["year"] != pub["year"]
        gs["profiles"] = len({row["profile_user_id"] for row in scholar})
        gs["publications_with_multiple_entries"] = sum(count > 1 for count in match_counts.values())
        result["scholar"] = dict(gs)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    print(json.dumps(audit(args.snapshot.expanduser().resolve()), ensure_ascii=False, indent=2, sort_keys=True))
