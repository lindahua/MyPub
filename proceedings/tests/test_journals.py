import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from journals import article, date_value, scan_journal, compare_journal, JOURNALS


def record(**kw):
    return {'DOI':'10.1/example','title':['An Article'],'type':'journal-article','ISSN':['0162-8828'], 'author':[{'given':'Dahua','family':'Lin'}], 'volume':'41','issue':'11', 'published-print':{'date-parts':[[2019,11,1]]},'published-online':{'date-parts':[[2018,9]]}, **kw}

class Fake:
    def __init__(self,pages):
        self.records={r['DOI'].lower():r for page in pages for r in page['items']}
        self.pages=iter(pages)
    def api(self,url):
        if '/works/' in url:return {'message':self.records[url.split('/works/')[1]]},{'url':url}
        if '/works?' not in url:return {'message':{'title':JOURNALS['tpami'][1],'ISSN':['0162-8828']}},{'url':url}
        return {'message':next(self.pages)},{'url':url}

class JournalTests(unittest.TestCase):
    def test_issue_date_not_online_first(self):
        p=article(record());self.assertEqual(p['publication_date'],'2019-11-01');self.assertEqual(p['online_date'],'2018-09')
        p=article(record(**{'journal-issue':{'published-print':{'date-parts':[[2020,1]]}}}));self.assertEqual(p['publication_date'],'2020-01')
        r=record();del r['published-print'];r['published']={'date-parts':[[2018]]};p=article(r);self.assertNotIn('publication_date',p)
        self.assertNotIn('publication_date',article(record(volume='')))

    def test_date_precision_and_invalid_dates(self):
        self.assertEqual(date_value({'date-parts':[[2024]]}),'2024');self.assertEqual(date_value({'date-parts':[[2024,2]]}),'2024-02');self.assertIsNone(date_value({'date-parts':[[2023,2,29]]}))

    def test_full_journal_scan_and_initials(self):
        rows=[record(),record(DOI='10.1/initial',author=[{'given':'D.','family':'Lin'}]),record(DOI='10.1/other',author=[{'given':'Dahua','family':'Linson'}])]
        f=Fake([{'total-results':3,'items':rows[:1],'next-cursor':'next'},{'total-results':3,'items':rows[1:]}]);r=scan_journal(f,'tpami','Dahua Lin')
        self.assertEqual(r['coverage']['indexed_articles'],3);self.assertEqual(len(r['papers']),1);self.assertEqual(len(r['initial_only_candidates']),1);self.assertEqual(r['coverage']['issues'][0]['indexed_articles'],3)

    def test_issue_filter_and_failed_pagination(self):
        rows=[record(),record(DOI='10.1/second',issue='10')]
        r=scan_journal(Fake([{'total-results':2,'items':rows}]),'tpami','Dahua Lin',volume='41',issue='11');self.assertEqual(len(r['papers']),1)
        with self.assertRaises(ValueError):scan_journal(Fake([{'total-results':2,'items':[record()],'next-cursor':'*'}]),'tpami','Dahua Lin')
        with self.assertRaises(ValueError):scan_journal(Fake([{'total-results':2,'items':[]}]),'tpami','Dahua Lin')

    def test_journal_identity_and_article_type(self):
        for r in [record(ISSN=['0000-0000']),record(type='proceedings-article')]:
            with self.assertRaises(ValueError):scan_journal(Fake([{'total-results':1,'items':[r]}]),'tpami','Dahua Lin')

    def test_conference_is_other_version_not_journal(self):
        p=article(record());pub={'id':'p','_path':'/p','title':p['title'],'type':'conference','venue':{'venue_id':'tog'},'authors':[{'name':'Dahua Lin'}],'identifiers':{},'extra_urls':[]}
        results,_=compare_journal([p],[pub],'tog','Dahua Lin');self.assertEqual(results[0]['status'],'other_version_only')
        pub['type']='journal';results,_=compare_journal([p],[pub],'tog','Dahua Lin');self.assertEqual(results[0]['status'],'journal_record_found')
        self.assertIn('publication_date',results[0]['differences'][0]['fields'])
