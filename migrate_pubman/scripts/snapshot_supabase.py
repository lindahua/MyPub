#!/usr/bin/env python3
"""Copy stored PostgreSQL data to SQLite for the one-time PubMan2 migration.

Reads PostgreSQL only. Does not execute views, triggers, or application routines.
No credential or row values are printed. Output contains sensitive original data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid
from datetime import datetime, timezone

import psycopg
from psycopg import sql
from dotenv import dotenv_values


USER_SCHEMA = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'"


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def connect(env_file):
    url = dotenv_values(env_file).get('SUPABASE_DATABASE_URL')
    if not url:
        raise RuntimeError('SUPABASE_DATABASE_URL is not configured')
    return psycopg.connect(
        url, connect_timeout=15, prepare_threshold=None,
        options='-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000',
    )


def begin_read_only(conn):
    conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    # Fail rather than silently export an RLS-filtered subset. This does not grant privileges.
    conn.execute('SET LOCAL row_security = off')
    conn.execute("SET LOCAL timezone = 'UTC'")
    conn.execute("SET LOCAL datestyle = 'ISO, YMD'")
    conn.execute("SET LOCAL intervalstyle = 'iso_8601'")
    conn.execute("SET LOCAL bytea_output = 'hex'")
    state = conn.execute("SELECT current_setting('transaction_read_only'), current_setting('transaction_isolation')").fetchone()
    if tuple(state) != ('on', 'repeatable read'):
        raise RuntimeError('Source transaction protection not established')


def inventory(conn):
    rows = conn.execute(f"""
        SELECT n.nspname, c.relname, c.relkind,
               has_table_privilege(c.oid, 'SELECT'), c.relrowsecurity,
               c.relispartition, c.oid
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE (({USER_SCHEMA}) OR
               (n.nspname = 'pg_catalog' AND c.relname IN ('pg_largeobject', 'pg_largeobject_metadata')))
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ORDER BY n.nspname, c.relname
    """).fetchall()
    return [dict(zip(('schema', 'name', 'kind', 'selectable', 'row_security', 'partition', 'oid'), row)) for row in rows]


def records(conn, query, params=()):
    cur = conn.execute(query, params)
    keys = [c.name for c in cur.description]
    return [dict(zip(keys, row)) for row in cur.fetchall()]


def schema_metadata(conn):
    """Archive definitions as data; PostgreSQL behavior is not translated to SQLite."""
    return {
        'schemas': records(conn, f"SELECT n.nspname AS name FROM pg_namespace n WHERE {USER_SCHEMA} ORDER BY 1"),
        'constraints': records(conn, f"""SELECT n.nspname AS schema, c.relname AS table_name,
            k.conname AS name, k.contype AS kind, pg_get_constraintdef(k.oid, true) AS definition
            FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE {USER_SCHEMA} ORDER BY 1,2,3"""),
        'indexes': records(conn, """SELECT schemaname AS schema, tablename AS table_name, indexname AS name, indexdef AS definition
            FROM pg_indexes WHERE schemaname <> 'information_schema' AND schemaname !~ '^pg_' ORDER BY 1,2,3"""),
        'views': records(conn, f"""SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
            pg_get_viewdef(c.oid, true) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE ({USER_SCHEMA}) AND c.relkind IN ('v','m') ORDER BY 1,2"""),
        'triggers': records(conn, f"""SELECT n.nspname AS schema, c.relname AS table_name, t.tgname AS name,
            pg_get_triggerdef(t.oid, true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ({USER_SCHEMA}) AND NOT t.tgisinternal ORDER BY 1,2,3"""),
        'routines': records(conn, f"""SELECT n.nspname AS schema, p.proname AS name,
            pg_get_function_identity_arguments(p.oid) AS arguments, pg_get_functiondef(p.oid) AS definition
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE ({USER_SCHEMA}) AND p.prokind IN ('f','p') ORDER BY 1,2,3"""),
        'policies': records(conn, """SELECT schemaname AS schema, tablename AS table_name, policyname AS name,
            permissive, roles::text, cmd, qual, with_check FROM pg_policies
            WHERE schemaname <> 'information_schema' AND schemaname !~ '^pg_' ORDER BY 1,2,3"""),
        'sequences': records(conn, """SELECT schemaname AS schema, sequencename AS name, data_type::text,
            start_value::text, min_value::text, max_value::text, increment_by::text, cycle,
            cache_size::text, last_value::text FROM pg_sequences
            WHERE schemaname <> 'information_schema' AND schemaname !~ '^pg_' ORDER BY 1,2"""),
        'extensions': records(conn, 'SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY 1'),
        'inheritance': records(conn, f"""SELECT n.nspname AS schema, c.relname AS child,
            pn.nspname AS parent_schema, pc.relname AS parent,
            pg_get_expr(c.relpartbound, c.oid) AS partition_bound
            FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_class pc ON pc.oid=i.inhparent JOIN pg_namespace pn ON pn.oid=pc.relnamespace
            WHERE {USER_SCHEMA} ORDER BY 1,2,3,4"""),
    }


def columns_for(conn, relation):
    return records(conn, """SELECT a.attname AS name, a.attnum AS position,
        t.typname AS type_name, format_type(a.atttypid,a.atttypmod) AS pg_type,
        a.attnotnull AS not_null, a.attidentity AS identity, a.attgenerated AS generated,
        pg_get_expr(d.adbin,d.adrelid) AS default_expression
        FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=%s AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum""", (relation['oid'],))


def sqlite_type(pg_type):
    if pg_type in ('int2', 'int4', 'int8', 'bool'):
        return 'INTEGER'
    return 'BLOB' if pg_type == 'bytea' else 'TEXT'


def convert_value(value, pg_type):
    if value is None:
        return None
    if pg_type in ('int2', 'int4', 'int8'):
        return int(value)
    if pg_type == 'bool':
        if value not in ('true', 'false', 't', 'f'):
            raise ValueError('Unexpected boolean representation')
        return int(value in ('true', 't'))
    if pg_type == 'bytea':
        if not value.startswith('\\x'):
            raise ValueError('Expected hexadecimal bytea')
        return bytes.fromhex(value[2:])
    # PostgreSQL text output preserves decimal precision, JSON null, arrays, and special floats.
    return value


def qi(name):
    return '"' + name.replace('"', '""') + '"'


def row_digest(row):
    normalized = [{'bytes_hex': v.hex()} if isinstance(v, bytes) else v for v in row]
    return hashlib.sha256(json_text(normalized).encode('utf-8')).digest()


def multiset_digest(row_hashes):
    return hashlib.sha256(b''.join(sorted(row_hashes))).hexdigest()


def copy_table(conn, dest, relation):
    columns = columns_for(conn, relation)
    if not columns:
        raise RuntimeError('Zero-column tables require an explicit snapshot encoding')
    target = relation['schema'] + '.' + relation['name']
    definitions = ', '.join(qi(c['name']) + ' ' + sqlite_type(c['type_name']) for c in columns)
    dest.execute(f'CREATE TABLE {qi(target)} ({definitions})')
    names = ', '.join(qi(c['name']) for c in columns)
    insert = f'INSERT INTO {qi(target)} ({names}) VALUES ({",".join("?" for _ in columns)})'
    source = sql.Identifier(relation['schema'], relation['name'])
    # ONLY avoids duplicating inherited/partition rows. Each physical child is inventoried separately.
    only = sql.SQL('') if relation['kind'] == 'm' else sql.SQL('ONLY ')
    count = conn.execute(sql.SQL('SELECT count(*) FROM {}{}').format(only, source)).fetchone()[0]
    select = sql.SQL('SELECT {} FROM {}{}').format(
        sql.SQL(', ').join(sql.SQL('{}::text').format(sql.Identifier(c['name'])) for c in columns), only, source)
    hashes = []
    with conn.cursor(name='snapshot_' + uuid.uuid4().hex) as cur:
        cur.execute(select)
        while rows := cur.fetchmany(1000):
            converted = [tuple(convert_value(v, c['type_name']) for v,c in zip(row, columns)) for row in rows]
            dest.executemany(insert, converted)
            hashes.extend(row_digest(row) for row in converted)
    if len(hashes) != count:
        raise RuntimeError('Source count and streamed row count differ')
    readback = dest.execute(f'SELECT {names} FROM {qi(target)}')
    local_hashes = [row_digest(tuple(row)) for row in readback]
    source_hash = multiset_digest(hashes)
    if len(local_hashes) != count or multiset_digest(local_hashes) != source_hash:
        raise RuntimeError('SQLite readback differs from the source stream')
    # Convenience views retain qualified tables as the canonical raw snapshot.
    if relation['schema'] == 'mypubs':
        dest.execute(f'CREATE VIEW {qi(relation["name"])} AS SELECT * FROM {qi(target)}')
    return {**relation, 'sqlite_table': target, 'columns': columns,
            'row_count': count, 'content_sha256': source_hash, 'verified': True}


def file_hash(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def export_snapshot(conn, output):
    output = output.resolve()
    manifest_path = output.with_suffix('.manifest.json')
    if not output.parent.is_dir():
        raise RuntimeError('Workspace must already exist')
    if output.exists() or manifest_path.exists():
        raise FileExistsError('Refusing to overwrite an existing snapshot')
    # Full database copies can include account hashes and auth/session records.
    os.chmod(output.parent, 0o700)
    os.umask(0o077)
    temporary = output.parent / (output.name + '.partial-' + uuid.uuid4().hex)
    temporary_manifest = temporary.with_suffix('.manifest.json')
    relations = inventory(conn)
    tables = [r for r in relations if r['kind'] in ('r','p','m','f')]
    if any(not r['selectable'] for r in tables):
        raise PermissionError('Cannot copy all stored tables with this connection')
    if any(r['kind'] == 'f' for r in tables):
        raise RuntimeError('Foreign tables cannot be guaranteed by the local MVCC snapshot')
    manifest = {
        'format': 'pubman-postgresql-sqlite-snapshot-v1',
        'started_at': datetime.now(timezone.utc).isoformat(),
        'source': {'application': 'PubMan2', 'database_system': 'PostgreSQL',
                   'server_version': conn.info.server_version,
                   'transaction_read_only': True, 'transaction_isolation': 'repeatable read',
                   'row_security': 'off (fail on filtered access)',
                   'snapshot': conn.execute('SELECT pg_current_snapshot()::text').fetchone()[0]},
        'scope': 'All stored tables/materialized views in non-system schemas, plus PostgreSQL large-object data and metadata; physical rows copied once.',
        'limitations': [
            'SQLite is a data snapshot, not an executable PostgreSQL/Supabase replacement or native disaster-recovery backup.',
            'PostgreSQL constraints, indexes, routines, policies, views, sequences, and partition definitions are metadata, not SQLite behavior.',
            'Views are not evaluated (including vault.decrypted_secrets).',
            'Supabase Storage object bytes are external to the database and are not downloaded.',
            'PostgreSQL system catalogs, server roles, replication state, and managed platform configuration are not cloned.',
            'Sequence values are metadata reads; sequence state is not MVCC transactional.',
        ],
        'encodings': {'int2/int4/int8': 'SQLite INTEGER', 'bool': 'INTEGER 0/1', 'bytea': 'BLOB',
                      'other_types': 'PostgreSQL text representation in SQLite TEXT', 'SQL_NULL': 'SQLite NULL'},
        'relations': relations,
        'schema_metadata': schema_metadata(conn),
        'tables': [],
    }
    try:
        with sqlite3.connect(temporary) as dest:
            dest.execute('PRAGMA journal_mode=DELETE')
            dest.execute('PRAGMA synchronous=FULL')
            dest.execute('BEGIN')
            for relation in tables:
                detail = copy_table(conn, dest, relation)
                manifest['tables'].append(detail)
                print(json.dumps({'copied': detail['sqlite_table'], 'rows': detail['row_count'], 'verified': True}), flush=True)
            manifest['completed_at'] = datetime.now(timezone.utc).isoformat()
            manifest['total_rows'] = sum(t['row_count'] for t in manifest['tables'])
            manifest['table_count'] = len(tables)
            manifest['complete'] = True
            dest.execute('CREATE TABLE __pubman_snapshot_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            dest.execute('INSERT INTO __pubman_snapshot_metadata VALUES (?,?)', ('manifest', json_text(manifest)))
            dest.commit()
            result = dest.execute('PRAGMA integrity_check').fetchall()
            if result != [('ok',)]:
                raise RuntimeError('SQLite integrity check failed')
        # Reopen after committing and verify every table again, independently of the write connection.
        with sqlite3.connect(f'file:{temporary}?mode=ro', uri=True) as verify:
            for table in manifest['tables']:
                cols = ', '.join(qi(c['name']) for c in table['columns'])
                hashes = [row_digest(tuple(row)) for row in verify.execute(f'SELECT {cols} FROM {qi(table["sqlite_table"])}')]
                if len(hashes) != table['row_count'] or multiset_digest(hashes) != table['content_sha256']:
                    raise RuntimeError('Post-commit verification failed')
        manifest['sqlite_sha256'] = file_hash(temporary)
        temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        os.chmod(temporary, 0o600)
        os.chmod(temporary_manifest, 0o600)
        # Hard links publish without overwriting an existing target, even in a race.
        os.link(temporary, output)
        os.link(temporary_manifest, manifest_path)
        print(json.dumps({'snapshot': str(output), 'manifest': str(manifest_path),
                          'tables': manifest['table_count'], 'rows': manifest['total_rows'],
                          'sqlite_integrity': 'ok', 'all_table_hashes_verified': True}), flush=True)
    finally:
        temporary.unlink(missing_ok=True)
        temporary_manifest.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        with connect(args.env_file) as conn:
            begin_read_only(conn)
            if args.inspect:
                print(json.dumps({'transaction': ['on', 'repeatable read'], 'relations': inventory(conn)}, indent=2))
            else:
                export_snapshot(conn, args.output)
    except Exception as exc:
        # Errors can include hosts, credentials, query text, or stored data values.
        print(json.dumps({'error_type': type(exc).__name__, 'sqlstate': getattr(exc, 'sqlstate', None),
                          'message': 'Snapshot operation failed; sensitive error details suppressed.'}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
