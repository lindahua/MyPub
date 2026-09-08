#!/usr/bin/env python3
"""One-time, offline PubMan2 snapshot conversion. No credentials or live DB access.

Writes a private, deterministic proposed CatalogState and reconciliation report.
The companion install_catalog.mjs validates and installs with the regular core.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import unicodedata
import uuid

FORMAT = 'pubman2-to-mypub/1'
TABLES = ('authors', 'venues', 'publications', 'publication_authors', 'gs_entries')
JSON_COLUMNS = {'author_names', 'citations_by_year', 'source_payload', 'details'}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Source timestamp lacks timezone')
    return parsed.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def load_snapshot(path, expected_hash):
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected_hash:
        raise ValueError('Snapshot hash differs from the approved baseline')
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('SQLite integrity check failed')
        rows = {t: [dict(r) for r in db.execute(f'SELECT * FROM "mypubs.{t}"')]
                for t in TABLES}
        # Deliberate whitelist: do not read IP/browser data or account tables.
        rows['editing_history'] = [dict(r) for r in db.execute(
            'SELECT id,user_id,created_at,action,entity_type,entity_id,details '
            'FROM "mypubs.editing_history" ORDER BY id')]
    for values in rows.values():
        for row in values:
            for key in JSON_COLUMNS & row.keys():
                if isinstance(row[key], str):
                    row[key] = json.loads(row[key])
    for row in rows['editing_history']:
        if row['entity_type'] == 'user':
            row['details'] = {'note': 'Account-event details retained only in protected snapshot.'}
    return rows


def text(value):
    return value.strip() if isinstance(value, str) else value


def name(row):
    return ' '.join(str(row[k]).strip() for k in ('first_name', 'mid_name', 'last_name')
                    if row.get(k) and str(row[k]).strip())


def clean_name(row):
    return re.sub(r'\s*\*\s*$', '', name(row)).strip()


def parts(row):
    family = re.sub(r'\s*\*\s*$', '', row['last_name'] or '').strip()
    given = ' '.join(row[k].strip() for k in ('first_name', 'mid_name')
                     if row.get(k) and row[k].strip())
    # Do not guess a compound surname or recover one from a standalone marker.
    if not family or '*' in family or re.search(r'\b(van|von|de|del|da|di|der|den)\b',
                                               row.get('mid_name') or '', re.I):
        return None
    return {'family': family, **({'given': given} if given else {})}


def key_slug(value, fallback):
    ascii_text = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '_', ascii_text.lower()).strip('_')[:70].rstrip('_') or fallback


def keys(rows, base):
    candidates = {r['uid']: base(r) for r in rows}
    counts = Counter(candidates.values())
    result = {uid: key if counts[key] == 1 else key + '_' + uid.replace('-', '')[:8]
              for uid, key in candidates.items()}
    # UUID-prefix collisions must not introduce key collisions.
    if len(set(result.values())) != len(result):
        result = {uid: key + '_' + uid.replace('-', '') for uid, key in candidates.items()}
    return result


def known_count(count, cited_by_url):
    if count is None:
        return None
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise ValueError('Invalid source citation count')
    return None if count == 0 and not cited_by_url else count


def convert(rows, snapshot_hash, captured_at, migration_time, owner_id, profile_id, corrections=None):
    corrections = corrections or {}
    captured_at, migration_time = timestamp(captured_at), timestamp(migration_time)
    ns = uuid.uuid5(uuid.NAMESPACE_URL, 'mypub:pubman2:' + snapshot_hash)
    uid = lambda label: str(uuid.uuid5(ns, label))
    base = lambda id: dict(schema_version=2, id=id, created_at=migration_time, updated_at=migration_time)
    authors = {r['id']: r for r in rows['authors']}
    venues = {r['id']: r for r in rows['venues']}
    publications = {r['id']: r for r in rows['publications']}
    all_ids = [r['uid'] for t in ('authors', 'venues', 'publications', 'gs_entries') for r in rows[t]]
    if len(set(all_ids)) != len(all_ids) or any(str(uuid.UUID(x)) != x for x in all_ids):
        raise ValueError('Invalid/duplicate legacy UUID')
    if set(corrections) - {r['uid'] for r in rows['authors']}:
        raise ValueError('Correction refers to an unknown author')
    if owner_id not in {r['uid'] for r in rows['authors']}:
        raise ValueError('Confirmed owner UUID not found')
    if {r['profile_user_id'] for r in rows['gs_entries']} != {profile_id}:
        raise ValueError('Snapshot does not contain exactly the confirmed Scholar profile')
    state = dict(library={**base(uid('library')), 'name': 'Dahua Lin Publications'},
                 owner={'schema_version': 2, 'self_author_id': owner_id},
                 publications=[], authors=[], venues=[], gscholar_entries=[], reviews=[])
    root_review_id = uid('migration-root')
    report = dict(format=FORMAT, converter_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), snapshot_sha256=snapshot_hash, snapshot_captured_at=captured_at,
                  migration_time=migration_time, source_counts={k: len(v) for k, v in rows.items()},
                  owner_author_id=owner_id, profile_id=profile_id, transformations=[],
                  audit_findings=[], attachments={'source_url_count': 0, 'managed_files': 0,
                  'decision': 'User confirmed there are no separate attachment files.'})

    def review(label, summary, targets, payload=None, provider='pubman2', pending=False):
        r = {**base(uid(label)), 'kind': 'change' if pending else 'migration',
             'summary': summary, 'state': 'pending' if pending else 'accepted',
             'targets': targets, 'proposals': []}
        if pending:
            r['source_review_id'] = root_review_id
        else:
            r['decided_at'] = migration_time
        if payload is not None:
            r['evidence'] = dict(provider=provider, captured_at=captured_at,
                                 source_reference='pubman.sqlite:' + label, payload=payload,
                                 completeness='complete' if provider == 'pubman2' else 'unknown',
                                 parser_version=FORMAT, input_fingerprint=digest(payload))
        state['reviews'].append(r)
        return r['id']

    target = lambda kind, id: {'entity_type': kind, 'entity_id': id}
    ak = keys(rows['authors'], lambda r: key_slug(' '.join([re.sub(r'\s*\*\s*$', '', r['last_name'] or ''), r['first_name'] or '', r['mid_name'] or '']), 'author'))
    for r in sorted(rows['authors'], key=lambda r: r['id']):
        a = {**base(r['uid']), 'author_key': ak[r['uid']], 'preferred_name': clean_name(r),
             'aliases': [], 'identifiers': {}}
        correction = corrections.get(r['uid'])
        np = correction['name_parts'] if correction else parts(r)
        if correction:
            report['transformations'].append(dict(kind='reviewed_name_parts', author_id=r['uid'], name_parts=np, reason=correction['reason']))
        if np:
            a['name_parts'] = np
        else:
            a['disambiguation_note'] = 'Legacy name components require surname review; original components are retained in migration evidence.'
            report['audit_findings'].append(dict(kind='unresolved_surname', author_ids=[r['uid']], source_ids=[r['id']]))
            review('surname:' + r['uid'], 'Review inherited surname for ' + a['preferred_name'], [target('author', r['uid'])], pending=True)
        if r['uid'] == owner_id:
            a['identifiers']['google_scholar'] = profile_id
        if name(r) != a['preferred_name']:
            report['transformations'].append(dict(kind='removed_author_marker', author_id=r['uid'], original=name(r), name=a['preferred_name']))
        if r.get('website'):
            raise ValueError('Unexpected populated author website needs an explicit field mapping')
        state['authors'].append(a)
    names = defaultdict(list)
    for a in state['authors']:
        names[a['preferred_name']].append(a['id'])
    for name_value, ids in names.items():
        if len(ids) > 1:
            finding = dict(kind='same_name_authors', name=name_value, author_ids=ids)
            report['audit_findings'].append(finding)
            review('same-name:' + ':'.join(ids), 'Review distinct identities named ' + name_value,
                   [target('author', id) for id in ids], pending=True)

    vk = keys(rows['venues'], lambda r: key_slug(r['abbr'] or r['name'], 'venue'))
    for r in sorted(rows['venues'], key=lambda r: r['id']):
        kind = r['type']
        if kind == 'preprint':
            if (r['name'] or '').lower() != 'arxiv':
                raise ValueError('Non-arXiv preprint venue needs a reviewed mapping')
            kind = 'repository'
        v = {**base(r['uid']), 'venue_key': vk[r['uid']], 'kind': kind,
             'preferred_name': r['name'], 'aliases': [], 'urls': [r['website']] if r['website'] else []}
        if r['abbr']:
            v['abbreviation'] = r['abbr']
        state['venues'].append(v)

    links = defaultdict(list)
    for r in rows['publication_authors']:
        if r['publication_id'] not in publications or r['author_id'] not in authors:
            raise ValueError('Dangling authorship association')
        links[r['publication_id']].append(r)
    sk = keys(rows['publications'], lambda r: key_slug(str(r['year']) + '_' + r['title'], 'publication'))
    matches = {}
    for g in rows['gs_entries']:
        if g['publication_id'] is not None:
            if g['publication_id'] in matches or g['publication_id'] not in publications:
                raise ValueError('Duplicate/dangling Scholar link')
            matches[g['publication_id']] = g['uid']
    for r in sorted(rows['publications'], key=lambda r: r['id']):
        v = venues[r['venue_id']]
        p = {**base(r['uid']), 'citation_key': sk[r['uid']],
             'type': 'preprint' if v['type'] == 'preprint' else v['type'], 'title': r['title'],
             'authors': [], 'venue': dict(name=v['name'], venue_id=v['uid']),
             'identifiers': {}, 'urls': [], 'tags': [], 'relations': [], 'attachments': []}
        ordered = sorted(links[r['id']], key=lambda x: x['author_order'])
        if [x['author_order'] for x in ordered] != list(range(1, len(ordered) + 1)) or len({x['author_id'] for x in ordered}) != len(ordered):
            raise ValueError('Ambiguous author order or duplicate credit')
        marked = [bool(re.search(r'\*\s*$', name(authors[x['author_id']]))) for x in ordered]
        front = next((i for i, value in enumerate(marked) if not value), len(marked))
        for i, x in enumerate(ordered):
            a = authors[x['author_id']]
            credit = dict(name=clean_name(a), author_id=a['uid'])
            if marked[i] and i < front and front >= 2:
                credit['roles'] = ['co_first']
                credit['note'] = 'Co-first marker recovered from the shared legacy author row under the confirmed PubMan2 convention.'
                report['transformations'].append(dict(kind='co_first_credit', publication_id=p['id'], author_id=a['uid'], position=i + 1, original=name(a)))
            elif marked[i]:
                report['audit_findings'].append(dict(kind='ambiguous_byline_marker', publication_ids=[p['id']], author_ids=[a['uid']], position=i + 1))
                review('marker:' + p['id'] + ':' + a['uid'], 'Review byline marker in ' + p['title'], [target('publication', p['id'])], pending=True)
            p['authors'].append(credit)
        if r['pub_date']:
            if r['year'] and int(r['pub_date'][:4]) != r['year']:
                raise ValueError('Conflicting publication date/year')
            p['publication_date'] = r['pub_date']
        elif r['year']:
            p['publication_date'] = str(r['year'])
        for field in ('volume', 'issue', 'pages'):
            if r[field] is not None and str(r[field]).strip():
                p[field] = str(r[field])
        if r['doi']:
            p['identifiers']['doi'] = re.sub(r'^(?:doi:\s*|https?://(?:dx\.)?doi.org/)', '', r['doi'].strip().lower())
        if r['eprint']:
            p['identifiers']['arxiv'] = re.sub(r'v\d+$', '', re.sub(r'^arxiv:\s*', '', r['eprint'].strip().lower()))
            if p['type'] != 'preprint':
                report['audit_findings'].append(dict(kind='nonpreprint_arxiv_attribution', publication_ids=[p['id']], arxiv=p['identifiers']['arxiv']))
                review('arxiv-attribution:' + p['id'], 'Review arXiv attribution for ' + p['title'], [target('publication', p['id'])], pending=True)
        for field in ('gs_page', 'pdf_url'):
            if r[field]:
                p['urls'].append(r[field])
                if field == 'pdf_url':
                    report['attachments']['source_url_count'] += 1
        if r['id'] in matches:
            p['gscholar_entry_id'] = matches[r['id']]
        state['publications'].append(p)

    captures = []
    for r in sorted(rows['gs_entries'], key=lambda r: r['id']):
        if not r['is_active']:
            raise ValueError('Inactive source entry requires capture-evidence review')
        raw = r['source_payload']
        detail = raw.get('detail', {})
        source_id = review('scholar:' + r['uid'], 'Import Scholar evidence for ' + r['title'],
                           [target('gscholar_entry', r['uid'])],
                           {'source_system': 'PubMan2', 'table': 'mypubs.gs_entries', 'row': r,
                            'snapshot_sha256': snapshot_hash}, provider='google_scholar')
        first, last, fetched = map(timestamp, [r['first_seen_at'], r['last_seen_at'], r['detail_fetched_at']])
        names_value = r['author_names']
        if not isinstance(names_value, list) or any(not isinstance(n, str) or not n.strip() for n in names_value):
            raise ValueError('Malformed source author array')
        truncated = any('...' in n or '…' in n for n in names_value)
        completeness = 'partial' if truncated else 'unknown'
        # No original detail-page HTML remains, so do not manufacture "complete".
        usable_names = [n for n in names_value if n.strip() not in ('...', '…')]
        g = {**base(r['uid']), 'profile_id': profile_id, 'scholar_id': r['citation_id'],
             'title': r['title'], 'authors': usable_names, 'authors_completeness': completeness,
             'matching': {'policy': 'eligible'}, 'first_seen_at': first, 'last_seen_at': last,
             'presence': 'present', 'source_review_id': source_id, 'citation_history': []}
        if r['authors'] and r['authors'].strip():
            g['authors_text'] = r['authors']
        for field in ('venue', 'publication_date', 'volume', 'issue', 'pages', 'publisher',
                      'patent_office', 'application_number', 'description', 'scholar_url', 'cited_by_url'):
            if r[field] is not None and str(r[field]).strip():
                g[field] = str(r[field])
        if r['year'] is not None:
            g['year'] = r['year']
        if detail.get('fetched_at') and 'cited_by_count' in detail:
            if timestamp(detail['fetched_at']) != fetched:
                raise ValueError('Detail timestamp disagrees with source payload')
            g['citation_history'].append(dict(observed_at=fetched, count=known_count(detail['cited_by_count'], detail.get('cited_by_url')), source_review_id=source_id))
        current = dict(observed_at=last, count=known_count(r['cited_by_count'], r['cited_by_url']), source_review_id=source_id)
        if last == fetched and g['citation_history'] and g['citation_history'][0]['count'] != current['count']:
            raise ValueError('Conflicting total observations at the same time')
        if last != fetched or not g['citation_history']:
            g['citation_history'].append(current)
        g['citation_history'].sort(key=lambda s: datetime.fromisoformat(s['observed_at'].replace('Z', '+00:00')))
        if r['citations_by_year']:
            bars = r['citations_by_year']
            if len({b['year'] for b in bars}) != len(bars):
                raise ValueError('Duplicate annual citation year')
            g['annual_citations'] = [dict(observed_at=fetched, counts={str(b['year']): b['count'] for b in bars}, source_review_id=source_id)]
        if r['excluded_from_matching']:
            if r['publication_id'] is not None or not r['exclusion_reason']:
                raise ValueError('Invalid source exclusion')
            g['matching'] = dict(policy='excluded', reason=r['exclusion_reason'], decision_review_id=source_id)
        state['gscholar_entries'].append(g)
        captures.append(dict(captured_at=last, coverage='unknown', source_review_id=source_id, observed_entry_ids=[g['id']]))
    state['gscholar_profile'] = dict(schema_version=2, profile_id=profile_id,
                                     captures=sorted(captures, key=lambda x: datetime.fromisoformat(x['captured_at'].replace('Z', '+00:00'))),
                                     created_at=migration_time, updated_at=migration_time)

    # Bounded bibliographic evidence batches also keep unreferenced identities portable.
    for table, kind in [('authors', 'author'), ('venues', 'venue'), ('publications', 'publication')]:
        ordered = sorted(rows[table], key=lambda r: r['id'])
        for start in range(0, len(ordered), 100):
            batch = ordered[start:start + 100]
            payload = {'source_system': 'PubMan2', 'table': 'mypubs.' + table,
                       'snapshot_sha256': snapshot_hash, 'rows': batch}
            if table == 'publications':
                batch_ids = {r['id'] for r in batch}
                payload['publication_authors'] = sorted([r for r in rows['publication_authors'] if r['publication_id'] in batch_ids], key=lambda r: (r['publication_id'], r['author_order']))
            review(f'{table}:{start}', f'Import PubMan2 {table} batch {start // 100 + 1}',
                   [target(kind, r['uid']) for r in batch], payload)
    review('audit-history', 'Retain PubMan2 historical actions', [],
           {'source_system': 'PubMan2', 'table': 'mypubs.editing_history',
            'snapshot_sha256': snapshot_hash, 'rows': rows['editing_history'],
            'omitted_fields': ['ip_address', 'user_agent', 'account-event details'],
            'note': 'Historical source evidence only; current Git attribution comes from the migration committer.'})
    groups = defaultdict(list)
    for p in state['publications']:
        if p['identifiers'].get('arxiv'):
            groups[p['identifiers']['arxiv']].append(p['id'])
    for arxiv, ids in groups.items():
        if len(ids) > 1:
            report['audit_findings'].append(dict(kind='duplicate_arxiv_id', arxiv=arxiv, publication_ids=ids, blocks_write=False))
            review('duplicate-arxiv:' + arxiv, 'Audit duplicate arXiv identifier ' + arxiv,
                   [target('publication', id) for id in ids], pending=True)
    for g in state['gscholar_entries']:
        p = next((p for p in state['publications'] if p.get('gscholar_entry_id') == g['id']), None)
        if p and g.get('year') and int(p['publication_date'][:4]) != g['year']:
            report['audit_findings'].append(dict(kind='scholar_year_disagreement', publication_ids=[p['id']], entry_ids=[g['id']], publication_date=p['publication_date'], scholar_year=g['year']))
            review('year:' + p['id'], 'Review Scholar year disagreement for ' + p['title'],
                   [target('publication', p['id']), target('gscholar_entry', g['id'])], pending=True)
    report['destination_counts'] = {k: len(state[k]) for k in ('publications', 'authors', 'venues', 'gscholar_entries')}
    report['destination_counts'].update(credits=sum(len(p['authors']) for p in state['publications']),
       confirmed_scholar_links=sum('gscholar_entry_id' in p for p in state['publications']),
       excluded_scholar_entries=sum(g['matching']['policy'] == 'excluded' for g in state['gscholar_entries']),
       citation_samples=sum(len(g['citation_history']) for g in state['gscholar_entries']),
       unknown_current_citations=sum(g['citation_history'][-1]['count'] is None for g in state['gscholar_entries']),
       annual_snapshots=sum(len(g.get('annual_citations', [])) for g in state['gscholar_entries']),
       co_first_credits=sum('co_first' in a.get('roles', []) for p in state['publications'] for a in p['authors']),
       pending_reviews=sum(r['state'] == 'pending' for r in state['reviews']))
    report['policies'] = dict(uuid='Preserved every legacy entity UUID; synthetic library/review UUIDs are deterministic UUIDv5.',
       names='Preserved source components for filing after structural checks; ambiguous surname particles remain unresolved. Historical spellings and lost suffixes are not reconstructed.',
       citations='Google Scholar only; unsupported zeros become null. Detail and last-seen totals retain their original times.',
       completeness='Parsed author arrays retained with unknown completeness unless visibly truncated; no original detail HTML survives.',
       presence='Last-known present; per-entry last-seen observations have unknown profile coverage.',
       source_archive='Complete SQLite archive is retained privately outside the catalog; auth/platform data are not portable publication records.',
       owner='Author/profile association explicitly confirmed by the user during this migration.')
    review('migration-root', 'Migrate PubMan2 publication catalog',
           [target('author', owner_id), {'entity_type': 'library'}, {'entity_type': 'gscholar_profile'}], report)
    reconcile(rows, state)
    report['checks'] = {'uuid_sets_equal': True, 'credit_membership_and_order_equal': True,
                        'scholar_links_equal': True, 'exclusions_equal': True,
                        'snapshot_hash_verified': True}
    # Root evidence contains an independent report value, not a mutable alias.
    state['reviews'][-1]['source_review_id'] = uid('audit-history')
    report['destination_counts']['reviews'] = len(state['reviews'])
    state['reviews'][-1]['evidence']['payload'] = json.loads(json.dumps(report))
    state['reviews'][-1]['evidence']['input_fingerprint'] = digest(report)
    return state, report


def reconcile(rows, state):
    for source, dest in [('authors', 'authors'), ('venues', 'venues'),
                         ('publications', 'publications'), ('gs_entries', 'gscholar_entries')]:
        assert {r['uid'] for r in rows[source]} == {r['id'] for r in state[dest]}, source
    ap = {r['id']: r['uid'] for r in rows['authors']}
    pp = {r['id']: r['uid'] for r in rows['publications']}
    source_links = sorted((pp[r['publication_id']], r['author_order'], ap[r['author_id']]) for r in rows['publication_authors'])
    target_links = sorted((p['id'], i + 1, a['author_id']) for p in state['publications'] for i, a in enumerate(p['authors']))
    assert source_links == target_links
    assert {(pp[r['publication_id']], r['uid']) for r in rows['gs_entries'] if r['publication_id'] is not None} == {(p['id'], p['gscholar_entry_id']) for p in state['publications'] if p.get('gscholar_entry_id')}
    assert {r['uid'] for r in rows['gs_entries'] if r['excluded_from_matching']} == {g['id'] for g in state['gscholar_entries'] if g['matching']['policy'] == 'excluded'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--captured-at', required=True)
    parser.add_argument('--migration-time', required=True)
    parser.add_argument('--owner-id', required=True)
    parser.add_argument('--profile-id', required=True)
    parser.add_argument('--corrections', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    rows = load_snapshot(args.snapshot, args.sha256)
    state, report = convert(rows, args.sha256, args.captured_at, args.migration_time, args.owner_id, args.profile_id, json.loads(args.corrections.read_text()) if args.corrections else None)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    for filename, value in [('catalog_state.json', state), ('reconciliation.json', report)]:
        path = args.output / filename
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        path.chmod(0o600)
    print(json.dumps({'destination_counts': report['destination_counts'],
                      'audit_findings': dict(Counter(x['kind'] for x in report['audit_findings']))}))


if __name__ == '__main__':
    main()
