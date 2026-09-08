# Proceedings author search and catalog comparison

Read-only parsers for CVPR, ICCV, ECCV, NeurIPS, ICML, ICLR, AAAI, IJCAI,
SIGGRAPH, ACM Multimedia, and CoRL. Search by an exact credited full name;
case and whitespace are normalized. Initial-only names are not silently linked.

## Run

Requires Python 3.10+, `curl`, and Beautiful Soup:

```sh
python3 -m pip install -r proceedings/requirements.txt
python3 proceedings/scan.py --author "Dahua Lin" \
  --conferences cvpr iccv eccv neurips icml iclr aaai ijcai siggraph acm_mm corl \
  --output local/proceedings-search
```

Add `--catalog /path/to/MyPubRepo` to compare against an existing MyPub catalog.
The catalog is never modified. Output must be outside the catalog. Conference
source links come from its venue identities when supplied; otherwise the scanner
uses `sources.json`. The `--root` and `--venues` aliases remain available.

Each conference produces a JSON result and a Markdown report. JSON includes
extracted metadata, source provenance, scanned editions/tracks, coverage errors,
and optional catalog matches and discrepancies. Raw HTTP responses are cached by
URL with capture timestamps and SHA-256 hashes. `--offline` requires this cache;
use a new output directory to refresh the sources. An incomplete edition scan
causes exit status 1 even when other editions succeeded. Inspect `coverage` and
`errors` before interpreting missing records.

## Source support and limits

| Conference | Source and supported discovery |
| --- | --- |
| CVPR / ICCV | CVF menu and yearly indexes; old hidden-author inputs, day indexes, and all-paper indexes. Index and detail bylines are checked. CVF starts in 2013. |
| ECCV | ECVA archive, currently 2018–2024. Supports surname-first 2018 bylines and later full-name lists. Malformed source delimiters are flagged, not treated as authoritative author order. |
| NeurIPS | Proceedings archive, currently 1987–2025. Scans all discovered volumes/tracks; excludes workshop sites. |
| ICML / CoRL | PMLR main-conference volumes, currently ICML 2013–2025 and CoRL 2017–2025. Colocated workshops such as TerraBytes/GRaM are excluded. Edition year is distinct from volume publication date. |
| ICLR | Published proceedings for 2024–2026, accepted-paper programs for earlier years. Programs are currently available for 2020–2023; older missing endpoints are reported. Unaccepted submissions are excluded. |
| AAAI | Paginated OJS archives and issue tables of contents. Special tracks are retained with their issue labels. Coverage is limited to the OJS archive; legacy proceedings may require a separate source. |
| IJCAI | Structured annual proceedings, currently 2017–2025. Older image/PDF indexes are reported as unsupported, not as empty editions. |
| SIGGRAPH / ACM MM | Direct ACM access was blocked during implementation. The fallback exhausts an ACM publisher-deposited Crossref author query, then filters exact author names and conference containers. This is explicitly labeled metadata coverage, not a verified ACM table-of-contents scan. SIGGRAPH Asia and posters are labeled; TOG journal papers require event verification and are not automatically counted as SIGGRAPH papers. |

Dates above describe the verified snapshot, not hard-coded upper bounds except
for the legacy ICLR program fallback. Published ICLR editions are discovered
from the archive. `sources.json` records the starting locations.

## Comparison semantics

Matches use explicit source URLs, DOI, or normalized titles. Preprints and other
venues do not count as conference records. Fuzzy titles and shortened-prefix
matches are suggestions only. The report also identifies possible variants of
catalog-only records, which can reveal duplicates. Archived records are excluded
from the general comparison. Names matched by text are not new author identity
links.

Compared fields include title, ordered byline, event-year fallback, page range,
DOI, official-page/PDF links, and abstract when the source supplies them. A URL
or abstract difference is a review item, not proof that the catalog value is
wrong. In particular, a CoRL edition year can differ from its publication year.
Unknown values are not invented. The scripts neither download managed
attachments nor create or update catalog records.

## CVPR and older IEEE support

The original CVPR-specific entry point remains available:

```sh
python3 proceedings/cvpr.py --root /path/to/MyPubRepo \
  --output local/cvpr-comparison --author "Dahua Lin"
```

For older IEEE editions, open the venue's IEEE series page, select the edition,
and click **Load All**. Run `ieee_browser.js` in the browser console, changing the
final call's author and optional initial-only candidate list as needed. Save the
returned objects in a JSON array and supply `--ieee-snapshots FILE` to `cvpr.py`.
The browser extractor verifies that the displayed total equals the loaded row
count. IEEE byline order is deliberately not treated as authoritative.

`scripts/cvpr_proceedings.py` is a compatibility wrapper for earlier commands.

## Tests and saved results

```sh
python3 -B -m unittest discover -s proceedings/tests
node --check proceedings/ieee_browser.js
```

Tests cover old/new CVF markup, day pagination, exact-name filtering, byline
verification, corrupted cache detection, ECVA name ordering, PMLR workshop
exclusion, ICLR acceptance and pagination checks, AAAI pagination, ACM container
classification, and conservative matching.
The `results/` directory contains public bibliographic extraction snapshots;
local catalog comparisons and raw caches belong under the gitignored `local/`
directory. No private catalog UUIDs or local paths are included in public results.
