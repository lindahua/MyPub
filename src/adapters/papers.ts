import { load } from "cheerio";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeDoi } from "../core/utils.js";
import { MyPubError } from "../core/errors.js";
import type { Publication } from "../core/types.js";

export interface PaperCandidate {
  url: string;
  evidence: string;
  identity: boolean;
}
export interface PaperResponse {
  url: string;
  bytes: Buffer;
  contentType: string;
}
export interface PaperTransportOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  intervalMs?: number;
  maxBytes?: number;
}
export function webUrl(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new MyPubError(
      "Paper URLs must use HTTP(S) without credentials",
      "PAPER_URL",
    );
  return url.href;
}
/** One queue per host, including redirects and full response bodies. Shared by a batch. */
export function paperTransport(options: PaperTransportOptions = {}) {
  if (
    (options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) ||
    (options.intervalMs !== undefined &&
      (!Number.isFinite(options.intervalMs) || options.intervalMs < 0))
  )
    throw new MyPubError("Invalid download transport limits", "USAGE");
  const queues = new Map<string, Promise<void>>(),
    next = new Map<string, number>(),
    blocked = new Set<string>();
  const sleep = options.sleep ?? delay;
  async function request(url: string): Promise<PaperResponse | string> {
    const host = new URL(url).host,
      previous = queues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(
      host,
      previous.then(() => gate),
    );
    await previous;
    try {
      if (blocked.has(host))
        throw new MyPubError(
          `Host paused after access restriction: ${host}`,
          "PAPER_BLOCKED",
        );
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(Math.max(0, (next.get(host) ?? 0) - Date.now()));
        next.set(host, Date.now() + (options.intervalMs ?? 1000));
        let response: Response;
        try {
          response = await (options.fetch ?? fetch)(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(30_000),
            headers: {
              "User-Agent": "mypub/0.1",
              Accept: "application/pdf,text/html;q=0.9",
            },
          });
        } catch (error) {
          if (attempt === 2) throw error;
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if ([401, 403].includes(response.status)) {
          await response.body?.cancel();
          blocked.add(host);
          throw new MyPubError(`Access restricted at ${host}`, "PAPER_BLOCKED");
        }
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          const value = response.headers.get("retry-after");
          const wait = value
            ? /^\d+$/.test(value)
              ? Number(value) * 1000
              : Date.parse(value) - Date.now()
            : 1000 * 2 ** attempt;
          if (attempt === 2 || wait > 60_000) {
            blocked.add(host);
            throw new MyPubError(
              `Host unavailable (HTTP ${response.status}): ${host}`,
              "PAPER_BLOCKED",
            );
          }
          next.set(
            host,
            Date.now() + Math.max(0, Number.isFinite(wait) ? wait : 1000),
          );
          continue;
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location)
            throw new MyPubError("Redirect has no Location", "PAPER_FETCH");
          return webUrl(new URL(location, url).href);
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new MyPubError(
            `HTTP ${response.status}: ${url}`,
            "PAPER_FETCH",
          );
        }
        const max = options.maxBytes ?? 50 * 1024 * 1024;
        if (Number(response.headers.get("content-length")) > max) {
          await response.body?.cancel();
          throw new MyPubError("Download exceeds size limit", "PAPER_SIZE");
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        try {
          if (reader)
            for (;;) {
              const item = await reader.read();
              if (item.done) break;
              size += item.value.length;
              if (size > max)
                throw new MyPubError(
                  "Download exceeds size limit",
                  "PAPER_SIZE",
                );
              chunks.push(item.value);
            }
        } finally {
          await reader?.cancel();
        }
        return {
          url,
          bytes: Buffer.concat(chunks),
          contentType: response.headers.get("content-type") ?? "",
        };
      }
      throw new MyPubError("Request failed", "PAPER_FETCH");
    } finally {
      release();
    }
  }
  return async (input: string): Promise<PaperResponse> => {
    let url = webUrl(input);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const result = await request(url);
      if (typeof result !== "string") return result;
      url = result;
    }
    throw new MyPubError("Too many redirects", "PAPER_FETCH");
  };
}
const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
export function paperCandidates(
  html: string,
  pageUrl: string,
  publication: Publication,
): PaperCandidate[] {
  const $ = load(html),
    candidates = new Map<string, PaperCandidate>();
  const title = $('meta[name="citation_title"]').attr("content");
  const doi = $('meta[name="citation_doi"]').attr("content");
  const mismatch =
    !!doi &&
    !!publication.identifiers.doi &&
    normalizeDoi(doi) !== normalizeDoi(publication.identifiers.doi);
  const identity =
    !mismatch &&
    ((!!title && normalized(title) === normalized(publication.title)) ||
      (!!doi &&
        !!publication.identifiers.doi &&
        normalizeDoi(doi) === normalizeDoi(publication.identifiers.doi)));
  if (mismatch)
    throw new MyPubError(
      "Official page DOI differs from publication",
      "PAPER_MISMATCH",
    );
  function add(href: string | undefined, evidence: string) {
    if (!href) return;
    try {
      const url = webUrl(new URL(href, pageUrl).href);
      candidates.set(url, {
        url,
        evidence: `${evidence}; page: ${pageUrl}; title: ${title ?? "unknown"}; DOI: ${doi ?? "unknown"}`,
        identity,
      });
    } catch {
      /* Ignore non-web links. */
    }
  }
  $('meta[name="citation_pdf_url"]').each((_, el) => {
    add($(el).attr("content"), "citation_pdf_url");
  });
  if (!candidates.size)
    $('a[href],link[type="application/pdf"]').each((_, el) => {
      const node = $(el),
        text = node.text().trim(),
        href = node.attr("href") ?? "";
      if (/supplement|appendix|slides|poster/i.test(`${text} ${href}`)) return;
      if (
        /^(\[?pdf\]?|download(?: paper| pdf)?|paper)$/i.test(text) ||
        node.attr("type") === "application/pdf"
      )
        add(href, "explicit paper link");
    });
  return [...candidates.values()];
}
/** Conservative envelope check; not a full PDF parser or malware scanner. */
export function pdfEnvelope(bytes: Buffer): boolean {
  return (
    /^%PDF-1\.[0-9]|^%PDF-2\.0/.test(bytes.subarray(0, 16).toString("ascii")) &&
    /%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1")) &&
    /\bstartxref\s+\d+/.test(bytes.subarray(-4096).toString("latin1"))
  );
}
