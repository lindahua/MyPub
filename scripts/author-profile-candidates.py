#!/usr/bin/env python3
"""Build an author inventory and Crossref ORCID evidence queue; never edits the catalog."""

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


def normal_name(value):
    value = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(re.findall(r"[^\W_]+", value, re.UNICODE))


def normal_title(value):
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).casefold(), re.UNICODE))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path.home() / "Data/MyPubRepo")
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("local/author-profiles"))
    parser.add_argument("--fetch-crossref", action="store_true")
    parser.add_argument("--limit", type=int, default=0, help="Maximum uncached DOI requests in this run")
    args = parser.parse_args()
    root = args.root / "catalog"
    authors = [read_json(p) for p in root.glob("authors/**/*.json")]
    publications = [read_json(p) for p in root.glob("publications/**/*.json")]
    by_id = {a["id"]: a for a in authors}
    linked = collections.defaultdict(list)
    unresolved = []
    for publication in publications:
        for position, credit in enumerate(publication["authors"], 1):
            if credit.get("author_id"):
                linked[credit["author_id"]].append({
                    "publication_id": publication["id"], "title": publication["title"],
                    "doi": publication.get("identifiers", {}).get("doi"),
                    "date": publication.get("publication_date"), "position": position,
                    "credited_name": credit["name"],
                })
            else:
                unresolved.append({"publication_id": publication["id"], "position": position, "name": credit["name"]})
    same_names = collections.defaultdict(list)
    for author in authors:
        if not author.get("merged_into"):
            same_names[normal_name(author["preferred_name"])].append(author["id"])
    inventory = []
    for author in authors:
        works = linked[author["id"]]
        inventory.append({
            "author_id": author["id"], "author_key": author["author_key"],
            "preferred_name": author["preferred_name"], "aliases": author["aliases"],
            "identifiers": author["identifiers"], "merged_into": author.get("merged_into"),
            "same_name_ids": same_names[normal_name(author["preferred_name"])],
            "publication_count": len(works), "publications": works,
        })
    inventory.sort(key=lambda x: (-x["publication_count"], x["author_key"]))
    write_json(args.output / "inventory.json", {"generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "authors": inventory, "unresolved_credits": unresolved})
    if not args.fetch_crossref:
        print(f"Inventory: {len(authors)} authors, {len(publications)} publications, {len(unresolved)} unresolved credits")
        return

    # Fetch each catalog DOI once. Save raw responses so interrupted runs resume.
    # arXiv's DataCite DOIs are not registered with Crossref.
    doi_publications = {p["identifiers"]["doi"].lower(): p for p in publications
                        if p.get("identifiers", {}).get("doi") and not p["identifiers"]["doi"].lower().startswith("10.48550/arxiv.")}
    ordered = sorted(doi_publications.items(), key=lambda pair: pair[1].get("publication_date", ""), reverse=True)
    fetched = 0
    failures = []
    for doi, publication in ordered:
        path = args.output / "crossref" / (urllib.parse.quote(doi, safe="") + ".json")
        if path.exists():
            continue
        if args.limit and fetched >= args.limit:
            break
        url = "https://api.crossref.org/works/" + urllib.parse.quote(doi, safe="")
        result = subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--retry-delay", "2", "--max-time", "25", "--user-agent", "MyPub author profile research (private catalog)", url], capture_output=True, text=True)
        fetched += 1
        if result.returncode:
            failures.append({"doi": doi, "error": result.stderr.strip()})
            continue
        try:
            response = json.loads(result.stdout)
            if response.get("status") != "ok":
                raise ValueError("Crossref status is not ok")
        except (json.JSONDecodeError, ValueError) as error:
            failures.append({"doi": doi, "error": str(error)})
            continue
        write_json(path, response)
        if fetched % 20 == 0:
            print(f"Fetched {fetched} DOI records", file=sys.stderr, flush=True)

    evidence = collections.defaultdict(list)
    checked = 0
    for doi, publication in ordered:
        path = args.output / "crossref" / (urllib.parse.quote(doi, safe="") + ".json")
        if not path.exists():
            continue
        message = read_json(path)["message"]
        checked += 1
        if normal_title(publication["title"]) != normal_title((message.get("title") or [""])[0]):
            continue
        source_authors = message.get("author", [])
        local_authors = publication["authors"]
        for position, credit in enumerate(local_authors):
            aid = credit.get("author_id")
            if not aid or position >= len(source_authors):
                continue
            source = source_authors[position]
            orcid = source.get("ORCID", "").replace("https://orcid.org/", "").replace("http://orcid.org/", "").upper()
            source_name = " ".join(x for x in [source.get("given", ""), source.get("family", "")] if x)
            if not orcid or normal_name(credit["name"]) != normal_name(source_name):
                continue
            evidence[(aid, orcid)].append({
                "doi": doi, "publication_id": publication["id"], "title": publication["title"],
                "position": position + 1, "credited_name": credit["name"],
                "crossref_name": source_name, "authenticated_orcid": source.get("authenticated-orcid"),
                "source_url": "https://api.crossref.org/works/" + urllib.parse.quote(doi, safe=""),
            })
    candidates = []
    for (aid, orcid), works in evidence.items():
        author = by_id[aid]
        candidates.append({
            "author_id": aid, "author_key": author["author_key"], "preferred_name": author["preferred_name"],
            "orcid": orcid, "current_orcid": author["identifiers"].get("orcid"),
            "same_name_ids": same_names[normal_name(author["preferred_name"])],
            "evidence_count": len(works), "works": works,
        })
    candidates.sort(key=lambda x: (-x["evidence_count"], x["author_key"]))
    write_json(args.output / "crossref-orcid-candidates.json", {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "checked_dois": checked, "new_requests": fetched, "failures": failures, "candidates": candidates,
    })
    print(f"Checked {checked} cached DOIs; {len(candidates)} author/ORCID candidate pairs; {len(failures)} fetch failures")


if __name__ == "__main__":
    main()
