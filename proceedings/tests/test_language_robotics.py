import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_scan import Fake
from language_robotics import scan_anthology, scan_rss
from historical import edition

class NewVenueTests(unittest.TestCase):
    def test_anthology_scope_and_exact_byline(self):
        root='https://aclanthology.org/venues/acl/'
        findings='https://aclanthology.org/venues/findings/'
        vol='https://aclanthology.org/volumes/2020.acl-main/'
        f=Fake({root: '<a href="/volumes/2020.acl-main/">Main</a><a href="/volumes/2019.acl-main/">Old</a><a href="/volumes/2020.acl-srw/">Workshop</a>',findings:'',vol: '<span class="d-block"><strong><a href="/2020.acl-main.0/">Editors</a></strong></span><span class="d-block"><strong><a href="/2020.acl-main.1/">Paper</a></strong><a href="/people/dahua-lin/">Dahua Lin</a></span><span class="d-block"><strong><a href="/2020.acl-main.2/">Other</a></strong><a href="/people/other/">Dahua Linson</a></span>', 'https://aclanthology.org/2020.acl-main.1/':'<meta name="citation_title" content="Paper"><meta name="citation_author" content="Dahua Lin">'})
        p,c,e=scan_anthology(f,root,'Dahua Lin','acl')
        self.assertFalse(e);self.assertEqual(len(p),1);self.assertEqual(c[0]['indexed_papers'],2);self.assertEqual(p[0]['track'],'main')
        f.pages['https://aclanthology.org/2020.acl-main.1/']='<meta name="citation_title" content="Paper"><meta name="citation_author" content="Someone Else">'
        p,c,e=scan_anthology(f,root,'Dahua Lin','acl');self.assertFalse(p);self.assertTrue(e)

    def test_findings_is_not_main_conference(self):
        root='https://aclanthology.org/venues/acl/'
        findings='https://aclanthology.org/venues/findings/'
        volume='https://aclanthology.org/volumes/2024.findings-acl/'
        f=Fake({root:'<a href="/volumes/2024.findings-acl/">Findings</a>',findings:'<a href="/volumes/2024.findings-acl/">Findings of ACL</a>',volume:'<span class="d-block"><strong><a href="/2024.findings-acl.1/">Paper</a></strong><a href="/people/dahua-lin/">Dahua Lin</a></span>','https://aclanthology.org/2024.findings-acl.1/':'<meta name="citation_title" content="Paper"><meta name="citation_author" content="Dahua Lin">'})
        with self.assertRaisesRegex(ValueError,'No eligible'):
            scan_anthology(f,root,'Dahua Lin','acl')
        p,c,e=scan_anthology(f,findings,'Dahua Lin','acl',findings_only=True)
        self.assertFalse(e);self.assertEqual(len(p),1);self.assertEqual(p[0]['track'],'findings')

    def test_rss_editions_and_full_name(self):
        root='https://www.roboticsproceedings.org/'
        vol=root+'rss16/index.html'
        f=Fake({root:'<a href="rss2005/index.html">2005</a><a href="rss15/index.html">2019</a><a href="rss16/index.html">2020</a>',vol:'<table><tr><td><a href="p001.html">Paper</a><i>Dahua Lin, Other Author</i></td></tr><tr><td><a href="p002.html">No</a><i>Dahua Linson</i></td></tr></table>',root+'rss16/p001.html':'<meta name="citation_title" content="Paper"><meta name="citation_author" content="Dahua Lin"><meta name="citation_author" content="Other Author">'})
        p,c,e=scan_rss(f,root,'Dahua Lin');self.assertFalse(e);self.assertEqual(len(p),1);self.assertEqual(c[0]['year'],2020)

    def test_ieee_robotics_excludes_journals_and_workshops(self):
        for key,name in [('icra','Robotics and Automation'),('iros','Intelligent Robots and Systems')]:
            r={'type':'proceedings-article','container-title':['2024 IEEE International Conference on '+name]}
            self.assertEqual(edition(r,key),2024)
            r['type']='journal-article';self.assertIsNone(edition(r,key))
            r['type']='proceedings-article';r['container-title'][0]+=' Workshops';self.assertIsNone(edition(r,key))
