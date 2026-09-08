#!/usr/bin/env python3
"""Read-only multi-conference proceedings audit. Python 3.10+, beautifulsoup4, curl."""
import argparse, hashlib, json, re, subprocess, sys, time
from difflib import SequenceMatcher
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlencode
from bs4 import BeautifulSoup
from cvpr import (
    Page,
    extract_year,
    normalized,
    title_key,
    author_display,
    load_catalog,
    compare,
)


class Fetch:
    def __init__(self, folder, offline=False):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.offline = offline

    def raw(self, url):
        key = hashlib.sha256(url.encode()).hexdigest()
        p = self.folder / (key + ".body")
        m = p.with_suffix(".json")
        if not p.exists():
            if self.offline:
                raise ValueError("Uncached " + url)
            r = subprocess.run(
                [
                    "curl",
                    "--compressed",
                    "-fLsS",
                    "--retry",
                    "2",
                    "--max-time",
                    "70",
                    url,
                ],
                capture_output=True,
                check=True,
            )
            p.write_bytes(r.stdout)
            m.write_text(
                json.dumps(
                    {
                        "url": url,
                        "captured_at": datetime.now(timezone.utc).isoformat(),
                        "sha256": hashlib.sha256(r.stdout).hexdigest(),
                    }
                )
            )
        b = p.read_bytes()
        e = json.loads(m.read_text())
        if hashlib.sha256(b).hexdigest() != e["sha256"] or e["url"] != url:
            raise ValueError("Cache integrity failure")
        try:
            s = b.decode("utf8")
        except UnicodeDecodeError:
            s = b.decode("cp1252")
        return s, e

    def soup(self, url):
        s, e = self.raw(url)
        return BeautifulSoup(s, "html.parser"), e

    def get(self, url):
        s, e = self.raw(url)
        return Page(s, url), e

    def api(self, url):
        s, e = self.raw(url)
        return json.loads(s), e


def meta_paper(fetch, url, year, authors=None, title=None):
    soup, e = fetch.soup(url)
    m = {}
    for el in soup.select("meta[name]"):
        m.setdefault(el["name"].lower(), []).append(el.get("content", ""))
    names = [author_display(x) for x in m.get("citation_author", [])] or authors or []
    result = {
        "title": next(iter(m.get("citation_title", [])), title),
        "authors": names,
        "year": year,
        "official_url": url,
        "source": e,
    }
    for field, key in [
        ("doi", "citation_doi"),
        ("paper_url", "citation_pdf_url"),
        ("publication_date", "citation_publication_date"),
    ]:
        if m.get(key):
            result[field] = m[key][0]
    if m.get("citation_firstpage") and m.get("citation_lastpage"):
        result["pages"] = m["citation_firstpage"][0] + "-" + m["citation_lastpage"][0]
    abstract = soup.select_one("#abstract, .abstract, div.abstract")
    if not abstract:
        heading = soup.find(
            ["h2", "h3", "h4"], string=lambda x: x and x.strip() == "Abstract"
        )
        if heading:
            abstract = heading.find_next_sibling("p")
    if abstract:
        result["abstract"] = (
            abstract.get_text(" ", strip=True).removeprefix("Abstract").strip()
        )
    if not result["title"] or not result["authors"]:
        raise ValueError("Missing title/byline: " + url)
    return result


def parallel(items, fn):
    with ThreadPoolExecutor(4) as pool:
        return list(pool.map(fn, items))


def scan_cvf(f, source, author, conference):
    soup, e = f.soup(source)
    years = {}
    for a in soup.select("a[href]"):
        url = urljoin(source, a["href"])
        m = re.fullmatch(r"/" + conference + r"(\d{4})(?:\.py)?", urlparse(url).path)
        if m:
            years[int(m[1])] = url
    if not years:
        raise ValueError("No CVF editions discovered for " + conference)
    return scan_jobs(
        [(y, u) for y, u in sorted(years.items())],
        lambda y, u: extract_year(f, y, u, author),
    )


