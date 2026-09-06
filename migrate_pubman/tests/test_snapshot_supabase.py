"""Offline tests for lossless snapshot encodings and SQL identifier handling."""
import importlib.util
from pathlib import Path
import sqlite3
import unittest

path = Path(__file__).resolve().parents[1] / 'scripts' / 'snapshot_supabase.py'
spec = importlib.util.spec_from_file_location('snapshot_supabase', path)
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTests(unittest.TestCase):
    def test_values_round_trip_through_sqlite(self):
        source = [
            ('int8', '9223372036854775807'), ('int8', '-9223372036854775808'),
            ('bool', 'true'), ('bool', 'false'), ('bytea', '\\x0000ff22'),
            ('numeric', '12345678901234567890.0000000000000000001'),
            ('jsonb', 'null'), ('jsonb', '{"count": 12345678901234567890, "text": "王"}'),
            ('text', None), ('text', ''), ('text', 'é\n"quoted"'),
            ('timestamptz', '2026-09-06 08:00:00.123456+00'),
            ('_text', '{"a,b","c"}'), ('float8', 'NaN'),
        ]
        row = tuple(snapshot.convert_value(value, kind) for kind, value in source)
        with sqlite3.connect(':memory:') as db:
            columns = ', '.join(f'c{i} {snapshot.sqlite_type(kind)}' for i,(kind,_) in enumerate(source))
            db.execute(f'CREATE TABLE sample ({columns})')
            db.execute('INSERT INTO sample VALUES (' + ','.join('?' for _ in source) + ')', row)
            fetched = db.execute('SELECT * FROM sample').fetchone()
        self.assertEqual(row, fetched)
        self.assertEqual(snapshot.row_digest(row), snapshot.row_digest(fetched))
        self.assertNotEqual(snapshot.row_digest((None,)), snapshot.row_digest(('null',)))

    def test_hash_preserves_duplicates_but_not_row_order(self):
        a,b = snapshot.row_digest(('a',)), snapshot.row_digest(('b',))
        self.assertEqual(snapshot.multiset_digest([a,b,a]), snapshot.multiset_digest([b,a,a]))
        self.assertNotEqual(snapshot.multiset_digest([a,b]), snapshot.multiset_digest([a,b,a]))

    def test_identifier_is_quoted_not_executable(self):
        name = 'mypubs.odd"; DROP TABLE sentinel; --'
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE sentinel (id INTEGER)')
            db.execute(f'CREATE TABLE {snapshot.qi(name)} (value TEXT)')
            db.execute(f'INSERT INTO {snapshot.qi(name)} VALUES (?)', ('kept',))
            self.assertEqual(db.execute(f'SELECT value FROM {snapshot.qi(name)}').fetchone(), ('kept',))
            self.assertEqual(db.execute('SELECT count(*) FROM sentinel').fetchone(), (0,))

    def test_invalid_binary_or_boolean_fails(self):
        with self.assertRaises(ValueError): snapshot.convert_value('maybe', 'bool')
        with self.assertRaises(ValueError): snapshot.convert_value('escaped', 'bytea')


if __name__ == '__main__':
    unittest.main()
