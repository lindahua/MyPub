import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import scan


class Fake:
    def __init__(self, pages=None, data=None):
        self.pages, self.data = pages or {}, data or {}

    def soup(self, url):
        if url not in self.pages:
            raise ValueError("Unavailable " + url)
        return BeautifulSoup(self.pages[url], "html.parser"), {"url": url}

    def api(self, url):
        if url not in self.data:
            raise ValueError("Unavailable " + url)
        return self.data[url], {"url": url}


class ScanTests(unittest.TestCase):
    def test_ecva_surname_first_and_exact_names(self):
        source = "https://www.ecva.net/papers.php"
        url = "https://www.ecva.net/papers/eccv_2018/a.html"
        fake = Fake(
            {
                source: '<dt class="ptitle"><a href="papers/eccv_2018/a.html">Paper</a></dt><dd>Other, A and Lin, Dahua</dd><dt class="ptitle"><a href="papers/eccv_2018/b.html">Not ours</a></dt><dd>Dahua Linson</dd>',
                url: '<div id="abstract">The abstract</div>',
            }
        )
        papers, coverage, errors = scan.scan_eccv(fake, source, "Dahua Lin")
        self.assertEqual(papers[0]["authors"], ["A Other", "Dahua Lin"])
        self.assertEqual(coverage[0]["indexed_papers"], 2)
        self.assertEqual(len(papers), 1)
        self.assertFalse(errors)

    def test_pmlr_ignores_colocated_named_events(self):
        source = "https://proceedings.mlr.press/"
        fake = Fake(
            {
                source: '<li><a href="v1">Vol 1</a> Proceedings of ICML 2025</li><li><a href="v2">Vol 2</a> TerraBytes at ICML 2025</li><li><a href="v3">Vol 3</a> ICML Workshop 2025</li>',
                source
                + "v1/": '<div class="paper"><p class="title">Paper</p><span class="authors">Dahua Linson</span><a href="a.html">abs</a></div>',
            }
        )
        papers, coverage, errors = scan.scan_pmlr(fake, source, "Dahua Lin", "ICML")
        self.assertEqual(len(coverage), 1)
        self.assertFalse(papers)
        self.assertFalse(errors)

    def test_iclr_rejects_submission_not_accepted(self):
        page = "https://iclr.cc/virtual/2020/papers.html"
        data = "https://iclr.cc/data/orals-posters.json"
        base = {
            "id": 1,
            "name": "Paper",
            "authors": [{"fullname": "Dahua Lin"}],
            "eventtype": "Poster",
            "paper_url": "https://openreview.net/forum?id=a",
            "abstract": "A",
        }
        fake = Fake(
            {page: '<script>start("/data/orals-posters.json")</script>'},
            {
                data: {
                    "count": 2,
                    "next": None,
                    "results": [
                        {**base, "decision": "Accept (Poster)"},
                        {**base, "id": 2, "decision": "Reject"},
                    ],
                }
            },
        )
        papers, coverage, errors = scan.scan_iclr_program(fake, "unused", "Dahua Lin")
        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0]["abstract"], "A")
        self.assertTrue(errors)  # Other historical editions were not supplied.
        fake.data[data]["next"] = "another-page"
        papers, _, errors = scan.scan_iclr_program(fake, "unused", "Dahua Lin")
        self.assertFalse(papers)
        self.assertTrue(any("Incomplete program pagination" in e for e in errors))

    def test_metadata_abstract_and_author_order(self):
        fake = Fake(
            {
                "https://example.org/p": '<meta name="citation_title" content="Paper"><meta name="citation_author" content="Lin, Dahua"><meta name="citation_author" content="Other, A"><h4>Abstract</h4><p>Actual abstract.</p>'
            }
        )
        p = scan.meta_paper(fake, "https://example.org/p", 2025)
        self.assertEqual(p["authors"], ["Dahua Lin", "A Other"])
        self.assertEqual(p["abstract"], "Actual abstract.")

    def test_corrupt_cache_is_rejected(self):
        import hashlib

        with tempfile.TemporaryDirectory() as d:
            f = scan.Fetch(d, True)
            url = "https://example.org"
            key = hashlib.sha256(url.encode()).hexdigest()
            Path(d, key + ".body").write_text("changed")
            Path(d, key + ".json").write_text(
                json.dumps({"url": url, "sha256": "wrong"})
            )
            with self.assertRaisesRegex(ValueError, "integrity"):
                f.raw(url)

    def test_named_prefix_suggested_not_auto_linked(self):
        paper = {
            "title": "MMOCR",
            "authors": ["Dahua Lin"],
            "year": 2021,
            "official_url": "https://doi.org/a",
        }
        pub = {
            "id": "a",
            "title": "MMOCR: A Comprehensive Toolbox",
            "type": "conference",
            "authors": [{"name": "Dahua Lin"}],
            "venue": {"venue_id": "mm"},
            "_path": "/a",
        }
        results, _ = scan.compare_catalog([paper], [pub], "mm", "Dahua Lin")
        self.assertEqual(results[0]["status"], "not_found")
        self.assertEqual(results[0]["possible_title_variants"][0]["id"], "a")

    def test_registry_includes_all_requested_conferences(self):
        self.assertEqual(
            set(scan.SCANNERS),
            {
                "cvpr",
                "iccv",
                "eccv",
                "neurips",
                "icml",
                "iclr",
                "aaai",
                "ijcai",
                "siggraph",
                "acm_mm",
                "corl",
            },
        )