def scan_jobs(jobs, fn):
    def run(item):
        y, u = item
        try:
            p, c = fn(y, u)
            print(f"{u}: {len(p)} papers", flush=True)
            return p, c, None
        except Exception as e:
            return [], None, f"{u}: {e}"

    allpapers = []
    coverage = []
    errors = []
    for ps, c, e in parallel(jobs, run):
        allpapers.extend(ps)
        if c:
            coverage.append(c)
        if e:
            errors.append(e)
    return allpapers, coverage, errors


def scan_eccv(f, source, author):
    soup, e = f.soup(source)
    rows = soup.select("dt.ptitle")
    papers = []
    counts = Counter()
    for row in rows:
        a = row.find("a", href=True)
        url = urljoin(source, a["href"])
        m = re.search(r"eccv[_/](\d{4})", url, re.I)
        if not m:
            continue
        year = int(m[1])
        counts[year] += 1
        byline = row.find_next_sibling("dd")
        text = byline.get_text(" ", strip=True)
        if " and " in text and "," in text:
            names = [author_display(n).strip("*").strip() for n in text.split(" and ")]
        else:
            names = [n.strip().strip("*").strip() for n in text.split(",")]
        # A few ECVA rows omit delimiters; citation metadata is authoritative there.
        if normalized(author) in normalized(text) and normalized(author) not in map(
            normalized, names
        ):
            names = [n.strip() for n in re.split(r"\s{2,}", text)]
        if normalized(author) in map(normalized, names):
            papers.append((year, url, names, a.get_text(" ", strip=True)))
    if not counts:
        raise ValueError("No ECVA paper rows")
    results = parallel(papers, lambda v: meta_paper(f, v[1], v[0], v[2], v[3]))
    for p in results:
        if any(len(n.split()) > 3 for n in p["authors"]):
            p["author_order_verified"] = False
            p["author_parse_warning"] = (
                "Source byline has missing delimiters; verify against PDF"
            )
    return (
        results,
        [
            {
                "year": y,
                "indexed_papers": n,
                "author_papers": sum(p["year"] == y for p in results),
                "sources": [e],
            }
            for y, n in sorted(counts.items())
        ],
        [],
    )


def scan_neurips(f, source, author):
    soup, _ = f.soup(source)
    jobs = {}
    for a in soup.select("a[href]"):
        u = urljoin(source, a["href"])
        m = re.fullmatch(r"/paper_files/paper/(\d{4})(?:/[^/]+)?", urlparse(u).path)
        if m:
            jobs[u] = int(m[1])

    def edition(year, url):
        soup, e = f.soup(url)
        links = [
            a
            for a in soup.select("a[href]")
            if "/hash/" in a["href"] and "Abstract" in a["href"]
        ]
        found = []
        if not links:
            raise ValueError("No recognized paper links")
        for a in links:
            box = a.find_parent("li") or a.parent
            auth = box.select_one(".paper-authors") or box.find("i")
            if not auth:
                raise ValueError("Missing index byline")
            names = [x.strip() for x in auth.get_text(" ", strip=True).split(",")]
            if normalized(author) in map(normalized, names):
                found.append(
                    meta_paper(
                        f,
                        urljoin(url, a["href"]),
                        year,
                        names,
                        a.get_text(" ", strip=True),
                    )
                )
        return found, {
            "year": year,
            "indexed_papers": len(links),
            "author_papers": len(found),
            "sources": [e],
        }

    return scan_jobs([(y, u) for u, y in jobs.items()], edition)


