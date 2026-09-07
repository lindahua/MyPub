#!/usr/bin/env python3
"""Independent field/evidence accounting against the read-only SQLite snapshot."""
import argparse
from collections import Counter
import json
from pathlib import Path
from convert_pubman import load_snapshot, reconcile, timestamp, known_count, clean_name


def verify(snapshot, root, expected_hash, corrections):
    source = load_snapshot(snapshot, expected_hash)
    state = {'library': json.loads((root / 'catalog/library.json').read_text()),
             'owner': json.loads((root / 'catalog/config/author.json').read_text())}
    for kind, path in [('authors', 'authors'), ('venues', 'venues'), ('publications', 'publications'),
                       ('gscholar_entries', 'gscholar/entries'), ('reviews', 'reviews')]:
        state[kind] = [json.loads(p.read_text()) for p in (root / 'catalog' / path).rglob('*.json')]
    reconcile(source, state)
    by_id = {k: {r['id']: r for r in state[k]} for k in ('authors', 'venues', 'publications', 'gscholar_entries', 'reviews')}
    source_authors = {r['id']: r for r in source['authors']}
    source_venues = {r['id']: r for r in source['venues']}
    for r in source['authors']:
        a = by_id['authors'][r['uid']]
        assert a['preferred_name'] == clean_name(r)
        assert '*' not in a['preferred_name']
        if r['uid'] in corrections:
            assert a['name_parts'] == corrections[r['uid']]['name_parts']
    for r in source['venues']:
        v = by_id['venues'][r['uid']]
        assert v['preferred_name'] == r['name']
        assert v.get('abbreviation') == (r['abbr'] or None)
    co_first = 0
    for r in source['publications']:
        p = by_id['publications'][r['uid']]
        assert p['title'] == r['title']
        assert p['publication_date'] == (r['pub_date'] or str(r['year']))
        for field in ('volume', 'issue', 'pages'):
            assert p.get(field) == (str(r[field]) if r[field] is not None and str(r[field]).strip() else None)
        assert p['venue']['venue_id'] == source_venues[r['venue_id']]['uid']
        assert p['venue']['name'] == source_venues[r['venue_id']]['name']
        links = sorted([x for x in source['publication_authors'] if x['publication_id'] == r['id']], key=lambda x: x['author_order'])
        for x, credit in zip(links, p['authors']):
            assert credit['name'] == clean_name(source_authors[x['author_id']])
            assert '*' not in credit['name']
            co_first += 'co_first' in credit.get('roles', [])
        assert p['attachments'] == []
    for r in source['gs_entries']:
        g = by_id['gscholar_entries'][r['uid']]
        assert g['profile_id'] == r['profile_user_id']
        assert g['scholar_id'] == r['citation_id']
        assert g['title'] == r['title']
        assert g['authors'] == r['author_names']
        assert g['authors_text'] == r['authors']
        for field in ('venue', 'publication_date', 'volume', 'issue', 'pages', 'publisher',
                      'patent_office', 'application_number', 'description', 'scholar_url', 'cited_by_url'):
            assert g.get(field) == (str(r[field]) if r[field] is not None and str(r[field]).strip() else None)
        assert g.get('year') == r['year']
        assert g['first_seen_at'] == timestamp(r['first_seen_at'])
        assert g['last_seen_at'] == timestamp(r['last_seen_at'])
        assert g['citation_history'][-1]['count'] == known_count(r['cited_by_count'], r['cited_by_url'])
        assert g['citation_history'][-1]['observed_at'] == timestamp(r['last_seen_at'])
        detail = r['source_payload']['detail']
        assert g['citation_history'][0]['count'] == known_count(detail['cited_by_count'], detail['cited_by_url'])
        assert g['citation_history'][0]['observed_at'] == timestamp(r['detail_fetched_at'])
        if r['citations_by_year']:
            assert g['annual_citations'][0]['counts'] == {str(b['year']): b['count'] for b in r['citations_by_year']}
            assert g['annual_citations'][0]['observed_at'] == timestamp(r['detail_fetched_at'])
        if r['excluded_from_matching']:
            assert g['matching']['reason'] == r['exclusion_reason']
        assert by_id['reviews'][g['source_review_id']]['evidence']['payload']['row'] == r
    retained = {t: [] for t in ('authors', 'venues', 'publications', 'publication_authors', 'editing_history')}
    for review in state['reviews']:
        payload = review.get('evidence', {}).get('payload', {})
        table = payload.get('table', '').removeprefix('mypubs.')
        if table in retained:
            retained[table].extend(payload['rows'])
            retained['publication_authors'].extend(payload.get('publication_authors', []))
    for table, values in retained.items():
        serialize = lambda r: json.dumps(r, sort_keys=True, ensure_ascii=False)
        assert Counter(map(serialize, source[table])) == Counter(map(serialize, values)), table
    return {'verified': True, 'publications': len(state['publications']), 'authors': len(state['authors']),
            'venues': len(state['venues']), 'scholar_entries': len(state['gscholar_entries']),
            'ordered_credits': len(source['publication_authors']), 'co_first_credits': co_first,
            'historical_events_retained': len(retained['editing_history']),
            'evidence_row_equality': True, 'bibliographic_and_scholar_field_equality': True}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('snapshot', type=Path)
    p.add_argument('catalog', type=Path)
    p.add_argument('--sha256', required=True)
    p.add_argument('--corrections', type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(verify(a.snapshot, a.catalog, a.sha256, json.loads(a.corrections.read_text())), indent=2))
