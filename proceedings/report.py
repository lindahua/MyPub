"""Human-readable companions to machine-readable proceedings audit results."""


def write_report(result, path):
    venue = result["venue"]
    name = venue.get("preferred_name", venue.get("name", venue["venue_key"]))
    lines = [
        f'# {name}: {result["author"]}',
        "",
        f'Captured report: {result["generated_at"]}. Catalog was not modified.',
        "",
        "Scope is the editions and tracks listed below. Absence outside this coverage is not evidence that a publication does not exist. Author matching uses the credited full name; initials and homonyms require separate review.",
        "",
        f'Extracted papers: **{len(result["papers"])}**.',
        "",
        *[f"- {key}: {value}" for key, value in result["counts"].items()],
        "",
        "A source paper can match an existing preprint without having a conference record. “not_found” means no exact title/URL/DOI match; title-variant suggestions remain unconfirmed. A catalog-only entry may be a duplicate, title variant, workshop, source omission, or outside scanned years.",
        "",
        "## Coverage",
        "",
        "| Edition | Indexed entries | Your papers | Source |",
        "| --- | ---: | ---: | --- |",
    ]
    for scope in result["coverage"]:
        source = scope["sources"][0]["url"]
        lines.append(
            f'| {scope.get("year", scope.get("method", "unknown"))} {scope.get("track", "")} | {scope.get("indexed_papers", scope.get("search_results_scanned", "?"))} | {scope["author_papers"]} | [index]({source}) |'
        )
        if scope.get("limitation"):
            lines += ["", "**Metadata coverage:** " + scope["limitation"], "",
                      "Requested editions: " + ", ".join(map(str, scope["requested_years"])), ""]
        elif scope.get("direct_proceedings_verified") is False:
            lines += [
                "",
                "**ACM limitation:** direct proceedings access was blocked. Results use publisher-deposited Crossref metadata. The author query was paginated to completion; publisher deposit gaps remain possible. SIGGRAPH Asia and poster records are labeled separately. Transactions on Graphics papers are candidates only, not automatically assigned to SIGGRAPH.",
                "",
            ]
    if result["errors"]:
        lines += [
            "",
            "### Coverage gaps",
            "",
            *["- " + error for error in result["errors"]],
        ]
    for status in [
        "not_found",
        "other_version_only",
        "multiple_conference_records",
        "conference_record_found",
    ]:
        rows = [r for r in result["comparison"] if r["status"] == status]
        if not rows:
            continue
        lines += ["", "## " + status, ""]
        for r in rows:
            p = r["paper"]
            lines += [f'### {p["year"]}: [{p["title"]}]({p["official_url"]})', ""]
            if p.get("track"):
                lines.append("Track: " + p["track"])
            for m in r["matches"]:
                lines.append(
                    f'- Catalog: [{m["title"]}]({m["path"]}) ({m["type"]}; {m["evidence"]})'
                )
            for candidate in r["possible_title_variants"]:
                lines.append("- Possible title variant: " + candidate["title"])
            for diff in r["differences"]:
                lines.append(
                    f'- Metadata fields to review ({diff["publication_id"]}): '
                    + ", ".join(diff["fields"])
                )
                for field in ["title", "authors", "year", "pages"]:
                    if field in diff["fields"]:
                        value = diff["fields"][field]
                        lines.append(
                            f'  - {field}: catalog `{value["catalog"]}`; source `{value["proceedings"]}`'
                        )
            if p.get("author_parse_warning"):
                lines.append("- " + p["author_parse_warning"])
            lines.append("")
    if result["catalog_only"]:
        lines += ["", "## Catalog entries not matched", ""]
        for p in result["catalog_only"]:
            lines.append(
                f'- {p.get("publication_date", "unknown date")}: [{p["title"]}]({p["_path"]})'
            )
            for candidate in p.get("possible_source_title_variants", []):
                lines.append(
                    f'  - Possible source title variant / duplicate: [{candidate["title"]}]({candidate["url"]})'
                )
    for scope in result["coverage"]:
        if scope.get("initial_only_candidates"):
            lines += ["", "## Initial-only author candidates (not counted)", ""]
            lines += [f'- {p["year"]}: [{p["title"]}]({p["official_url"]}) — {", ".join(p["authors"])}' for p in scope["initial_only_candidates"]]
        if scope.get("related_journal_candidates"):
            lines += ["", "## TOG papers requiring event verification", ""]
            lines += [
                f'- {p["year"]}: [{p["title"]}]({p["official_url"]})'
                for p in scope["related_journal_candidates"]
            ]
    if not result["comparison"]:
        lines += ["", "## Extracted papers", ""]
        lines += [
            f'- {p["year"]}: [{p["title"]}]({p["official_url"]})'
            for p in result["papers"]
        ]
    path.write_text("\n".join(lines) + "\n")
