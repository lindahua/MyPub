"""Official ACL Anthology and RSS proceedings adapters (2020 onward)."""
import re
from urllib.parse import urljoin, urlparse
from cvpr import normalized


def scan_anthology(f, source, author, key, since=2020, findings_only=False):
    from scan import meta_paper, scan_jobs
    volumes = {}
    sources = []
    for directory in (['https://aclanthology.org/venues/findings/'] if findings_only else [source]):
        soup, evidence = f.soup(directory)
        sources.append(evidence)
        for a in soup.select('a[href]'):
            url = urljoin(directory, a['href'])
            m = re.fullmatch(r'/volumes/(\d{4})\.(?:' + key + r'-(main|long|short|demo|industry)|findings-(' + key + r'))/', urlparse(url).path)
            if m and int(m[1]) >= since and bool(m[3]) == findings_only:
                volumes[url] = (int(m[1]), 'findings' if m[3] else m[2], a.get_text(' ', strip=True))
    if not volumes:
        raise ValueError('No eligible Anthology volumes discovered')
    def volume(year, url):
        soup, evidence = f.soup(url)
        volume_id = urlparse(url).path.strip('/').split('/')[-1]
        rows = {}
        for a in soup.select('strong a[href]'):
            m = re.fullmatch('/' + re.escape(volume_id) + r'\.(\d+)/', urlparse(urljoin(url, a['href'])).path)
            if not m or int(m[1]) == 0:
                continue  # Front matter/editors are not author papers.
            block = a.find_parent('span', class_='d-block')
            if block is None:
                raise ValueError('Unknown Anthology byline layout')
            names = [x.get_text(' ', strip=True) for x in block.select('a[href^="/people/"]')]
            if not names:
                raise ValueError('Missing Anthology row authors')
            rows[urljoin(url, a['href'])] = names
        if not rows:
            raise ValueError('Empty Anthology volume')
        papers = []
        for u, names in rows.items():
            if normalized(author) in map(normalized, names):
                p = meta_paper(f, u, year)
                if normalized(author) not in map(normalized, p['authors']):
                    raise ValueError('Index/detail author mismatch: ' + u)
                p['track'] = volumes[url][1]
                p['conference'] = volumes[url][2]
                papers.append(p)
        return papers, {'year': year, 'track': volumes[url][1], 'indexed_papers': len(rows), 'author_papers': len(papers), 'sources': [evidence, *sources]}
    return scan_jobs([(v[0], u) for u, v in sorted(volumes.items())], volume)


def scan_rss(f, source, author, since=2020):
    from scan import meta_paper, scan_jobs
    soup, evidence = f.soup(source)
    editions = {}
    for a in soup.select('a[href]'):
        u = urljoin(source, a['href'])
        m = re.fullmatch(r'/rss(\d+)/index.html', urlparse(u).path)
        if m:
            number = int(m[1])
            year = number if number >= 2000 else number + 2004
            if year >= since:
                editions[year] = u
    if not editions:
        raise ValueError('No RSS editions discovered')
    def volume(year, url):
        soup, e = f.soup(url)
        papers, rows = [], {}
        for a in soup.select('td a[href]'):
            if not re.fullmatch(r'p\d+\.html', a['href']):
                continue
            td = a.find_parent('td'); byline = td.find('i')
            if not byline:
                raise ValueError('Missing RSS index byline')
            names = [n.strip() for n in byline.get_text(' ', strip=True).split(',')]
            rows[urljoin(url, a['href'])] = (names, a.get_text(' ', strip=True))
        if not rows:
            raise ValueError('Empty RSS proceedings')
        for u, (names, title) in rows.items():
            if normalized(author) in map(normalized, names):
                p = meta_paper(f, u, year, names, title)
                if normalized(author) not in map(normalized, p['authors']):
                    raise ValueError('RSS index/detail byline mismatch')
                p['conference'] = 'Robotics: Science and Systems'
                papers.append(p)
        return papers, {'year': year, 'indexed_papers': len(rows), 'author_papers': len(papers), 'sources': [e, evidence]}
    return scan_jobs(sorted(editions.items()), volume)


def scan_findings(f, source, author):
    papers, coverage, errors = [], [], []
    for key in ('acl', 'emnlp', 'naacl'):
        try:
            p, c, e = scan_anthology(f, source, author, key, findings_only=True)
            for paper in p:
                paper['host_conference'] = key
            papers.extend(p); coverage.extend(c); errors.extend(e)
        except Exception as exc:
            errors.append(key + ' Findings: ' + str(exc))
    return papers, coverage, errors
