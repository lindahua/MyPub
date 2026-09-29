#!/usr/bin/env python3
"""Generate ORCID candidates from exact arXiv DOI works in OpenAlex; catalog read-only."""

import argparse
import collections
import datetime
import json
import pathlib
import re
import subprocess
import sys
import unicodedata
import urllib.parse


def read_json(path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def norm(value):
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).casefold(), re.UNICODE))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path.home() / "Data/MyPubRepo")
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("local/author-profiles"))
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    root = args.root / "catalog"
    authors = [read_json(path) for path in root.glob("authors/**/*.json")]
    publications = [read_json(path) for path in root.glob("publications/**/*.json")]
    by_id = {author["id"]: author for author in authors}
    same_names = collections.defaultdict(list)
    for author in authors:
        if not author.get("merged_into"):
            same_names[norm(author["preferred_name"])].append(author["id"])
    doi_pubs = {p["identifiers"]["doi"].lower(): p for p in publications if p.get("identifiers", {}).get("doi", "").lower().startswith("10.48550/arxiv.")}
    ordered = sorted(doi_pubs.items(), key=lambda item: item[1].get("publication_date", ""), reverse=True)
    requested, failures = 0, []
    for doi, publication in ordered:
        path = args.output / "openalex" / (urllib.parse.quote(doi, safe="") + ".json")
        if path.exists() or not args.fetch:
            continue
        if args.limit and requested >= args.limit:
            break
        url = "https://api.openalex.org/works/https://doi.org/" + urllib.parse.quote(doi, safe="")
        result = subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--retry-delay", "2", "--max-time", "25", "--user-agent", "MyPub author profile research (private catalog)", url], capture_output=True, text=True)
        requested += 1
        if result.returncode:
            failures.append({"doi": doi, "error": result.stderr.strip()})
            continue
        try:
            work = json.loads(result.stdout)
            if work.get("doi", "").lower() != "https://doi.org/" + doi:
                raise ValueError("OpenAlex DOI differs")
        except (json.JSONDecodeError, ValueError) as error:
            failures.append({"doi": doi, "error": str(error)})
            continue
        write_json(path, work)
        if requested % 20 == 0:
            print(f"Fetched {requested} OpenAlex DOI works", file=sys.stderr, flush=True)
    evidence = collections.defaultdict(list)
    checked = 0
    for doi, publication in ordered:
        path = args.output / "openalex" / (urllib.parse.quote(doi, safe="") + ".json")
        if not path.exists():
            continue
        work = read_json(path)
        checked += 1
        if norm(work.get("title", "")) != norm(publication["title"]):
            continue
        local = publication["authors"]
        source = work.get("authorships", [])
        for position, credit in enumerate(local):
            aid = credit.get("author_id")
            if not aid or position >= len(source):
                continue
            external = source[position].get("author", {})
            orcid = (external.get("orcid") or "").removeprefix("https://orcid.org/").upper()
            if not orcid or norm(credit["name"]) != norm(external.get("display_name", "")):
                continue
            evidence[(aid, orcid)].append({"doi": doi, "publication_id": publication["id"], "title": publication["title"], "position": position + 1, "credited_name": credit["name"], "openalex_name": external["display_name"], "source_url": "https://api.openalex.org/works/https://doi.org/" + urllib.parse.quote(doi, safe="")})
    candidates = []
    for (aid, orcid), works in evidence.items():
        author = by_id[aid]
        candidates.append({"author_id": aid, "author_key": author["author_key"], "preferred_name": author["preferred_name"], "orcid": orcid, "current_orcid": author["identifiers"].get("orcid"), "same_name_ids": same_names[norm(author["preferred_name"])], "evidence_count": len(works), "works": works, "candidate_provider": "openalex"})
    candidates.sort(key=lambda item: (-item["evidence_count"], item["author_key"]))
    write_json(args.output / "openalex-orcid-candidates.json", {"generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "checked_dois": checked, "new_requests": requested, "failures": failures, "candidates": candidates})
    print(f"Checked {checked} cached arXiv DOIs; {len(candidates)} author/ORCID candidate pairs; {len(failures)} fetch failures")


if __name__ == "__main__":
    main()
