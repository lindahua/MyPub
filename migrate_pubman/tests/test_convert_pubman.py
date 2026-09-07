"""Fictional fixtures only; never read the private production snapshot."""
import copy
import importlib.util
from pathlib import Path
import unittest
import uuid

spec = importlib.util.spec_from_file_location('convert_pubman', Path(__file__).parents[1] / 'scripts/convert_pubman.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
uid = lambda s: str(uuid.uuid5(uuid.NAMESPACE_URL, 'fixture:' + s))


def fixture():
    authors = [dict(id=i, uid=uid('author' + str(i)), first_name=first, mid_name=None, last_name=last, website=None)
               for i, first, last in [(1, 'Jane', 'Doe*'), (2, 'Alex', 'Chen *'), (3, 'Jane', 'Doe')]]
    venue = dict(id=1, uid=uid('venue'), name='arXiv', abbr='arXiv', type='preprint', website=None)
    pubs = [dict(id=i, uid=uid('pub' + str(i)), title='Example', venue_id=1, year=2026,
                 pub_date=None, volume=None, issue=None, pages=None, doi=None, eprint='2601.00001', gs_page=None, pdf_url=None)
            for i in (1, 2)]
    detail = dict(cited_by_count=2, cited_by_url='https://scholar.google.com/citations', fetched_at='2026-01-01T00:00:00Z')
    g = dict(id=1, uid=uid('scholar'), citation_id='profile:entry', profile_user_id='profile', publication_id=1,
             title='Example', authors='J Doe, A Chen, …', author_names=['Jane Doe', 'Alex Chen'], venue='arXiv', year=2025,
             publication_date='2025/1', volume=None, issue=None, pages=None, publisher=None, patent_office=None,
             application_number=None, description='A fictional paper', cited_by_count=0, cited_by_url=None,
             citations_by_year=[dict(year=2025, count=2)], scholar_url='https://scholar.google.com/citations?user=profile&citation_for_view=profile:entry',
             source_payload={'detail': detail, 'overview': {'authors': 'J Doe, A Chen, …', 'cited_by_count': 0}},
             first_seen_at='2026-01-01T00:00:00Z', last_seen_at='2026-02-01T00:00:00Z', detail_fetched_at='2026-01-01T00:00:00Z',
             created_at='2026-01-01T00:00:00Z', updated_at='2026-02-01T00:00:00Z', excluded_from_matching=0,
             exclusion_reason=None, exclusion_confirmed_by_user_id=None, exclusion_confirmed_at=None, is_active=1)
    return dict(authors=authors, venues=[venue], publications=pubs,
                publication_authors=[dict(publication_id=1, author_id=i, author_order=i) for i in (1, 2, 3)] + [dict(publication_id=2, author_id=3, author_order=1)],
                gs_entries=[g], editing_history=[])


def convert(rows):
    return module.convert(rows, 'a' * 64, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', uid('author3'), 'profile')


class ConversionTests(unittest.TestCase):
    def test_reproducible_and_lossless_associations(self):
        source = fixture()
        state, report = convert(source)
        self.assertEqual(convert(copy.deepcopy(source)), (state, report))
        self.assertEqual([a['author_id'] for a in state['publications'][0]['authors']], [uid('author1'), uid('author2'), uid('author3')])
        self.assertEqual(report['destination_counts']['co_first_credits'], 2)
        self.assertEqual(len(state['authors']), 3)
        self.assertEqual(state['authors'][0]['preferred_name'], state['authors'][2]['preferred_name'])
        self.assertNotEqual(state['authors'][0]['id'], state['authors'][2]['id'])
        self.assertIn('same_name_authors', {f['kind'] for f in report['audit_findings']})
        self.assertIn('duplicate_arxiv_id', {f['kind'] for f in report['audit_findings']})
        self.assertEqual(state['authors'][0]['name_parts']['family'], 'Doe')
        self.assertEqual(state['authors'][2]['identifiers']['google_scholar'], 'profile')

    def test_citations_preserve_unknown_and_original_times(self):
        state, report = convert(fixture())
        g = state['gscholar_entries'][0]
        self.assertEqual([c['count'] for c in g['citation_history']], [2, None])
        self.assertEqual(g['annual_citations'][0]['counts'], {'2025': 2})
        self.assertEqual(g['authors_completeness'], 'unknown')
        self.assertEqual(g['authors_text'], 'J Doe, A Chen, …')
        self.assertEqual(g['presence'], 'present')
        self.assertTrue(all(c['coverage'] == 'unknown' for c in state['gscholar_profile']['captures']))
        self.assertIn('scholar_year_disagreement', {f['kind'] for f in report['audit_findings']})

    def test_excluded_unmatched_entry_is_preserved(self):
        source = fixture()
        source['gs_entries'][0].update(publication_id=None, excluded_from_matching=1, exclusion_reason='Not mine')
        state, _ = convert(source)
        g = state['gscholar_entries'][0]
        self.assertEqual(g['matching']['policy'], 'excluded')
        self.assertTrue(any(r['id'] == g['matching']['decision_review_id'] and r['state'] == 'accepted' for r in state['reviews']))
        self.assertFalse(any(p.get('gscholar_entry_id') for p in state['publications']))

    def test_ambiguous_markers_and_surname_particles_are_not_guessed(self):
        source = fixture()
        source['authors'][0].update(first_name='Luc', mid_name='Van', last_name='Gool')
        state, report = convert(source)
        self.assertNotIn('name_parts', state['authors'][0])
        self.assertNotIn('roles', state['publications'][0]['authors'][1])
        self.assertIn('ambiguous_byline_marker', {f['kind'] for f in report['audit_findings']})
        source['authors'][0].update(first_name='Jane', mid_name='Doe', last_name='*')
        state, _ = convert(source)
        self.assertEqual(state['authors'][0]['preferred_name'], 'Jane Doe')
        self.assertNotIn('name_parts', state['authors'][0])

    def test_refuses_invalid_owner_order_exclusion_and_profile(self):
        for change in [lambda r: r['authors'][2].update(uid=uid('different')),
                       lambda r: r['publication_authors'][0].update(author_order=5),
                       lambda r: r['gs_entries'][0].update(excluded_from_matching=1),
                       lambda r: r['gs_entries'][0].update(profile_user_id='wrong')]:
            source = fixture()
            change(source)
            with self.assertRaises(ValueError):
                convert(source)


if __name__ == '__main__':
    unittest.main()
