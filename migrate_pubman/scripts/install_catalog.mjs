#!/usr/bin/env node
/** One-time migration installer. All production records remain outside the app. */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, chmod, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Catalog } from '../../dist/core/catalog.js';
import { catalogFiles } from '../../dist/core/paths.js';
import { writeState } from '../../dist/core/storage.js';
import { validateState, auditState } from '../../dist/core/validation.js';
import { fingerprint, atomicWriteJson, withLock, sha256 } from '../../dist/core/utils.js';
import { nativeExport, importNative } from '../../dist/core/native.js';
import { decideReview } from '../../dist/core/reviews.js';
import { initializeGit } from '../../dist/core/sync.js';
import { rebuildSearchIndex } from '../../dist/adapters/search.js';
import { toBibtex, toCsv } from '../../dist/core/exports.js';
import { backup, restore } from '../../dist/core/backup.js';
import { run } from '../../dist/adapters/process.js';

process.umask(0o077);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [command, buildArg, targetArg] = process.argv.slice(2);
if (!['prepare', 'activate'].includes(command) || !buildArg || !targetArg) throw new Error('Usage: install_catalog.mjs prepare|activate BUILD_DIR TARGET_DIR');
const build = resolve(buildArg), target = resolve(targetArg), stage = join(build, 'repository');
const state = JSON.parse(await readFile(join(build, 'catalog_state.json'), 'utf8'));
const report = JSON.parse(await readFile(join(build, 'reconciliation.json'), 'utf8'));

