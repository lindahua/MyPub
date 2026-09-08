import sys
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from historical import edition, scan_historical, with_historical


def paper(doi='10.1007/test', year=2006, author='Dahua'):
    return {'DOI': doi, 'title': ['Example'], 'author': [{'given': author, 'family': 'Lin'}],
            'type': 'book-chapter', 'container-title': ['Lecture Notes in Computer Science', f'Computer Vision – ECCV {year}'],
            'published': {'date-parts': [[year]]}, 'page': '13-26'}


class Pages:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.calls = []
    def api(self, url):
        self.calls.append(parse_qs(urlparse(url).query))
        return {'message': next(self.pages)}, {'url': url}


class HistoricalTests(unittest.TestCase):
    def test_classification(self):
        self.assertEqual(edition(paper(), 'eccv'), 2006)
        for name in ['Computer Vision – ECCV 2006 Workshops', 'ECCV Workshop 2006', 'Other Computer Vision 2006']:
            r = paper(); r['container-title'] = [name]
            self.assertIsNone(edition(r, 'eccv'))
        r = paper(); r.update(type='proceedings-article', **{'container-title': ['2005 IEEE International Conference on Computer Vision (ICCV)']})
        self.assertEqual(edition(r, 'iccv'), 2005)
        r['container-title'] = ['2005 IEEE International Conference on Computer Vision Workshops']
        self.assertIsNone(edition(r, 'iccv'))

    def test_pagination_year_floor_and_initial_candidates(self):
        rows = [paper(), paper('10.1007/initial', author='D.'), paper('10.1007/old', year=2002), paper('10.1007/new', year=2018), paper('10.1007/other', author='Dahuaa')]
        f = Pages([{'items': rows[:2], 'total-results': 5, 'next-cursor': 'next'}, {'items': rows[2:], 'total-results': 5}])
        papers, coverage, errors = scan_historical(f, 'eccv', 'Dahua Lin')
        self.assertEqual(len(papers), 1)
        self.assertEqual(len(coverage[0]['initial_only_candidates']), 1)
        self.assertEqual(coverage[0]['requested_years'], list(range(2004, 2017, 2)))
        self.assertEqual(f.calls[1]['cursor'], ['next'])
        self.assertIn('from-pub-date:2004-01-01', f.calls[0]['filter'][0])
        self.assertFalse(errors)

    def test_incomplete_results_fail(self):
        for tail in [{'items': [], 'total-results': 2}, {'items': [paper()], 'total-results': 2}, {'items': [paper('second')], 'total-results': 3}]:
            f = Pages([{'items': [paper()], 'total-results': 2, 'next-cursor': 'next'}, tail])
            with self.assertRaises(ValueError): scan_historical(f, 'eccv', 'Dahua Lin')
        f = Pages([{'items': [paper()], 'total-results': 2, 'next-cursor': '*'}])
        with self.assertRaisesRegex(ValueError, 'repeated'): scan_historical(f, 'eccv', 'Dahua Lin')

    def test_failed_history_preserves_modern_results(self):
        f = Pages([{'items': [], 'total-results': 1}])
        papers, _, errors = with_historical(f, '', 'Dahua Lin', 'eccv', lambda *a: ([{'title': 'Modern'}], [], []))
        self.assertEqual(papers, [{'title': 'Modern'}])
        self.assertTrue(errors)
