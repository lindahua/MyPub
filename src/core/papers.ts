import { PAPER_FILES, paperFilePath } from "./paper-files.js";
import { PDFDocument } from "pdf-lib";
import { mkdir, readFile, readdir, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Catalog, findPublication, touch } from "./catalog.js";
import type { Publication, Attachment } from "./types.js";
import { MyPubError } from "./errors.js";
import {
  atomicWriteJson,
  durableWrite,
  fingerprint,
  now,
  uuid,
  withLock,
} from "./utils.js";
import { validUuid } from "./schemas.js";
import { createHash } from "node:crypto";
import {
  paperCandidates,
  paperTransport,
  pdfEnvelope,
  webUrl,
} from "../adapters/papers.js";
import type {
  PaperCandidate,
  PaperTransportOptions,
} from "../adapters/papers.js";

export interface StagedPaper {
  format_version: 1;
  id: string;
  publication_id: string;
  publication_revision: string;
  requested_url: string;
  resolved_url: string;
  downloaded_at: string;
  sha256: string;
  size_bytes: number;
  evidence: string;
  identity: boolean;
  state: "downloaded" | "verified" | "needs_review" | "invalid" | "registered";
  verification?: {
    checked_at: string;
    pdf_envelope: boolean;
    pdf_parsed: boolean;
    pages: number;
    reason: string;
    accepted_reason?: string;
  };
  attachment_id?: string;
}
const normalizeTitle = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function directory(c: Catalog, id?: string): Promise<string> {
  if (id !== undefined && !validUuid(id))
    throw new MyPubError("Invalid download ID", "DOWNLOAD_INVALID");
  const parts = [
    c.localDir,
    join(c.localDir, "downloads"),
    ...(id ? [join(c.localDir, "downloads", id)] : []),
  ];
  for (const path of parts) {
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new MyPubError(
          "Download paths cannot be symlinks",
          "UNSAFE_PATH",
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return parts.at(-1)!;
}
async function save(c: Catalog, m: StagedPaper) {
  await atomicWriteJson(join(await directory(c, m.id), "manifest.json"), m);
}
export async function getDownload(
  c: Catalog,
  id: string,
): Promise<StagedPaper> {
  const dir = await directory(c, id);
  const path = join(dir, "manifest.json");
  if ((await lstat(path)).isSymbolicLink())
    throw new MyPubError("Manifest cannot be a symlink", "UNSAFE_PATH");
  const m = JSON.parse(await readFile(path, "utf8")) as StagedPaper;
  if (
    !m ||
    typeof m !== "object" ||
    m.format_version !== 1 ||
    m.id !== id ||
    !validUuid(m.publication_id) ||
    !/^[a-f0-9]{64}$/.test(m.sha256) ||
    !/^[a-f0-9]{64}$/.test(m.publication_revision) ||
    !Number.isSafeInteger(m.size_bytes) ||
    m.size_bytes < 0 ||
    typeof m.identity !== "boolean" ||
    typeof m.evidence !== "string" ||
    ![
      "downloaded",
      "verified",
      "needs_review",
      "invalid",
      "registered",
    ].includes(m.state)
  )
    throw new MyPubError("Invalid download manifest", "DOWNLOAD_INVALID");
  webUrl(m.requested_url);
  webUrl(m.resolved_url);
  return m;
}
export async function listDownloads(c: Catalog): Promise<StagedPaper[]> {
  const dir = await directory(c);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const result: StagedPaper[] = [];
  for (const id of entries.filter(validUuid)) {
    try {
      result.push(await getDownload(c, id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw e; /* Interrupted before manifest: retry downloads fresh. */
    }
  }
  return result;
}
async function bytesFor(c: Catalog, m: StagedPaper) {
  const path = join(await directory(c, m.id), "paper.pdf");
  if ((await lstat(path)).isSymbolicLink())
    throw new MyPubError("Staged PDF cannot be a symlink", "UNSAFE_PATH");
  const bytes = await readFile(path);
  if (bytes.length !== m.size_bytes || hash(bytes) !== m.sha256)
    throw new MyPubError("Staged PDF changed since download", "HASH_MISMATCH");
  return bytes;
}
export async function discoverPaper(
  c: Catalog,
  ref: string,
  transport = paperTransport(),
): Promise<PaperCandidate[]> {
  const p = await c.get(ref);
  if (p.paper_url)
    return [
      {
        url: webUrl(p.paper_url),
        identity: false,
        evidence: "record paper_url; content identity requires review",
      },
    ];
  return discoverOfficial(p, transport);
}
async function discoverOfficial(
  p: Publication,
  transport: ReturnType<typeof paperTransport>,
): Promise<PaperCandidate[]> {
  const url =
    p.official_url ??
    (p.identifiers.doi ? `https://doi.org/${p.identifiers.doi}` : undefined);
  if (!url)
    throw new MyPubError("No official page or paper URL", "PAPER_NO_LINK");
  const response = await transport(url);
  if (pdfEnvelope(response.bytes))
    return [
      {
        url: response.url,
        identity: false,
        evidence: "official page returned PDF; identity requires review",
      },
    ];
  return paperCandidates(response.bytes.toString("utf8"), response.url, p);
}
export async function downloadPaper(
  c: Catalog,
  ref: string,
  transport = paperTransport(),
  sourceUrl?: string,
): Promise<StagedPaper> {
  return stagePaper(c, await c.get(ref), transport, sourceUrl);
}
async function stagePaper(
  c: Catalog,
  p: Publication,
  transport: ReturnType<typeof paperTransport>,
  sourceUrl?: string,
): Promise<StagedPaper> {
  const base = await directory(c);
  await mkdir(base, { recursive: true });
  return withLock(join(base, `${p.id}.lock`), () =>
    stageUnlocked(c, p, transport, sourceUrl),
  );
}
async function stageUnlocked(
  c: Catalog,
  p: Publication,
  transport: ReturnType<typeof paperTransport>,
  sourceUrl?: string,
): Promise<StagedPaper> {
  if (p.archived_at)
    throw new MyPubError(
      "Cannot download for archived publication",
      "PAPER_ARCHIVED",
    );
  const revision = fingerprint(p);
  const existing = (await listDownloads(c)).find(
    (m) =>
      m.publication_id === p.id &&
      m.publication_revision === revision &&
      (!sourceUrl || m.requested_url === webUrl(sourceUrl)) &&
      ["downloaded", "verified", "needs_review"].includes(m.state),
  );
  if (existing) {
    await bytesFor(c, existing);
    return existing;
  }
  let candidates: PaperCandidate[] = sourceUrl
    ? [
        {
          url: webUrl(sourceUrl),
          identity: false,
          evidence: "explicit download URL; identity requires review",
        },
      ]
    : p.paper_url
      ? [
          {
            url: webUrl(p.paper_url),
            identity: false,
            evidence: "record paper_url; identity requires review",
          },
        ]
      : await discoverOfficial(p, transport);
  let response;
  let candidate: PaperCandidate;
  function select() {
    if (candidates.length !== 1)
      throw new MyPubError(
        candidates.length
          ? "Multiple paper candidates require explicit selection"
          : "No paper link found",
        candidates.length ? "PAPER_AMBIGUOUS" : "PAPER_NO_LINK",
        candidates,
      );
    return candidates[0]!;
  }
  candidate = select();
  try {
    response = await transport(candidate.url);
    if (!pdfEnvelope(response.bytes))
      throw new MyPubError(
        "Paper URL did not return a complete PDF envelope",
        "PAPER_INVALID",
      );
  } catch (e) {
    if (
      sourceUrl ||
      !p.paper_url ||
      !p.official_url ||
      (e instanceof MyPubError && e.code === "PAPER_BLOCKED")
    ) {
      if (!response) throw e;
    } else {
      candidates = await discoverOfficial(p, transport);
      candidate = select();
      response = await transport(candidate.url);
    }
  }
  if (!response) throw new MyPubError("No response", "PAPER_FETCH");
  const id = uuid(),
    dir = await directory(c, id);
  await mkdir(dir, { recursive: true });
  await durableWrite(join(dir, "paper.pdf"), response.bytes);
  const m: StagedPaper = {
    format_version: 1,
    id,
    publication_id: p.id,
    publication_revision: revision,
    requested_url: candidate.url,
    resolved_url: response.url,
    downloaded_at: now(),
    sha256: hash(response.bytes),
    size_bytes: response.bytes.length,
    evidence: candidate.evidence,
    identity: candidate.identity,
    state: "downloaded",
  };
  await save(c, m);
  return m;
}
export async function verifyDownload(
  c: Catalog,
  id: string,
  acceptedReason?: string,
): Promise<StagedPaper> {
  const dir = await directory(c, id);
  return withLock(join(dir, "operation.lock"), async () => {
    const m = await getDownload(c, id);
    if (m.state === "registered") return m;
    const bytes = await bytesFor(c, m),
      p = await c.get(m.publication_id),
      envelope = pdfEnvelope(bytes);
    let pages = 0,
      parsed = false,
      titleMatch = false,
      titleMismatch = false;
    try {
      const pdf = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
      pages = pdf.getPageCount();
      parsed = pages > 0;
      const title = pdf.getTitle();
      titleMatch = !!title && normalizeTitle(title) === normalizeTitle(p.title);
      titleMismatch = !!title && !titleMatch;
    } catch {
      /* Keep invalid files staged for inspection. */
    }
    const valid = envelope && parsed;
    if (acceptedReason !== undefined && !acceptedReason.trim())
      throw new MyPubError("Acceptance requires a reason", "DOWNLOAD_INVALID");
    const unchanged = fingerprint(p) === m.publication_revision;
    if (p.archived_at)
      throw new MyPubError("Publication archived", "PAPER_ARCHIVED");
    const acceptance =
      acceptedReason ??
      (unchanged ? m.verification?.accepted_reason : undefined);
    m.state = !valid
      ? "invalid"
      : unchanged &&
          ((m.identity && !titleMismatch) || titleMatch || acceptance)
        ? "verified"
        : "needs_review";
    m.verification = {
      checked_at: now(),
      pdf_envelope: envelope,
      pdf_parsed: parsed,
      pages,
      reason: !valid
        ? "PDF is incomplete, encrypted, malformed, or has no pages"
        : !unchanged
          ? "Publication changed; recheck source against current record"
          : m.state === "verified"
            ? "PDF envelope and source identity accepted"
            : "Inspect PDF and accept publication identity explicitly",
      ...(acceptance ? { accepted_reason: acceptance } : {}),
    };
    // Explicit acceptance can bind the inspected file to the current revision.
    if (valid && acceptedReason) {
      m.publication_revision = fingerprint(p);
      m.state = "verified";
      m.verification.reason =
        "PDF parsed; publication identity explicitly accepted";
    }
    await save(c, m);
    return m;
  });
}
export async function registerDownload(
  c: Catalog,
  id: string,
): Promise<Attachment> {
  const dir = await directory(c, id);
  return withLock(join(dir, "operation.lock"), async () => {
    const m = await getDownload(c, id);
    if (m.state === "registered") {
      const p = await c.get(m.publication_id),
        a = p.attachments.find(
          (a) => a.id === m.attachment_id && a.sha256 === m.sha256,
        );
      if (!a)
        throw new MyPubError(
          "Registered attachment missing",
          "DOWNLOAD_INVALID",
        );
      return a;
    }
    if (
      m.state !== "verified" ||
      !m.verification?.pdf_envelope ||
      !m.verification.pdf_parsed
    )
      throw new MyPubError(
        "Verify and accept the staged PDF before registration",
        "PAPER_UNVERIFIED",
      );
    const bytes = await bytesFor(c, m);
    if (!pdfEnvelope(bytes))
      throw new MyPubError("Invalid PDF envelope", "PAPER_INVALID");
    const attachment = await c.change((state, binary) => {
      const p = findPublication(state, m.publication_id);
      if (p.archived_at)
        throw new MyPubError("Publication archived", "PAPER_ARCHIVED");
      const existing = p.attachments.find((a) => a.sha256 === m.sha256);
      if (existing) {
        binary.set(existing.path, bytes);
        return existing;
      } // Restores missing bytes and recovers a crash after commit.
      if (fingerprint(p) !== m.publication_revision)
        throw new MyPubError(
          "Publication changed after verification",
          "STALE_REVISION",
        );
      const aid = uuid(),
        path = p.attachments.some((a) => a.path.startsWith(PAPER_FILES))
          ? `attachments/${p.id}/${aid}/paper.pdf`
          : paperFilePath(state, p);
      const a: Attachment = {
        id: aid,
        role: "paper",
        original_filename: "paper.pdf",
        media_type: "application/pdf",
        size_bytes: bytes.length,
        storage: "git-lfs",
        path,
        sha256: m.sha256,
        source_url: m.resolved_url,
      };
      p.attachments.push(a);
      if (!p.primary_attachment_id) p.primary_attachment_id = aid;
      touch(p);
      binary.set(path, bytes);
      if (p.paper_url !== m.requested_url) {
        const time = now(),
          target = { entity_type: "publication" as const, entity_id: p.id };
        state.reviews.push({
          schema_version: 2,
          id: uuid(),
          summary: `Discovered paper URL for ${p.title}`,
          kind: "change",
          state: "pending",
          targets: [target],
          created_at: time,
          updated_at: time,
          proposals: [
            {
              id: uuid(),
              target,
              operation: "replace",
              path: "/paper_url",
              expected_revision: fingerprint(p),
              ...(p.paper_url ? { current: p.paper_url } : {}),
              proposed: m.requested_url,
              state: "pending",
            },
          ],
        });
      }
      return a;
    });
    m.state = "registered";
    m.attachment_id = attachment.id;
    await save(c, m);
    await rm(join(dir, "paper.pdf"), { force: true });
    return attachment;
  });
}
export interface DownloadBatchOptions extends PaperTransportOptions {
  sourceUrl?: string;
  concurrency?: number;
  limit?: number;
  maxNew?: number;
  missing?: boolean;
  preview?: boolean;
  register?: boolean;
  onProgress?: (message: string) => void;
}
export async function downloadPapers(
  c: Catalog,
  refs: string[] | undefined,
  options: DownloadBatchOptions = {},
) {
  const concurrency = options.concurrency ?? 4;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 16 ||
    (options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1)) ||
    (options.maxNew !== undefined &&
      (!Number.isSafeInteger(options.maxNew) || options.maxNew < 1))
  )
    throw new MyPubError(
      "Concurrency must be 1–16; limit and max-new must be positive integers",
      "USAGE",
    );
  if (options.preview && options.maxNew !== undefined)
    throw new MyPubError("max-new cannot be used with preview", "USAGE");
  let publications: Publication[] = [];
  if (refs) for (const ref of refs) publications.push(await c.get(ref));
  else publications = await c.list({});
  publications = publications
    .filter(
      (p) =>
        !p.archived_at &&
        (!options.missing || !p.attachments.some((a) => a.role === "paper")),
    )
    .slice(0, options.limit);
  publications = [...new Map(publications.map((p) => [p.id, p])).values()];
  if (options.sourceUrl && (!refs || publications.length !== 1))
    throw new MyPubError("An explicit URL requires one publication", "USAGE");
  const transport = paperTransport(options),
    results: Array<{
      publication_id: string;
      status: string;
      download_id?: string;
      candidates?: PaperCandidate[];
      error?: string;
      new_download?: boolean;
    }> = [];
  const staged: StagedPaper[] = [];
  const knownStages = new Set((await listDownloads(c)).map((m) => m.id));
  let cursor = 0,
    started = 0,
    completed = 0,
    newDownloads = 0,
    reused = 0;
  const cap = options.maxNew ?? Number.POSITIVE_INFINITY;
  options.onProgress?.(
    `PDF batch: ${publications.length} publication${publications.length === 1 ? "" : "s"} selected; concurrency ${concurrency}${Number.isFinite(cap) ? `; at most ${cap} new download${cap === 1 ? "" : "s"}` : ""}.`,
  );
  const processOne = async (p: Publication): Promise<void> => {
    started++;
    options.onProgress?.(
      `Starting [${started}/${publications.length}] ${p.citation_key}`,
    );
    try {
      if (options.preview)
        results.push({
          publication_id: p.id,
          status: "preview",
          candidates: options.sourceUrl
            ? [
                {
                  url: webUrl(options.sourceUrl),
                  identity: false,
                  evidence: "explicit download URL",
                },
              ]
            : p.paper_url
              ? [
                  {
                    url: webUrl(p.paper_url),
                    identity: false,
                    evidence: "record paper_url",
                  },
                ]
              : await discoverOfficial(p, transport),
        });
      else {
        const m = await stagePaper(c, p, transport, options.sourceUrl);
        const fresh = !knownStages.has(m.id);
        knownStages.add(m.id);
        if (fresh) newDownloads++;
        else reused++;
        staged.push(m);
        results.push({
          publication_id: p.id,
          status: m.state,
          download_id: m.id,
          new_download: fresh,
        });
      }
    } catch (e) {
      results.push({
        publication_id: p.id,
        status: e instanceof MyPubError ? e.code : "PAPER_FETCH",
        error: String(e),
        ...(e instanceof MyPubError && e.code === "PAPER_AMBIGUOUS"
          ? { candidates: e.details as PaperCandidate[] }
          : {}),
      });
    }
    completed++;
    const result = results.find((r) => r.publication_id === p.id)!;
    options.onProgress?.(
      `Completed [${completed}/${publications.length}] ${p.citation_key}: ${result.status}${result.new_download === true ? " (new download)" : result.new_download === false ? " (reused stage)" : ""}`,
    );
  };
  // Waves reserve no more than the remaining new-download allowance. If some
  // items fail or reuse a stage, the next wave continues scanning candidates.
  while (cursor < publications.length && newDownloads < cap) {
    const remaining = cap - newDownloads;
    const size = Math.min(
      concurrency,
      publications.length - cursor,
      Number.isFinite(remaining) ? remaining : concurrency,
    );
    const wave = publications.slice(cursor, cursor + size);
    cursor += wave.length;
    await Promise.all(wave.map(processOne));
  }
  for (const [index, m] of staged.entries()) {
    const result = results.find((r) => r.download_id === m.id)!;
    try {
      options.onProgress?.(
        `Verifying [${index + 1}/${staged.length}] ${publications.find((p) => p.id === m.publication_id)?.citation_key ?? m.publication_id}`,
      );
      const verified = await verifyDownload(c, m.id);
      result.status = verified.state;
      if (options.register && verified.state === "verified") {
        options.onProgress?.(
          `Registering [${index + 1}/${staged.length}] ${publications.find((p) => p.id === m.publication_id)?.citation_key ?? m.publication_id}`,
        );
        await registerDownload(c, m.id);
        result.status = "registered";
      }
    } catch (e) {
      result.status = e instanceof MyPubError ? e.code : "PAPER_VERIFY";
      result.error = String(e);
    }
  }
  const failures = results.filter((r) => r.error).length;
  options.onProgress?.(
    `PDF batch complete: ${completed} examined, ${newDownloads} newly downloaded, ${reused} reused, ${failures} failed${cursor < publications.length ? `, ${publications.length - cursor} not examined after reaching max-new` : ""}.`,
  );
  return results.sort(
    (a, b) =>
      publications.findIndex((p) => p.id === a.publication_id) -
      publications.findIndex((p) => p.id === b.publication_id),
  );
}