def scan_pmlr(f, source, author, key):
    soup, _ = f.soup(source)
    jobs = []
    for li in soup.select("li"):
        text = li.get_text(" ", strip=True)
        if not re.search(r"\b" + key + r"\b", text, re.I) or re.search(
            r"workshop|\bat ICML\b", text, re.I
        ):
            continue
        a = li.find("a", href=True)
        ys = re.findall(r"\b(20\d{2})\b", text)
        if a and ys:
            jobs.append((int(ys[-1]), urljoin(source, a["href"]) + "/"))
    if not jobs:
        raise ValueError("No PMLR volumes found")

    def edition(year, url):
        soup, e = f.soup(url)
        rows = soup.select("div.paper")
        found = []
        if not rows:
            raise ValueError("No paper rows")
        for row in rows:
            a = row.find("a", string=re.compile(r"^abs$"))
            auth = row.select_one(".authors")
            if not a or not auth:
                raise ValueError("Incomplete PMLR row")
            names = [n.strip() for n in auth.get_text(" ", strip=True).split(",")]
            if normalized(author) in map(normalized, names):
                found.append(
                    meta_paper(
                        f,
                        urljoin(url, a["href"]),
                        year,
                        names,
                        row.select_one(".title").get_text(" ", strip=True),
                    )
                )
        return found, {
            "year": year,
            "indexed_papers": len(rows),
            "author_papers": len(found),
            "sources": [e],
        }

    return scan_jobs(jobs, edition)


def scan_ijcai(f, source, author):
    soup, _ = f.soup(source)
    jobs = {}
    for a in soup.select("a[href]"):
        u = urljoin(source, a["href"])
        m = re.fullmatch(r"/proceedings/(\d{4})/?", urlparse(u).path)
        if m:
            jobs[int(m[1])] = u.rstrip("/") + "/"

    def edition(year, url):
        soup, e = f.soup(url)
        rows = soup.select(".paper_wrapper")
        found = []
        if not rows:
            raise ValueError("No structured IJCAI index (older edition)")
        for row in rows:
            auth = row.select_one(".authors")
            names = (
                [n.strip() for n in auth.get_text(" ", strip=True).split(",")]
                if auth
                else []
            )
            if normalized(author) in map(normalized, names):
                a = next(a for a in row.select("a[href]") if "Details" in a.get_text())
                found.append(
                    meta_paper(
                        f,
                        urljoin(url, a["href"]),
                        year,
                        names,
                        row.select_one(".title").get_text(" ", strip=True),
                    )
                )
        return found, {
            "year": year,
            "indexed_papers": len(rows),
            "author_papers": len(found),
            "sources": [e],
        }

    return scan_jobs(sorted(jobs.items()), edition)


def scan_aaai(f, source, author):
    issues = {}
    seen = set()
    url = source
    while url:
        if url in seen:
            raise ValueError("Archive pagination cycle")
        seen.add(url)
        soup, _ = f.soup(url)
        for box in soup.select(".obj_issue_summary"):
            a = box.select_one("a.title")
            text = box.get_text(" ", strip=True)
            if not a:
                continue
            # AAAI proceedings include technical and explicitly labeled special tracks.
            if not re.search(r"\bAAAI[- ]", text):
                continue
            ys = re.findall(r"\b(20\d{2})\b", text)
            short = re.search(r"\bAAAI-(\d{2})", text)
            year = int(ys[-1]) if ys else 2000 + int(short[1]) if short else None
            if year:
                issues[urljoin(url, a["href"])] = year
        nextlink = soup.find("a", string=lambda x: x and x.strip() == "Next")
        url = urljoin(url, nextlink["href"]) if nextlink else None
    if not issues:
        raise ValueError("No AAAI issues discovered")

    def issue(year, url):
        soup, e = f.soup(url)
        rows = soup.select(".obj_article_summary")
        found = []
        if not rows:
            raise ValueError("No AAAI article rows")
        for row in rows:
            a = row.select_one("h3.title a")
            authors = row.select_one(".authors")
            if not a or not authors:
                continue
            names = [n.strip() for n in authors.get_text(" ", strip=True).split(",")]
            if normalized(author) in map(normalized, names):
                p = meta_paper(
                    f, urljoin(url, a["href"]), year, names, a.get_text(" ", strip=True)
                )
                p["track"] = soup.title.get_text(" ", strip=True)
                found.append(p)
        return found, {
            "year": year,
            "indexed_papers": len(rows),
            "author_papers": len(found),
            "sources": [e],
        }

    return scan_jobs([(y, u) for u, y in issues.items()], issue)


