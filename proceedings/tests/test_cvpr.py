import importlib.util
from pathlib import Path
import unittest
import json
import tempfile

spec = importlib.util.spec_from_file_location(
    "cvpr", Path(__file__).resolve().parents[1] / "cvpr.py"
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ProceedingsTests(unittest.TestCase):
    def test_menu_excludes_workshops_findings_and_other_conferences(self):
        page = m.Page(
            '<a href="CVPR2013.py">Main</a><a href="CVPR2026">Main</a><a href="CVPR2026_findings">Findings</a><a href="/CVPR2026_workshops/menu">Workshops</a><a href="ICCV2025">Other</a>',
            "https://openaccess.thecvf.com/menu",
        )
        self.assertEqual(list(m.editions(page)), [2013, 2026])

    def test_index_old_and_new_author_fields_entities_and_boundaries(self):
        page = m.Page(
            '<dt class="ptitle"><a href="content/a.html">First &amp; <em>Best</em></a></dt><dd><input name="query" value="Dahua Lin"><input name="query_author" value="A. Author"></dd><dt class="ptitle"><a href="/content/b.html">Second</a></dt><dd><input name="query_author" value="Dahua Linson"></dd>',
            "https://openaccess.thecvf.com/CVPR2013.py",
        )
        self.assertEqual(page.papers[0]["title"], "First & Best")
        self.assertEqual(page.papers[0]["authors"], ["Dahua Lin", "A. Author"])
        self.assertEqual(page.papers[1]["authors"], ["Dahua Linson"])
        self.assertEqual(
            page.papers[0]["official_url"],
            "https://openaccess.thecvf.com/content/a.html",
        )

    def test_comparison_does_not_count_preprint_as_conference_and_flags_duplicates(
        self,
    ):
        paper = {
            "title": "A: Paper",
            "year": 2024,
            "authors": ["Dahua Lin"],
            "official_url": "https://openaccess.thecvf.com/a.html",
        }
        preprint = {
            "id": "a",
            "title": "A Paper",
            "type": "preprint",
            "authors": [{"name": "Dahua Lin"}],
            "venue": {"venue_id": "arxiv"},
            "_path": "/a",
        }
        conference = {
            **preprint,
            "id": "b",
            "type": "conference",
            "publication_date": "2023",
            "venue": {"venue_id": "cvpr"},
        }
        result, _ = m.compare([paper], [preprint], "cvpr", "Dahua Lin")
        self.assertEqual(result[0]["status"], "other_version_only")
        result, _ = m.compare([paper], [preprint, conference], "cvpr", "Dahua Lin")
        self.assertEqual(result[0]["status"], "cvpr_record_found")
        self.assertIn("year", result[0]["differences"][0]["fields"])
        result, _ = m.compare(
            [paper], [conference, {**conference, "id": "c"}], "cvpr", "Dahua Lin"
        )
        self.assertEqual(result[0]["status"], "multiple_cvpr_records")

    def test_invalid_index_fails_instead_of_claiming_zero_papers(self):
        class Fake:
            def get(self, url):
                return m.Page("<html>Blocked</html>", url), {}

        with self.assertRaises(ValueError):
            m.extract_year(
                Fake(), 2024, "https://openaccess.thecvf.com/CVPR2024", "Dahua Lin"
            )

    def test_detail_names_and_abstract(self):
        page = m.Page(
            '<meta name="citation_author" content="Lin, Dahua"><div id="abstract">One <div>two</div> three.</div>Other',
            "https://openaccess.thecvf.com/a.html",
        )
        self.assertEqual(m.author_display(page.meta["citation_author"][0]), "Dahua Lin")
        self.assertEqual("".join(page.abstract), "One two three.")

    def test_day_only_editions_scan_every_day_and_verify_detail(self):
        base = "https://openaccess.thecvf.com/CVPR2018.py"
        pages = {
            base: '<a href="?day=2018-06-19">Day one</a><a href="?day=2018-06-20">Day two</a>',
            base
            + "?day=2018-06-19": '<dt class="ptitle"><a href="/a.html">A</a></dt><input name="query" value="Other Author">',
            base
            + "?day=2018-06-20": '<dt class="ptitle"><a href="/b.html">B</a></dt><input name="query" value="Dahua Lin">',
            "https://openaccess.thecvf.com/b.html": '<meta name="citation_title" content="B"><meta name="citation_author" content="Lin, Dahua">',
        }

        class Fake:
            def get(self, url):
                return m.Page(pages[url], url), {"url": url}

        papers, scope = m.extract_year(Fake(), 2018, base, "Dahua Lin")
        self.assertEqual(scope["indexed_papers"], 2)
        self.assertEqual([p["title"] for p in papers], ["B"])
        pages["https://openaccess.thecvf.com/b.html"] = (
            '<meta name="citation_title" content="B"><meta name="citation_author" content="Other Author">'
        )
        with self.assertRaises(ValueError):
            m.extract_year(Fake(), 2018, base, "Dahua Lin")

    def test_ieee_snapshot_requires_complete_list_and_preserves_initial_candidates(
        self,
    ):
        snapshot = {
            "url": "https://www.computer.org/csdl/proceedings/cvpr/2012/edition",
            "author": "Dahua Lin",
            "captured_at": "2026-09-08T00:00:00Z",
            "indexed_papers": 100,
            "complete_list": True,
            "records": [
                {
                    "title": "Paper",
                    "authors": ["Dahua Lin"],
                    "official_url": "https://www.computer.org/paper",
                }
            ],
            "initial_candidates": [{"title": "Uncertain", "authors": ["D. Lin"]}],
        }
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "ieee.json"
            file.write_text(json.dumps([snapshot]))
            papers, coverage = m.read_ieee_snapshots(file, "Dahua Lin")
            self.assertEqual(len(papers), 1)
            self.assertFalse(papers[0]["author_order_verified"])
            self.assertEqual(len(coverage[0]["initial_candidates"]), 1)
            snapshot["complete_list"] = False
            file.write_text(json.dumps([snapshot]))
            with self.assertRaises(ValueError):
                m.read_ieee_snapshots(file, "Dahua Lin")


if __name__ == "__main__":
    unittest.main()
