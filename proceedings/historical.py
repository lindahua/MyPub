"""ICCV/ECCV historical and ICRA/IROS search using publisher-deposited metadata.

This is not a complete publisher table-of-contents crawl. All search results are
paged, exact credited names are required, and initial-only credits are reported
separately. No catalog data is used to discover papers.
"""
import re
from datetime import datetime
from urllib.parse import urlencode
from bs4 import BeautifulSoup
from cvpr import normalized

CONFIG = {
    'icra': ('10.1109', 'International Conference on Robotics and Automation', datetime.now().year, range(2020, datetime.now().year + 1)),
    'iros': ('10.1109', 'International Conference on Intelligent Robots and Systems', datetime.now().year, range(2020, datetime.now().year + 1)),
    'iccv': ('10.1109', 'International Conference on Computer Vision', 2011, range(2005, 2012, 2)),
    'eccv': ('10.1007', 'Computer Vision ECCV', 2016, range(2004, 2017, 2)),
}


def edition(record, key):
    containers = record.get('container-title', [])
    event = record.get('event', {}).get('name', '')
    titles = containers + ([event] if event else [])
    if any(re.search(r'workshop|\bICCVW\b|\bECCVW\b', t, re.I) for t in titles):
        return None
    if key == 'eccv':
        for t in containers:
            m = re.fullmatch(r'Computer Vision\s*[-–—:]?\s*ECCV\s+(\d{4})(?:\s*[,–-]?\s*Part\s+[IVX]+)?', t, re.I)
            if m and record.get('type') == 'book-chapter':
                return int(m[1])
    elif record.get('type') == 'proceedings-article':
        for t in titles:
            pattern = {'iccv': r'International Conference on Computer Vision|\bICCV\b', 'icra': r'International Conference on Robotics and Automation|\bICRA\b', 'iros': r'International Conference on Intelligent Robots and Systems|\bIROS\b'}[key]
            if re.search(pattern, t, re.I):
                years = re.findall(r'\b(?:19|20)\d{2}\b', t)
                if len(set(years)) == 1:
                    return int(years[0])
                parts = record.get('event', {}).get('start', {}).get('date-parts', [[]])[0]
                if parts:
                    return parts[0]
                parts = record.get('published', {}).get('date-parts', [[]])[0]
                if parts:
                    return parts[0]
    return None


def initial_candidate(name, author):
    a, b = name.casefold().replace('.', '').split(), author.casefold().replace('.', '').split()
    return len(a) == len(b) and len(a) > 1 and a[-1] == b[-1] and all(x == y or (len(x) == 1 and y.startswith(x)) for x, y in zip(a[:-1], b[:-1]))


def scan_historical(fetch, key, author):
    prefix, container, end, years = CONFIG[key]
    start = min(years)
    sources, seen, records = [], set(), []
    cursor, cursors, total = '*', set(), None
    for _ in range(100):
        if cursor in cursors:
            raise ValueError('Historical Crossref cursor repeated before completion')
        cursors.add(cursor)
        url = 'https://api.crossref.org/works?' + urlencode({
            'query.author': author, 'query.container-title': container,
            'filter': f'prefix:{prefix},from-pub-date:{start}-01-01,until-pub-date:{end}-12-31',
            'rows': 1000,
            'select': 'DOI,title,author,published,event,container-title,abstract,page,URL,type,link',
            'cursor': cursor,
        })
        data, evidence = fetch.api(url)
        message = data['message']
        if total is None:
            total = message['total-results']
        elif total != message['total-results']:
            raise ValueError('Historical Crossref result count changed; rerun with a fresh cache')
        sources.append(evidence)
        items = message['items']
        before = len(records)
        for item in items:
            doi = item['DOI'].lower()
            if doi not in seen:
                seen.add(doi)
                records.append(item)
        print(f'{key.upper()} historical metadata: {len(records)}/{total}', flush=True)
        if len(records) == total:
            break
        if not items or len(records) == before or len(records) > total:
            raise ValueError('Historical Crossref results incomplete or inconsistent')
        cursor = message.get('next-cursor')
        if not cursor:
            raise ValueError('Historical Crossref cursor missing before completion')
    else:
        raise ValueError('Historical Crossref pagination limit reached')
    found, candidates, counts = [], [], {y: 0 for y in years}
    for r in records:
        year = edition(r, key)
        if year not in counts:
            continue
        counts[year] += 1
        names = [' '.join(filter(None, [a.get('given'), a.get('family')])) for a in r.get('author', [])]
        exact = normalized(author) in map(normalized, names)
        if not exact and not any(initial_candidate(n, author) for n in names):
            continue
        p = {'title': r['title'][0], 'authors': names, 'year': year,
             'doi': r['DOI'], 'official_url': r.get('URL') or 'https://doi.org/' + r['DOI'],
             'conference': ' / '.join(r.get('container-title', [])),
             'source': {'provider': ('Springer' if key == 'eccv' else 'IEEE') + ' via Crossref',
                        'url': 'https://api.crossref.org/works/' + r['DOI']},
             'author_order_verified': False}
        parts = r.get('published', {}).get('date-parts', [[]])[0]
        if parts:
            p['publication_date'] = '-'.join([str(parts[0])] + [f'{n:02d}' for n in parts[1:]])
        if r.get('page'):
            p['pages'] = r['page']
        if r.get('abstract'):
            p['abstract'] = BeautifulSoup(r['abstract'], 'html.parser').get_text(' ', strip=True)
        for link in r.get('link', []):
            if link.get('content-type') == 'application/pdf':
                p['paper_url'] = link['URL']
                break
        (found if exact else candidates).append(p)
    return found, [{
        'method': ('IEEE publisher-deposited Crossref metadata' if key in ('icra', 'iros') else 'historical publisher-deposited Crossref metadata'),
        'requested_years': list(years), 'minimum_year': start,
        'search_results_scanned': len(records), 'search_results_total': total,
        'matching_venue_search_results_by_year': counts,
        'author_papers': len(found), 'initial_only_candidates': candidates,
        'direct_proceedings_verified': False, 'sources': sources,
        'limitation': 'Search-index coverage, not a complete proceedings census. Zero matches do not prove absence. Initial-only names require review; byline order requires publisher/PDF verification.',
    }], []


def with_historical(fetch, source, author, key, modern):
    papers, coverage, errors = [], [], []
    for run in (lambda: modern(fetch, source, author), lambda: scan_historical(fetch, key, author)):
        try:
            p, c, e = run()
            papers.extend(p); coverage.extend(c); errors.extend(e)
        except Exception as exc:
            errors.append(str(exc))
    return papers, coverage, errors