class ProviderBoundaryTests(unittest.TestCase):
    def test_aaai_archive_pagination_and_bylines(self):
        root = "https://ojs.aaai.org/index.php/AAAI/"
        archive = root + "issue/archive"
        pages = {
            archive: '<a href="archive/2">Next</a>',
            root
            + "issue/archive/2": '<div class="obj_issue_summary"><a class="title" href="view/1">AAAI-26 Technical Tracks 1</a>2026</div>',
            root
            + "issue/archive/view/1": '<title>AAAI-26</title><div class="obj_article_summary"><h3 class="title"><a href="https://example.org/p">Paper</a></h3><div class="authors">Dahua Lin, A Other</div></div>',
            "https://example.org/p": '<meta name="citation_title" content="Paper"><meta name="citation_author" content="Dahua Lin"><meta name="citation_author" content="A Other">',
        }
        # The synthetic issue's relative URL is resolved against its archive page.
        papers, coverage, errors = scan.scan_aaai(Fake(pages), archive, "Dahua Lin")
        self.assertEqual(len(papers), 1)
        self.assertEqual(coverage[0]["year"], 2026)
        self.assertFalse(errors)

    def test_acm_container_filter_does_not_infer_event_from_sponsor(self):
        class Api:
            def api(self, url):
                def paper(doi, container):
                    return {
                        "DOI": doi,
                        "title": ["Paper " + doi],
                        "author": [{"given": "Dahua", "family": "Lin"}],
                        "published": {"date-parts": [[2025]]},
                        "container-title": [container],
                        "URL": "https://doi.org/" + doi,
                        "type": "proceedings-article",
                        "event": {"sponsor": ["SIGGRAPH"]},
                    }

                items = [
                    paper(
                        "a",
                        "Proceedings of the 32nd ACM International Conference on Multimedia",
                    ),
                    paper("b", "Proceedings of a Multimedia Workshop"),
                    paper("c", "ACM Transactions on Graphics"),
                    paper("d", "Proceedings of UIST"),
                ]
                return {"message": {"total-results": 4, "items": items}}, {"url": url}

        papers, coverage, errors = scan.scan_acm(Api(), "unused", "Dahua Lin", "acm_mm")
        self.assertEqual([p["doi"] for p in papers], ["a"])
        papers, coverage, errors = scan.scan_acm(
            Api(), "unused", "Dahua Lin", "siggraph"
        )
        self.assertEqual(papers, [])
        self.assertEqual(len(coverage[0]["related_journal_candidates"]), 1)
        self.assertFalse(coverage[0]["direct_proceedings_verified"])


if __name__ == "__main__":
    unittest.main()
