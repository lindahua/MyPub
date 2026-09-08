#!/usr/bin/env python3
"""Read-only journal issue metadata scans and author/catalog comparisons."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
import json
from pathlib import Path
from urllib.parse import urlencode
from bs4 import BeautifulSoup
from cvpr import normalized, title_key, load_catalog
from historical import initial_candidate
from scan import Fetch

JOURNALS = {
    'tpami': ('0162-8828', 'IEEE Transactions on Pattern Analysis and Machine Intelligence'),
    'tip': ('1057-7149', 'IEEE Transactions on Image Processing'),
    'tmm': ('1520-9210', 'IEEE Transactions on Multimedia'),
    'ijcv': ('0920-5691', 'International Journal of Computer Vision'),
    'tog': ('0730-0301', 'ACM Transactions on Graphics'),
}
FIELDS = 'DOI,title,author,published-print,published-online,published,volume,issue,page,article-number,URL,type,abstract,link,ISSN'


def date_value(value):
    parts = (value or {}).get('date-parts', [[]])[0]
    if not parts or len(parts) > 3 or any(type(n) is not int for n in parts) or not 1000 <= parts[0] <= 9999:
        return None
    text = '-'.join([str(parts[0])] + [f'{n:02d}' for n in parts[1:]])
    try:
        datetime.strptime(text + {1: '-01-01', 2: '-01', 3: ''}[len(parts)], '%Y-%m-%d')
    except (ValueError, TypeError):
        return None
    return text


def article(r):
    names = [' '.join(filter(None, [a.get('given'), a.get('family')])) or a.get('name', '') for a in r.get('author', [])]
    issue = str(r.get('issue') or r.get('journal-issue', {}).get('issue') or '')
    volume = str(r.get('volume') or '')
    issue_date = date_value(r.get('journal-issue', {}).get('published-print'))
    print_date = date_value(r.get('published-print'))
    online_date = date_value(r.get('published-online'))
    # Generic/online dates do not establish the bibliographic issue date.
    publication_date = (issue_date or print_date) if volume else None
    p = {'title': r.get('title', [''])[0], 'authors': names, 'doi': r['DOI'].lower(),
         'official_url': r.get('URL') or 'https://doi.org/' + r['DOI'],
         'volume': volume or None, 'issue': issue or None,
         'publication_date': publication_date, 'online_date': online_date,
         'source_publication_date': date_value(r.get('published')),
         'date_basis': 'issue published-print' if issue_date and volume else 'article published-print with volume assignment' if publication_date else 'issue publication date unverified',
         'issue_assigned': bool(volume), 'pages': r.get('page'), 'article_number': r.get('article-number'),
         'author_order_verified': False}
    if r.get('abstract'):
        p['abstract'] = BeautifulSoup(r['abstract'], 'html.parser').get_text(' ', strip=True)
    for link in r.get('link', []):
        if link.get('content-type') == 'application/pdf':
            p['paper_url'] = link['URL']; break
    return {k: v for k, v in p.items() if v is not None}


def scan_journal(f, key, author, since=None, until=None, volume=None, issue=None):
    issn, name = JOURNALS[key]
    directory = 'https://api.crossref.org/journals/' + issn
    metadata, registry_source = f.api(directory)
    if normalized(metadata['message']['title']) != normalized(name):
        raise ValueError('Journal ISSN/title mismatch')
    valid_issns = set(metadata['message'].get('ISSN', [issn]))
    seen, cursors, sources = set(), set(), [registry_source]
    cursor, total, found, candidates = '*', None, [], []
    groups = defaultdict(lambda: {'indexed_articles': 0, 'author_papers': 0})
    selected = 0
    while True:
        if cursor in cursors:
            raise ValueError('Repeated journal cursor before completion')
        cursors.add(cursor)
        url = directory + '/works?' + urlencode({'filter': 'type:journal-article', 'rows': 1000, 'select': FIELDS, 'cursor': cursor})
        data, evidence = f.api(url); sources.append(evidence)
        m = data['message']
        if total is None: total = m['total-results']
        elif total != m['total-results']: raise ValueError('Journal result count changed; rerun with fresh cache')
        before = len(seen)
        for r in m['items']:
            doi = r['DOI'].lower()
            if doi in seen: continue
            seen.add(doi)
            if r.get('type') != 'journal-article' or not valid_issns.intersection(r.get('ISSN', [])):
                raise ValueError('Unexpected article journal or type: ' + doi)
            names = [' '.join(filter(None, [a.get('given'), a.get('family')])) for a in r.get('author', [])]
            candidate = normalized(author) in map(normalized, names) or any(initial_candidate(n, author) for n in names)
            article_evidence = evidence
            if candidate:
                full, article_evidence = f.api('https://api.crossref.org/works/' + doi)
                r = full['message']
                if r['DOI'].lower() != doi or not valid_issns.intersection(r.get('ISSN', [])):
                    raise ValueError('Article detail identity mismatch: ' + doi)
            p = article(r)
            year = (p.get('publication_date') or p.get('online_date') or p.get('source_publication_date') or '')[:4]
            if since is not None and (not year or int(year) < since): continue
            if until is not None and (not year or int(year) > until): continue
            if volume is not None and p.get('volume') != volume: continue
            if issue is not None and p.get('issue') != issue: continue
            selected += 1
            group = groups[(p.get('volume', 'unassigned'), p.get('issue', 'unspecified'))]
            group['indexed_articles'] += 1
            exact = normalized(author) in map(normalized, p['authors'])
            initial = any(initial_candidate(n, author) for n in p['authors'])
            if exact or initial:
                p['source'] = {**article_evidence, 'record_url': 'https://api.crossref.org/works/' + doi, 'provider': 'publisher via Crossref'}
                (found if exact else candidates).append(p)
                group['author_papers'] += int(exact)
        print(f'{key.upper()}: {len(seen)}/{total} journal articles', flush=True)
        if len(seen) == total: break
        if len(seen) <= before or len(seen) > total or not m.get('next-cursor'):
            raise ValueError('Incomplete journal pagination')
        cursor = m['next-cursor']
    found.sort(key=lambda p: (p.get('publication_date', '9999'), p['title']))
    return {'papers': found, 'initial_only_candidates': candidates,
            'coverage': {'method': 'full journal article catalog via publisher-deposited Crossref metadata',
                         'journal': name, 'issns': sorted(valid_issns), 'indexed_articles': len(seen),
                         'selected_articles': selected, 'filters': {'since': since, 'until': until, 'volume': volume, 'issue': issue},
                         'issues': [{'volume': v, 'issue': i, **counts} for (v, i), counts in sorted(groups.items())],
                         'sources': sources,
                         'limitation': 'Not a direct publisher table-of-contents crawl. Missing deposits and unregistered articles remain possible. Full credited names required; initials listed separately. Issue dates require published-print metadata with volume assignment; online and generic dates do not replace missing issue dates.'}}


def compare_journal(papers, pubs, venue_id, author):
    result, used = [], set()
    for source in papers:
        matches = []
        for p in pubs:
            evidence = 'doi' if p.get('identifiers', {}).get('doi', '').lower() == source['doi'] else 'normalized_title' if title_key(p['title']) == title_key(source['title']) else 'source_url' if source['official_url'] in [p.get('official_url'), *p.get('extra_urls', [])] else None
            if evidence: matches.append((p, evidence))
        journal = [p for p, _ in matches if p['type'] == 'journal' and p.get('venue', {}).get('venue_id') == venue_id]
        status = 'journal_record_found' if len(journal) == 1 else 'multiple_journal_records' if journal else 'other_version_only' if matches else 'not_found'
        differences = []
        for p in journal:
            used.add(p['id']); fields = {}
            for field in ['title', 'volume', 'issue', 'pages', 'article_number', 'publication_date', 'online_date', 'official_url', 'paper_url', 'abstract', 'doi']:
                a = p.get('identifiers', {}).get('doi') if field == 'doi' else p.get(field)
                b = source.get(field)
                if b and normalized(str(a or '')) != normalized(str(b)):
                    fields[field] = {'catalog': a, 'source': b}
            if [normalized(a['name']) for a in p['authors']] != [normalized(n) for n in source['authors']]:
                fields['authors_review'] = {'catalog': [a['name'] for a in p['authors']], 'source': source['authors'], 'note': 'Publisher/PDF byline verification required'}
            if fields: differences.append({'publication_id': p['id'], 'fields': fields})
        near = []
        if not matches:
            for p in pubs:
                if normalized(author) not in [normalized(a['name']) for a in p['authors']]: continue
                score = SequenceMatcher(None, title_key(source['title']), title_key(p['title'])).ratio()
                if score >= .8: near.append({'id': p['id'], 'title': p['title'], 'score': round(score, 3)})
        result.append({'paper': source, 'status': status, 'matches': [{'id': p['id'], 'title': p['title'], 'type': p['type'], 'evidence': e, 'path': p['_path']} for p, e in matches], 'differences': differences, 'possible_title_variants': sorted(near, key=lambda p: -p['score'])[:3]})
    extra = [p for p in pubs if p['id'] not in used and p.get('venue', {}).get('venue_id') == venue_id and normalized(author) in [normalized(a['name']) for a in p['authors']]]
    return result, extra


def write_report(r, path):
    c=r['coverage']; lines=[f'# {c["journal"]} — {r["author"]}', '', 'Read-only comparison; catalog not modified.', '', c['limitation'], '', f'Indexed articles: {c["indexed_articles"]}; selected articles: {c["selected_articles"]}; volume/issue groups: {len(c["issues"])}; exact author matches: {len(r["papers"])}.', '', '| Match status | Papers |', '|---|---:|', *[f'| {k} | {v} |' for k,v in r['counts'].items()], '']
    for item in r['comparison']:
        p=item['paper'];lines += [f'## {p.get("publication_date", "Issue date unverified")}: {p["title"]}', '', f'{item["status"]} — [publisher record]({p["official_url"]}); volume {p.get("volume","?")}, issue {p.get("issue","unspecified")}.', '']
        for m in item['matches']: lines.append(f'- Catalog: [{m["title"]}]({m["path"]}) ({m["type"]})')
        for d in item['differences']:
            lines.append('- Fields to review: ' + ', '.join(d['fields']))
            for field in ['publication_date','online_date','volume','issue','pages','authors_review']:
                if field in d['fields']: lines.append(f'  - {field}: {d["fields"][field]}')
        for p in item['possible_title_variants']: lines.append('- Possible title variant: '+p['title'])
        lines.append('')
    lines += ['## Initial-only author candidates', '', *[f'- [{p["title"]}]({p["official_url"]}): '+', '.join(p['authors']) for p in r['initial_only_candidates']], '', '## Catalog-only records', '', *[f'- {p["title"]}' for p in r['catalog_only']]]
    path.write_text('\n'.join(lines)+'\n')


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--author',required=True);ap.add_argument('--journals',nargs='+',choices=list(JOURNALS),default=list(JOURNALS));ap.add_argument('--output',type=Path,required=True);ap.add_argument('--catalog',type=Path);ap.add_argument('--offline',action='store_true');ap.add_argument('--since',type=int);ap.add_argument('--until',type=int);ap.add_argument('--volume');ap.add_argument('--issue')
    a=ap.parse_args()
    if a.issue and not a.volume: ap.error('--issue requires --volume')
    if a.since and a.until and a.since>a.until: ap.error('--since exceeds --until')
    if a.catalog and a.output.resolve().is_relative_to(a.catalog.resolve()): ap.error('Output must be outside catalog')
    a.output.mkdir(parents=True,exist_ok=True);f=Fetch(a.output/'cache',a.offline)
    pubs,venues=load_catalog(a.catalog) if a.catalog else ([],[]);pubs=[p for p in pubs if not p.get('archived_at')]
    failed=False
    for key in a.journals:
        try:
            r=scan_journal(f,key,a.author,a.since,a.until,a.volume,a.issue)
            venue=next((v for v in venues if v['venue_key']==key),None)
            r.update(journal_key=key,author=a.author,generated_at=datetime.now(timezone.utc).isoformat(),errors=[])
            r['comparison'],r['catalog_only']=compare_journal(r['papers'],pubs,venue['id'],a.author) if venue else ([],[])
            if a.volume is not None:
                r['catalog_only'] = [p for p in r['catalog_only'] if p.get('volume') == a.volume]
            if a.issue is not None:
                r['catalog_only'] = [p for p in r['catalog_only'] if p.get('issue') == a.issue]
            if a.since is not None or a.until is not None:
                r['catalog_only'] = [p for p in r['catalog_only'] if (y := str(p.get('publication_date') or p.get('online_date') or '')[:4]).isdigit() and (a.since is None or int(y) >= a.since) and (a.until is None or int(y) <= a.until)]
            r['counts']=dict(Counter(x['status'] for x in r['comparison']))
            (a.output/(key+'.json')).write_text(json.dumps(r,indent=2,ensure_ascii=False)+'\n');write_report(r,a.output/(key+'.md'))
            print(key,len(r['papers']),r['counts'],flush=True)
        except Exception as exc:
            failed=True; (a.output/(key+'.md')).write_text('# '+key.upper()+' — scan failed\n\n'+str(exc)+'\n'); (a.output/(key+'.json')).write_text(json.dumps({'journal_key':key,'errors':[str(exc)]},indent=2)+'\n');print(key,'ERROR',exc,flush=True)
    return int(failed)

if __name__=='__main__': raise SystemExit(main())
