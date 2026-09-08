#!/usr/bin/env python3
"""Extract CVPR main-conference papers from venue CVF links and compare a catalog.
Read-only with respect to the catalog. Python 3.10+ and curl; no Python packages.
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from difflib import SequenceMatcher
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import sys
import unicodedata
from urllib.parse import urljoin, urlparse, parse_qs

VERSION = "cvpr-proceedings/1"


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def title_key(value):
    return "".join(c for c in normalized(value) if c.isalnum())


class Page(HTMLParser):
    """CVF uses dt.ptitle and hidden author-search inputs (query/query_author)."""

    def __init__(self, html, url):
        super().__init__(convert_charrefs=True)
        self.url, self.links, self.papers, self.meta = url, [], [], defaultdict(list)
        self.paper = None
        self.in_title = False
        self.anchor = None
        self.abstract_depth = 0
        self.abstract = []
        self.feed(html)
        self.close()
        self.finish()

    def finish(self):
        if self.paper:
            self.paper["title"] = " ".join(self.paper["title"].split())
            self.papers.append(self.paper)
            self.paper = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "dt":
            self.finish()
            self.in_title = "ptitle" in a.get("class", "").split()
            if self.in_title:
                self.paper = {"title": "", "authors": [], "official_url": ""}
        if tag == "a" and a.get("href"):
            href = urljoin(self.url, a["href"])
            self.anchor = {"url": href, "text": ""}
            self.links.append(self.anchor)
            if self.in_title and self.paper:
                self.paper["official_url"] = href
            if (
                self.paper
                and urlparse(href).path.endswith(".pdf")
                and "/papers/" in href
            ):
                self.paper["paper_url"] = href
        if (
            tag == "input"
            and self.paper
            and a.get("name") in ("query", "query_author")
            and a.get("value")
        ):
            self.paper["authors"].append(a["value"].strip())
        if tag == "meta" and a.get("name", "").startswith("citation_"):
            self.meta[a["name"]].append(a.get("content", ""))
        if tag == "div":
            if self.abstract_depth:
                self.abstract_depth += 1
            elif a.get("id") == "abstract":
                self.abstract_depth = 1

    def handle_endtag(self, tag):
        if tag == "dt":
            self.in_title = False
        if tag == "a":
            self.anchor = None
        if tag == "div" and self.abstract_depth:
            self.abstract_depth -= 1

    def handle_data(self, data):
        if self.in_title and self.paper:
            self.paper["title"] += data
        if self.anchor:
            self.anchor["text"] += data
        if self.abstract_depth:
            self.abstract.append(data)


def editions(page):
    found = {}
    for link in page.links:
        u = urlparse(link["url"])
        m = re.fullmatch(r"/CVPR(\d{4})(?:\.py)?", u.path)
        if m and u.hostname == "openaccess.thecvf.com" and not u.query:
            found[int(m[1])] = link["url"]
    if not found:
        raise ValueError("CVF menu has no recognized CVPR main-conference editions")
    return dict(sorted(found.items()))


class Fetcher:
    def __init__(self, cache, offline=False):
        self.cache, self.offline = cache, offline
        cache.mkdir(parents=True, exist_ok=True)

    def get(self, url):
        if urlparse(url).hostname != "openaccess.thecvf.com":
            raise ValueError("Unexpected CVF source host: " + url)
        key = hashlib.sha256(url.encode()).hexdigest()
        file = self.cache / (key + ".html")
        metadata = self.cache / (key + ".json")
        if not file.exists():
            if self.offline:
                raise ValueError("Not cached: " + url)
            result = subprocess.run(
                [
                    "curl",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--location",
                    "--retry",
                    "2",
                    "--max-time",
                    "60",
                    url,
                ],
                capture_output=True,
                check=True,
            )
            # CVF's older pages may advertise Latin-1 while serving UTF-8.
            try:
                result.stdout.decode("utf-8")
                encoding = "utf-8"
            except UnicodeDecodeError:
                encoding = "windows-1252"
            file.write_bytes(result.stdout)
            metadata.write_text(
                json.dumps(
                    {
                        "url": url,
                        "fetched_at": datetime.now(timezone.utc).isoformat(),
                        "sha256": hashlib.sha256(result.stdout).hexdigest(),
                        "encoding": encoding,
                    },
                    indent=2,
                )
            )
        info = json.loads(metadata.read_text())
        raw = file.read_bytes()
        if info["url"] != url or hashlib.sha256(raw).hexdigest() != info["sha256"]:
            raise ValueError("Cache integrity mismatch: " + url)
        return Page(raw.decode(info["encoding"]), url), info


def author_display(value):
    parts = value.split(",", 1)
    return " ".join((parts[1] + " " + parts[0] if len(parts) == 2 else value).split())


def extract_year(fetcher, year, url, author):
    page, source = fetcher.get(url)
    sources = [source]
    if not page.papers:
        all_links = [
            l["url"]
            for l in page.links
            if parse_qs(urlparse(l["url"]).query).get("day") == ["all"]
        ]
        if len(set(all_links)) == 1:
            page, source = fetcher.get(all_links[0])
            sources = [source]
        else:
            day_links = sorted(
                {
                    l["url"]
                    for l in page.links
                    if urlparse(l["url"]).path == urlparse(url).path
                    and re.fullmatch(
                        r"\d{4}-\d{2}-\d{2}",
                        parse_qs(urlparse(l["url"]).query).get("day", [""])[0],
                    )
                }
            )
            if not day_links:
                raise ValueError(
                    f"{year}: no papers and no recognized All Papers/day links"
                )
            sources, combined = [], []
            for day_url in day_links:
                day, info = fetcher.get(day_url)
                if not day.papers:
                    raise ValueError(f"{year}: empty day index: {day_url}")
                combined.extend(day.papers)
                sources.append(info)
            page.papers = combined
    if not page.papers or any(
        not p["authors"] or not p["title"] or not p["official_url"] for p in page.papers
    ):
        raise ValueError(f"{year}: empty or incomplete proceedings index")
    if len({p["official_url"] for p in page.papers}) != len(page.papers):
        raise ValueError(f"{year}: duplicate paper URLs in index")
    matched = []
    for p in page.papers:
        if normalized(author) not in [normalized(n) for n in p["authors"]]:
            continue
        detail, evidence = fetcher.get(p["official_url"])
        names = [author_display(n) for n in detail.meta["citation_author"]]
        title = next(iter(detail.meta["citation_title"]), "")
        if (
            not names
            or normalized(author) not in [normalized(n) for n in names]
            or title_key(title) != title_key(p["title"])
        ):
            raise ValueError(f'{year}: detail/index mismatch: {p["official_url"]}')
        if [normalized(n) for n in names] != [normalized(n) for n in p["authors"]]:
            raise ValueError(
                f"{year}: byline differs between index and detail: {title}"
            )
        first = next(iter(detail.meta["citation_firstpage"]), "")
        last = next(iter(detail.meta["citation_lastpage"]), "")
        matched.append(
            {
                **p,
                "authors": names,
                "title": title,
                "year": year,
                "publication_date": next(
                    iter(detail.meta["citation_publication_date"]), str(year)
                ),
                "conference": next(iter(detail.meta["citation_conference_title"]), ""),
                "paper_url": next(
                    iter(detail.meta["citation_pdf_url"]), p.get("paper_url")
                ),
                "doi": next(iter(detail.meta["citation_doi"]), None),
                "pages": f"{first}-{last}" if first and last else None,
                "abstract": " ".join("".join(detail.abstract).split()),
                "source": evidence,
            }
        )
    return matched, {
        "year": year,
        "indexed_papers": len(page.papers),
        "author_papers": len(matched),
        "sources": sources,
    }


def load_catalog(root):
    def read(folder):
        return [
            dict(json.loads(p.read_text()), _path=str(p))
            for p in sorted((root / "catalog" / folder).rglob("*.json"))
        ]

    return read("publications"), read("venues")


def compare(papers, publications, venue_id, author):
    results, used = [], set()
    for paper in papers:

        def evidence(p):
            links = [
                p.get("official_url"),
                p.get("paper_url"),
                *p.get("extra_urls", []),
            ]
            if (
                paper["official_url"] in links
                or paper.get("paper_url")
                and paper["paper_url"] in links
            ):
                return "source_url"
            if paper.get("doi") and normalized(
                p.get("identifiers", {}).get("doi", "")
            ) == normalized(paper["doi"]):
                return "doi"
            if title_key(p["title"]) == title_key(paper["title"]):
                return "normalized_title"
            return None

        matches = [(p, evidence(p)) for p in publications]
        matches = [(p, e) for p, e in matches if e]
        cvpr = [
            (p, e)
            for p, e in matches
            if p.get("venue", {}).get("venue_id") == venue_id
            and p.get("type") == "conference"
        ]
        state = (
            "cvpr_record_found"
            if len(cvpr) == 1
            else (
                "multiple_cvpr_records"
                if cvpr
                else "other_version_only" if matches else "not_found"
            )
        )
        diffs = []
        for p, e in cvpr:
            d = {}
            if paper.get("author_order_verified", True) and [
                normalized(a["name"]) for a in p["authors"]
            ] != [normalized(n) for n in paper["authors"]]:
                d["authors"] = {
                    "catalog": [a["name"] for a in p["authors"]],
                    "proceedings": paper["authors"],
                }
            year = (
                p.get("venue", {}).get("event_year")
                or str(p.get("publication_date", p.get("issued_date", "")))[:4]
            )
            if str(year) != str(paper["year"]):
                d["year"] = {"catalog": year, "proceedings": paper["year"]}
            for field in ["official_url", "paper_url", "pages"]:
                if paper.get(field) and p.get(field) != paper[field]:
                    d[field] = {"catalog": p.get(field), "proceedings": paper[field]}
            if d:
                diffs.append({"publication_id": p["id"], "fields": d})
        near = []
        if not matches:
            for p in publications:
                if normalized(author) not in [
                    normalized(a["name"]) for a in p["authors"]
                ]:
                    continue
                score = SequenceMatcher(
                    None, title_key(p["title"]), title_key(paper["title"])
                ).ratio()
                if score >= 0.8:
                    near.append(
                        {"id": p["id"], "title": p["title"], "score": round(score, 3)}
                    )
            near.sort(key=lambda p: -p["score"])
        used.update(p["id"] for p, e in cvpr)
        results.append(
            {
                "paper": paper,
                "status": state,
                "matches": [
                    {
                        "id": p["id"],
                        "title": p["title"],
                        "type": p["type"],
                        "venue": p.get("venue"),
                        "path": p["_path"],
                        "evidence": e,
                        "archived": bool(p.get("archived_at")),
                    }
                    for p, e in matches
                ],
                "differences": diffs,
                "possible_title_variants": near[:5],
            }
        )
    return results, [
        p
        for p in publications
        if p.get("venue", {}).get("venue_id") == venue_id and p["id"] not in used
    ]


def read_ieee_snapshots(path, author):
    papers, coverage = [], []
    for snapshot in json.loads(path.read_text()):
        url = snapshot["url"]
        parsed = urlparse(url)
        match = re.fullmatch(r"/csdl/proceedings/cvpr/(\d{4})/[^/]+", parsed.path)
        if parsed.hostname != "www.computer.org" or not match:
            raise ValueError("Unexpected IEEE edition URL: " + url)
        records = snapshot["records"]
        if (
            not snapshot.get("complete_list")
            or snapshot["indexed_papers"] < len(records)
            or normalized(snapshot["author"]) != normalized(author)
        ):
            raise ValueError(
                "IEEE snapshot must be filtered from the complete list for the requested author"
            )
        year = int(match[1])
        found = []
        for record in records:
            if normalized(author) in [normalized(n) for n in record["authors"]]:
                found.append(
                    {
                        **record,
                        "year": year,
                        "author_order_verified": False,
                        "source": {
                            "url": url,
                            "captured_at": snapshot["captured_at"],
                            "method": "rendered IEEE proceedings DOM",
                        },
                    }
                )
        papers.extend(found)
        coverage.append(
            {
                "year": year,
                "indexed_papers": snapshot["indexed_papers"],
                "author_papers": len(found),
                "initial_candidates": snapshot.get("initial_candidates", []),
                "sources": [{"url": url, "captured_at": snapshot["captured_at"]}],
            }
        )
    return papers, coverage


def report(result):
    lines = [
        "# CVPR proceedings comparison",
        "",
        f"Author: **{result['author']}**. Catalog was read without modification.",
        "",
        "Scope: CVPR main conference only; workshops, Findings and other conferences are excluded. CVF menu discovery determines online coverage; optional IEEE browser snapshots supplement older editions. Records outside scanned editions are unverified, not missing from proceedings. Exact full-name matching does not attribute initial-only credits. IEEE list byline order is not treated as authoritative.",
        "",
        "Matching uses source URLs, DOI, or normalized titles. An arXiv/other-version match does not count as a CVPR conference record. Fuzzy title suggestions require review; names are not resolved to identities by this script.",
        "",
        "| Year | Indexed papers | Author papers |",
        "| --- | ---: | ---: |",
    ]
    lines += [
        f"| {y['year']} | {y['indexed_papers']} | {y['author_papers']} |"
        for y in result["coverage"]
    ]
    lines += [
        "",
        "## Summary",
        "",
        *[f"- {k}: {v}" for k, v in result["counts"].items()],
        "",
    ]
    for scope in result["coverage"]:
        for candidate in scope.get("initial_candidates", []):
            lines += [
                f"- Unassigned initial-only credit ({scope['year']}): {candidate['title']} — {candidate['official_url']}"
            ]
    for status in [
        "not_found",
        "other_version_only",
        "multiple_cvpr_records",
        "cvpr_record_found",
    ]:
        lines += [f"## {status}", ""]
        for r in result["comparison"]:
            if r["status"] != status:
                continue
            p = r["paper"]
            lines += [
                f"### {p['year']} — {p['title']}",
                "",
                f"[Proceedings]({p['official_url']})",
                "",
                "Authors: " + ", ".join(p["authors"]),
                "",
            ]
            lines += [
                f"- Catalog: [{m['title']}]({m['path']}) — {m['type']}; match: {m['evidence']}"
                for m in r["matches"]
            ]
            lines += [
                f"- Possible title variant (not confirmed): {m['title']} ({m['score']})"
                for m in r["possible_title_variants"]
            ]
            for diff in r["differences"]:
                for field, values in diff["fields"].items():
                    lines += [
                        f"- {field}: catalog `{values['catalog']}`; proceedings `{values['proceedings']}`"
                    ]
            lines += [""]
    lines += ["## Existing CVPR records not matched", ""]
    years = {c["year"] for c in result["coverage"]}
    for p in result["catalog_only"]:
        year = str(p.get("publication_date", ""))[:4]
        label = (
            "outside scanned coverage"
            if not year.isdigit() or int(year) not in years
            else "requires review within covered years"
        )
        lines += [f"- {year}: [{p['title']}]({p['_path']}) — {label}"]
    if result["errors"]:
        lines += ["", "## Coverage errors", "", *result["errors"]]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--author", default="Dahua Lin")
    parser.add_argument("--venue-key", default="cvpr")
    parser.add_argument(
        "--offline", action="store_true", help="Require cached source pages; no network"
    )
    parser.add_argument(
        "--ieee-snapshots",
        type=Path,
        help="JSON array captured with ieee_browser.js; use for pre-2013 editions",
    )
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=3)
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(args.root.resolve()):
        parser.error(
            "Output must be outside the catalog to keep this operation read-only"
        )
    args.output.mkdir(parents=True, exist_ok=True)
    publications, venues = load_catalog(args.root)
    matches = [v for v in venues if v["venue_key"] == args.venue_key]
    if len(matches) != 1:
        raise ValueError("Expected one CVPR venue")
    venue = matches[0]
    links = [
        l["url"]
        for l in venue["urls"]
        if l["role"] == "proceedings"
        and urlparse(l["url"]).hostname == "openaccess.thecvf.com"
    ]
    if len(links) != 1:
        raise ValueError("Expected one CVF proceedings link on venue")
    fetcher = Fetcher(args.output / "cache", args.offline)
    menu, source = fetcher.get(links[0])
    papers, coverage, errors = [], [], []

    def process(item):
        year, url = item
        try:
            found, scope = extract_year(fetcher, year, url, args.author)
            print(
                f'{year}: {len(found)} author papers / {scope["indexed_papers"]} indexed',
                file=sys.stderr,
            )
            return found, scope, None
        except Exception as error:
            return [], None, f"{year}: {error}"

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for found, scope, error in pool.map(process, editions(menu).items()):
            papers.extend(found)
            if scope:
                coverage.append(scope)
            if error:
                errors.append(error)
    if args.ieee_snapshots:
        older, scopes = read_ieee_snapshots(args.ieee_snapshots, args.author)
        if any(s["year"] in {c["year"] for c in coverage} for s in scopes):
            raise ValueError("IEEE supplements must not overlap CVF years")
        papers.extend(older)
        coverage.extend(scopes)
    coverage.sort(key=lambda c: c["year"])
    papers.sort(key=lambda p: (p["year"], p["title"]))
    comparison, catalog_only = compare(papers, publications, venue["id"], args.author)
    result = {
        "parser_version": VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "author": args.author,
        "venue": venue,
        "menu_source": source,
        "coverage": coverage,
        "errors": errors,
        "complete_for_discovered_cvf_years": not errors,
        "counts": dict(Counter(r["status"] for r in comparison)),
        "comparison": comparison,
        "catalog_only": catalog_only,
    }
    (args.output / "papers.json").write_text(
        json.dumps(papers, ensure_ascii=False, indent=2) + "\n"
    )
    (args.output / "comparison.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    )
    (args.output / "report.md").write_text(report(result))
    print(
        json.dumps(
            {"papers": len(papers), "counts": result["counts"], "errors": errors},
            indent=2,
        )
    )
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