def scan_iclr_program(f, source, author):
    # Official accepted-paper programs avoid treating OpenReview submissions as acceptances.
    def edition(year, url):
        soup, e = f.soup(url)
        raw = str(soup)
        matches = re.findall(r'["\']([^"\']+orals-posters\.json)["\']', raw)
        if not matches:
            raise ValueError("No supported accepted-program data link")
        data, e = f.api(urljoin(url, matches[0]))
        rows = data["results"] if isinstance(data, dict) else data
        if isinstance(data, dict) and (
            data.get("next") or data.get("count", len(rows)) != len(rows)
        ):
            raise ValueError("Incomplete program pagination")
        am = re.findall(r'["\']([^"\']+abstracts\.json)["\']', raw)
        abstracts = {}
        if am and not all(row.get("abstract") for row in rows):
            try:
                abstracts = f.api(urljoin(url, am[0]))[0]
            except (ValueError, subprocess.CalledProcessError):
                pass
        found = []
        for row in rows:
            names = [a["fullname"] for a in row.get("authors", [])]
            if normalized(author) not in map(normalized, names):
                continue
            if row.get("decision") and not str(row["decision"]).lower().startswith(
                "accept"
            ):
                continue
            if not row.get("decision") and row.get("eventtype") not in (
                "Poster",
                "Oral",
                "Spotlight",
            ):
                continue
            official = row.get("paper_url") or urljoin(
                url, row.get("virtualsite_url", f'/virtual/{year}/poster/{row["id"]}')
            )
            p = {
                "title": row["name"],
                "authors": names,
                "year": year,
                "official_url": official,
                "source": e,
                "acceptance": row.get("decision")
                or "Listed in official accepted-paper program",
                "program_url": urljoin(
                    url,
                    row.get("virtualsite_url", f'/virtual/{year}/poster/{row["id"]}'),
                ),
            }
            if row.get("abstract") or abstracts.get(str(row["id"])):
                p["abstract"] = row.get("abstract") or abstracts[str(row["id"])]
            if row.get("paper_pdf_url"):
                p["paper_url"] = row["paper_pdf_url"]
            found.append(p)
        return found, {
            "year": year,
            "indexed_papers": len(rows),
            "author_papers": len(found),
            "sources": [e],
        }

    return scan_jobs(
        [(y, f"https://iclr.cc/virtual/{y}/papers.html") for y in range(2013, 2024)],
        edition,
    )


def scan_iclr(f, source, author):
    published, coverage, errors = scan_neurips(
        f, "https://proceedings.iclr.cc/", author
    )
    older, oldcoverage, olderrors = scan_iclr_program(f, source, author)
    return published + older, coverage + oldcoverage, errors + olderrors