function assertCatalog(actual, expected, imported = false) {
  for (const kind of ['authors', 'venues', 'publications', 'gscholar_entries', 'reviews']) {
    const byId = new Map(actual[kind].map(r => [r.id, r]));
    assert.equal(byId.size, expected[kind].length + (imported && kind === 'reviews' ? 1 : 0), kind);
    for (const row of expected[kind]) assert.equal(fingerprint(byId.get(row.id)), fingerprint(row), `${kind} record ${row.id}`);
  }
  assert.deepEqual(actual.owner, expected.owner);
  assert.deepEqual(actual.gscholar_profile, expected.gscholar_profile);
  if (!imported) assert.deepEqual(actual.library, expected.library);
}
async function requireEmpty(path) {
  try { assert.equal((await readdir(path)).length, 0, `Destination must be empty: ${path}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function readme(importPath) {
  return `# MyPub publication repository\n\nThis is the long-term data repository for Dahua Lin's publications. The MyPub application code is maintained separately. Catalog schema: **2**.\n\n## Contents\n\n- \`catalog/publications/<year>/\`: ${state.publications.length} curated publications, with printed author credits and optional dates.\n- \`catalog/authors/<surname-initial>/\`: ${state.authors.length} shared author identities.\n- \`catalog/venues/\`: ${state.venues.length} venue identities.\n- \`catalog/gscholar/\`: the selected Scholar profile and ${state.gscholar_entries.length} entries, including retained exclusions and dated citation observations.\n- \`catalog/reviews/\`: immutable import evidence and subsequent review decisions.\n- \`attachments/\`: managed files using Git LFS, added when available. This initial migration has no attachment files.\n- \`local/\`: ignored indexes, exports, operational state, and local reports; these are rebuildable and not authoritative.\n\nFiles use readable snake-case names plus UUID prefixes. Publications and Scholar entries are filed by their own years; authors use surname-first filenames. Full UUIDs in JSON are the identities; filenames can change. Unknown dates/surnames use \`unknown_year\` and \`unknown_surname\`.\n\n## Use\n\nInstall the separate MyPub application (Node.js 22+, Git, Git LFS), then run from this directory or pass \`--root PATH\`:\n\n\`\`\`sh\nmypub list\nmypub search "paper title"\nmypub show PUBLICATION_KEY --json\nmypub review list --state pending\nmypub validate\nmypub audit\nmypub index rebuild\nmypub history RECORD_UUID\nmypub export --format bibtex --output local/exports/publications.bib\nmypub backup /path/to/independent-backup\n\`\`\`\n\nScholar is the only citation source. Missing counts are null, not zero; current counts use the latest observation. Metadata-only changes do not create citation observations. The mirror retains the original source observation times and unknown profile coverage. \`gscholar import\` accepts new explicit CSV/JSON captures. Matching and exclusions are explicit decisions.\n\nPublication authors and the configured bibliographic owner are separate from Git users. Commit attribution comes from the actual Git committer. Run \`git status\` to see uncommitted work; \`mypub sync\` commits managed changes and synchronizes once a remote/upstream is configured.\n\n## Git and backups\n\nThis is an ordinary local Git repository on \`main\`, with Git LFS configured for future attachments. No remote is configured or data published by this migration. Add a **private** Git/LFS remote when desired; never commit credentials, caches, or the full legacy SQLite database. Keep an independent backup outside this repository and copy it to durable/off-device storage. Native JSON exports preserve record/evidence content but do not contain Git history or attachment bytes.\n\n## Initial import\n\nMigrated ${report.migration_time} from the read-only PubMan2 snapshot captured ${report.snapshot_captured_at}. All legacy entity UUIDs and ${report.destination_counts.credits} ordered authorship links were preserved, along with ${report.destination_counts.confirmed_scholar_links} Scholar associations and ${report.destination_counts.excluded_scholar_entries} exclusions. Two leading byline markers were recovered as co-first roles. Luc Van Gool's given/family split was explicitly corrected to Luc / Van Gool.\n\nThe [migration evidence](${importPath}) records source hashes, field policies, counts, and known exceptions. Original source rows and historical actions are retained in reviews; authentication/operational data stay solely in the protected external snapshot. There are ${report.destination_counts.pending_reviews} initial review items, including three duplicate arXiv groups. Duplicate arXiv IDs are retained and reported by \`audit\`; they do not make the catalog structurally invalid. Same-name identities are not automatically merged. All ${report.destination_counts.unknown_current_citations} unsupported zero totals are represented as null with the source values retained.\n\nUse ordinary MyPub editing and review operations from now on. Never rerun the one-time converter over this repository after new edits.\n`;
}

if (command === 'prepare') {
  const validation = validateState(state);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  assert.equal(report.attachments.source_url_count, 0, 'Attachment acquisition needs resolution');
  await requireEmpty(stage); await requireEmpty(target);
  await mkdir(stage, {recursive: true, mode: 0o700}); await chmod(stage, 0o700);
  const catalog = new Catalog({root: stage});
  await withLock(join(stage, 'local/write.lock'), () => writeState(stage, new Map(), state));
  await mkdir(join(stage, 'attachments'), {recursive: true});
  await writeFile(join(stage, '.gitignore'), 'local/\n.DS_Store\n.env\n.env.*\n*.sqlite\n*.sqlite-*\n');
  await writeFile(join(stage, '.gitattributes'), 'catalog/** text eol=lf\n*.md text eol=lf\nattachments/** filter=lfs diff=lfs merge=lfs -text\n');
  const importRecord = state.reviews.find(r => r.summary === 'Migrate PubMan2 publication catalog');
  const importPath = [...catalogFiles(state)].find(([, r]) => r.id === importRecord.id)[0];
  await writeFile(join(stage, 'README.md'), readme(importPath));
  assertCatalog(await catalog.read(), state);
  assert.equal((await catalog.validate(true)).valid, true);
  assert.equal((await rebuildSearchIndex(catalog)).indexed, state.publications.length);
  await mkdir(join(stage, 'local/exports'), {recursive: true});
  await writeFile(join(stage, 'local/exports/publications.bib'), toBibtex(state.publications));
  await writeFile(join(stage, 'local/exports/publications.csv'), toCsv(state.publications));
  const envelope = nativeExport(await catalog.read(), state.publications.map(p => p.id));
  assert.equal(envelope.reviews.length, state.reviews.length, 'Native closure must retain historical evidence too');
  const roundtripRoot = join(build, 'native-roundtrip'); await requireEmpty(roundtripRoot);
  const roundtrip = new Catalog({root: roundtripRoot}); await roundtrip.initialize('Native round-trip verification');
  const proposed = await importNative(roundtrip, envelope); await decideReview(roundtrip, proposed.source_review_id, 'accepted');
  assertCatalog(await roundtrip.read(), state, true);
  const expectedAudits = report.audit_findings.filter(f => f.kind === 'duplicate_arxiv_id');
  assert.equal(auditState(state).length, expectedAudits.length);
  for (const f of expectedAudits) assert.ok(auditState(state).some(a => a.identifier === f.arxiv && fingerprint([...a.publication_ids].sort()) === fingerprint([...f.publication_ids].sort())));
  // Check all filing/filter memberships against immutable source-derived state.
  const years = [...new Set(state.publications.map(p => Number(p.publication_date.slice(0, 4))))];
  for (const year of years) assert.deepEqual((await catalog.list({year})).map(p => p.id).sort(), state.publications.filter(p => p.publication_date.startsWith(String(year))).map(p => p.id).sort());
  assert.equal((await catalog.list({author: report.owner_author_id})).length, state.publications.length);
  await initializeGit(catalog);
  await run('git', ['add', '--', 'README.md'], stage);
  await run('git', ['commit', '-m', 'Migrate PubMan2 catalog with preserved identities and Scholar evidence'], stage);
  assert.equal((await run('git', ['status', '--porcelain'], stage)).stdout, '');
  await run('git', ['fsck', '--full'], stage);
  await backup(catalog, join(build, 'initial-backup'));
  const restored = new Catalog({root: join(build, 'restore-verification')});
  await restore(restored, join(build, 'initial-backup'));
  assertCatalog(await restored.read(), state);
  const head = (await run('git', ['rev-parse', 'HEAD'], stage)).stdout.trim();
  assert.equal((await run('git', ['rev-parse', 'HEAD'], restored.root)).stdout.trim(), head);
  await run('git', ['fsck', '--full'], restored.root);
  const verified = {schema_version: 1, catalog_state_sha256: await sha256(join(build, 'catalog_state.json')),
    source_snapshot_sha256: report.snapshot_sha256, target, commit: head,
    committer: (await run('git', ['show', '-s', '--format=%cn <%ce>', 'HEAD'], stage)).stdout.trim(),
    application_commit: (await run('git', ['rev-parse', 'HEAD'], appRoot)).stdout.trim(),
    counts: report.destination_counts, checks: ['core schema and semantic validation', 'source UUID and ordered-association reconciliation', 'written record equality', 'native dependency-closed round trip', 'year and owner filters', 'SQLite index rebuild', 'Git fsck', 'independent backup and restore, including identical commit'],
    audit_errors: auditState(state), catalog_json_files: catalogFiles(state).size};
  await atomicWriteJson(join(build, 'verification.json'), verified);
  await atomicWriteJson(join(stage, 'local/migration-verification.json'), verified);
  process.stdout.write(JSON.stringify(verified, null, 2) + '\n');
} else {
  const verified = JSON.parse(await readFile(join(build, 'verification.json'), 'utf8'));
  assert.equal(verified.target, target);
  assert.equal(verified.catalog_state_sha256, await sha256(join(build, 'catalog_state.json')));
  assert.equal((await run('git', ['status', '--porcelain'], stage)).stdout, '');
  assert.equal((await run('git', ['rev-parse', 'HEAD'], stage)).stdout.trim(), verified.commit);
  assertCatalog(await new Catalog({root: stage}).read(), state);
  await requireEmpty(target);
  // Same-volume rename activates the already verified Git repository atomically.
  await rename(stage, target); await chmod(target, 0o700);
  assertCatalog(await new Catalog({root: target}).read(), state);
  assert.equal((await run('git', ['status', '--porcelain'], target)).stdout, '');
  process.stdout.write(JSON.stringify({installed: target, commit: verified.commit, counts: verified.counts}) + '\n');
}
