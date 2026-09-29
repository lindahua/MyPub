#!/usr/bin/env python3
"""Verify Crossref ORCID candidates against public ORCID names and DOI works."""

import argparse
import collections
import datetime
import json
import pathlib
import re
import subprocess
import sys
import unicodedata


def read_json(path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normal_name(value):
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).casefold(), re.UNICODE))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("local/author-profiles"))
    parser.add_argument("--input", default="crossref-orcid-candidates.json")
    parser.add_argument("--result", default="orcid-verified-candidates.json")
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    candidates = read_json(args.output / args.input)["candidates"]
    existing = {item["identifiers"]["orcid"] for item in read_json(args.output / "inventory.json")["authors"] if item["identifiers"].get("orcid")}
    candidates = [item for item in candidates if not item.get("current_orcid")]
    priority = collections.defaultdict(int)
    for item in candidates:
        if item["orcid"] not in existing:
            priority[item["orcid"]] = max(priority[item["orcid"]], item["evidence_count"])
    orcids = sorted(priority, key=lambda orcid: (-priority[orcid], orcid))
    requested = 0
    failures = []
    for orcid in orcids:
        path = args.output / "orcid" / f"{orcid}.json"
        if path.exists() or not args.fetch:
            continue
        if args.limit and requested >= args.limit:
            break
        url = f"https://pub.orcid.org/v3.0/{orcid}/record"
        result = subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--retry-delay", "2", "--max-time", "25", "--header", "Accept: application/json", "--user-agent", "MyPub author profile research (private catalog)", url], capture_output=True, text=True)
        requested += 1
        if result.returncode:
            failures.append({"orcid": orcid, "error": result.stderr.strip()})
            continue
        try:
            record = json.loads(result.stdout)
            if record.get("orcid-identifier", {}).get("path") != orcid:
                raise ValueError("ORCID path differs")
        except (json.JSONDecodeError, ValueError) as error:
            failures.append({"orcid": orcid, "error": str(error)})
            continue
        write_json(path, record)
        if requested % 20 == 0:
            print(f"Fetched {requested} public ORCID records", file=sys.stderr, flush=True)
    author_counts = collections.Counter(item["author_id"] for item in candidates)
    orcid_counts = collections.Counter(item["orcid"] for item in candidates)
    results = []
    for candidate in candidates:
        path = args.output / "orcid" / f"{candidate['orcid']}.json"
        if not path.exists():
            continue
        record = read_json(path)
        name = record.get("person", {}).get("name") or {}
        names = [" ".join(x for x in [(name.get("given-names") or {}).get("value", ""), (name.get("family-name") or {}).get("value", "")] if x), (name.get("credit-name") or {}).get("value", "")]
        works = []
        for group in record.get("activities-summary", {}).get("works", {}).get("group", []):
            dois = {external.get("external-id-value", "").lower().removeprefix("https://doi.org/") for external in group.get("external-ids", {}).get("external-id", []) if external.get("external-id-type", "").lower() == "doi"}
            for crossref_work in candidate["works"]:
                if crossref_work["doi"].lower() in dois:
                    summaries = group.get("work-summary", [])
                    works.append({"doi": crossref_work["doi"], "orcid_source_names": sorted({(summary.get("source", {}).get("source-name") or {}).get("value", "") for summary in summaries}), "orcid_url": f"https://orcid.org/{candidate['orcid']}"})
        name_matches = normal_name(candidate["preferred_name"]) in {normal_name(value) for value in names if value}
        status = "verified" if name_matches and works and len(candidate["same_name_ids"]) == 1 and author_counts[candidate["author_id"]] == 1 and orcid_counts[candidate["orcid"]] == 1 else "review"
        results.append({**candidate, "orcid_names": [value for value in names if value], "name_matches": name_matches, "matching_orcid_works": works, "status": status})
    write_json(args.output / args.result, {"generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "fetched_records": len(list((args.output / "orcid").glob("*.json"))) if (args.output / "orcid").exists() else 0, "new_requests": requested, "failures": failures, "candidates": results})
    print(f"Verified {sum(item['status'] == 'verified' for item in results)} of {len(results)} evaluated candidates; {len(failures)} fetch failures")


if __name__ == "__main__":
    main()