def scan_acm(f, source, author, key):
    # Publisher-deposited metadata fallback, explicitly not a verified ACM TOC scan.
    rows = []
    cursor = "*"
    seen = set()
    sources = []
    total = None
    for page in range(100):
        u = "https://api.crossref.org/works?" + urlencode(
            {
                "query.author": author,
                "filter": "prefix:10.1145",
                "rows": 1000,
                "select": "DOI,title,author,published,event,container-title,abstract,page,URL,type",
                "cursor": cursor,
            }
        )
        data, e = f.api(u)
        m = data["message"]
        sources.append(e)
        total = m["total-results"]
        items = m["items"]
        for item in items:
            if item["DOI"] not in seen:
                rows.append(item)
                seen.add(item["DOI"])
        print(f"ACM metadata: {len(rows)}/{total} search results", flush=True)
        if not items or len(rows) >= total:
            break
        nextcursor = m.get("next-cursor")
        if not nextcursor:
            raise ValueError("Crossref cursor missing before completion")
        cursor = nextcursor
    else:
        raise ValueError("Crossref pagination limit reached")
    found = []
    journal = []
    for r in rows:
        names = [
            " ".join((a.get("given", ""), a.get("family", ""))).strip()
            for a in r.get("author", [])
        ]
        if normalized(author) not in map(normalized, names):
            continue
        container = " ".join(r.get("container-title", []))
        event = r.get("event", {})
        ismm = bool(
            re.search(
                r"Proceedings of the .*ACM International Conference on Multimedia$",
                container,
                re.I,
            )
        )
        issig = bool(
            re.search(
                r"SIGGRAPH|Special Interest Group on Computer Graphics and Interactive Techniques Conference",
                container,
                re.I,
            )
        )
        istog = "ACM Transactions on Graphics" in container
        if not (ismm if key == "acm_mm" else issig or istog):
            continue
        year = r["published"]["date-parts"][0][0]
        p = {
            "title": r["title"][0],
            "authors": names,
            "year": year,
            "doi": r["DOI"],
            "official_url": r["URL"],
            "source": {
                "url": "https://api.crossref.org/works/" + r["DOI"],
                "provider": "ACM via Crossref",
            },
            "container": container,
            "event": event,
            "source_type": r["type"],
        }
        if r.get("abstract"):
            p["abstract"] = BeautifulSoup(r["abstract"], "html.parser").get_text(
                " ", strip=True
            )
        if r.get("page"):
            p["pages"] = r["page"]
        if istog:
            journal.append(p)
            continue
        p["track"] = "poster" if "Posters" in container else "conference_paper"
        p["conference_variant"] = (
            "SIGGRAPH Asia" if "SIGGRAPH Asia" in container else key
        )
        found.append(p)
    return (
        found,
        [
            {
                "method": "publisher-deposited Crossref metadata",
                "search_results_scanned": len(rows),
                "search_results_total": total,
                "author_papers": len(found),
                "sources": sources,
                "direct_proceedings_verified": False,
                "related_journal_candidates": journal,
            }
        ],
        [],
    )


from historical import with_historical, scan_historical
from language_robotics import scan_anthology, scan_rss, scan_findings


SCANNERS = {
    **{key: (lambda f, s, a, k=key: scan_anthology(f, s, a, k)) for key in ("acl", "emnlp", "naacl")},
    "rss": scan_rss,
    "findings": scan_findings,
    **{key: (lambda f, s, a, k=key: scan_historical(f, k, a)) for key in ("icra", "iros")},
    "cvpr": lambda f, s, a: scan_cvf(f, s, a, "CVPR"),
    "iccv": lambda f, s, a: with_historical(f, s, a, "iccv", lambda f, s, a: scan_cvf(f, s, a, "ICCV")),
    "eccv": lambda f, s, a: with_historical(f, s, a, "eccv", scan_eccv),
    "neurips": scan_neurips,
    "icml": lambda f, s, a: scan_pmlr(f, s, a, "ICML"),
    "corl": lambda f, s, a: scan_pmlr(f, s, a, "CoRL"),
    "ijcai": scan_ijcai,
    "aaai": scan_aaai,
    "iclr": scan_iclr,
    "siggraph": lambda f, s, a: scan_acm(f, s, a, "siggraph"),
    "acm_mm": lambda f, s, a: scan_acm(f, s, a, "acm_mm"),
}


def compare_catalog(papers, pubs, venue_id, author):
    results, extra = compare(papers, pubs, venue_id, author)
    byid = {p["id"]: p for p in pubs}
    for r in results:
        r["status"] = r["status"].replace("cvpr", "conference")
        for match in r["matches"]:
            p = byid[match["id"]]
            if (
                p.get("venue", {}).get("venue_id") != venue_id
                or p["type"] != "conference"
            ):
                continue
            d = next(
                (d for d in r["differences"] if d["publication_id"] == p["id"]), None
            )
            if d is None:
                d = {"publication_id": p["id"], "fields": {}}
                r["differences"].append(d)
            for field in ["title", "abstract"]:
                source = r["paper"].get(field)
                if source and normalized(p.get(field, "")) != normalized(source):
                    d["fields"][field] = {
                        "catalog": p.get(field),
                        "proceedings": source,
                    }
            if r["paper"].get("doi") and normalized(
                p.get("identifiers", {}).get("doi", "")
            ) != normalized(r["paper"]["doi"]):
                d["fields"]["doi"] = {
                    "catalog": p.get("identifiers", {}).get("doi"),
                    "proceedings": r["paper"]["doi"],
                }
        r["differences"] = [d for d in r["differences"] if d["fields"]]
        if r["status"] == "not_found":
            for p in pubs:
                if (
                    p.get("venue", {}).get("venue_id") == venue_id
                    and title_key(p["title"]).startswith(title_key(r["paper"]["title"]))
                    and len(title_key(r["paper"]["title"])) >= 4
                ):
                    if not any(
                        c["id"] == p["id"] for c in r["possible_title_variants"]
                    ):
                        r["possible_title_variants"].append(
                            {
                                "id": p["id"],
                                "title": p["title"],
                                "reason": "source title is a prefix; manual review required",
                            }
                        )
    for p in extra:
        candidates = []
        for paper in papers:
            score = SequenceMatcher(
                None, title_key(p["title"]), title_key(paper["title"])
            ).ratio()
            if score >= 0.8:
                candidates.append(
                    {
                        "title": paper["title"],
                        "url": paper["official_url"],
                        "score": round(score, 3),
                    }
                )
        p["possible_source_title_variants"] = sorted(
            candidates, key=lambda c: -c["score"]
        )[:3]
    return results, extra


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--catalog",
        "--root",
        dest="root",
        type=Path,
        help="Optional MyPub catalog for read-only comparison",
    )
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument(
        "--conferences",
        "--venues",
        dest="venues",
        nargs="+",
        choices=list(SCANNERS),
        default=list(SCANNERS),
    )
    ap.add_argument("--author", required=True)
    ap.add_argument("--offline", action="store_true", help="Read cached responses only")
    args = ap.parse_args()
    if args.root and args.output.resolve().is_relative_to(args.root.resolve()):
        ap.error("Output must be outside catalog")
    args.output.mkdir(parents=True, exist_ok=True)
    pubs, venues = load_catalog(args.root) if args.root else ([], [])
    registry = json.loads(Path(__file__).with_name("sources.json").read_text())
    f = Fetch(args.output / "cache", args.offline)
    failed = False
    from report import write_report

    for key in args.venues:
        venue = next(
            (v for v in venues if v["venue_key"] == key),
            {"id": None, "venue_key": key, **registry[key]},
        )
        source = next(
            (
                u["url"]
                for u in venue["urls"]
                if u["role"] == "proceedings"
                and (
                    key not in ("cvpr", "iccv")
                    or urlparse(u["url"]).hostname == "openaccess.thecvf.com"
                )
            ),
            venue["urls"][0]["url"],
        )
        try:
            papers, coverage, errors = SCANNERS[key](f, source, args.author)
        except Exception as e:
            papers, coverage, errors = [], [], [str(e)]
        papers = list({p["official_url"]: p for p in papers}.values())
        papers.sort(key=lambda p: (p["year"], p["title"]))
        comparison, extra = (
            compare_catalog(
                papers,
                [p for p in pubs if not p.get("archived_at")],
                venue["id"],
                args.author,
            )
            if args.root and venue["id"]
            else ([], [])
        )
        r = {
            "venue": venue,
            "author": args.author,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "papers": papers,
            "coverage": coverage,
            "errors": errors,
            "comparison": comparison,
            "catalog_only": extra,
            "counts": dict(Counter(c["status"] for c in comparison)),
        }
        (args.output / (key + ".json")).write_text(
            json.dumps(r, indent=2, ensure_ascii=False) + "\n"
        )
        write_report(r, args.output / (key + ".md"))
        print(
            key, len(papers), r["counts"], f"{len(errors)} coverage errors", flush=True
        )
        failed = failed or bool(errors)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
