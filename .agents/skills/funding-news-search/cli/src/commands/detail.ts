import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CliError,
  classifyFunding,
  decodeHtmlEntities,
  extractAmount,
  extractCompany,
  extractRound,
  fetchText,
  htmlToText,
  removeElements,
  robotsCheck,
  stripInvisible,
  visibleHtml,
  writeError,
} from "../helpers.js"

export interface DetailOpts {
  url: string
  format: "json" | "plain"
  maxChars: number
}

/** Repo root: cli/src/commands -> cli/src -> cli -> funding-news-search -> skills -> .agents -> root. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..")
export const FETCH_PAGE = join(REPO_ROOT, "tools", "fetch_page.py")

/** http(s) URL with a host and no userinfo, or null. */
export function validUrl(input: string): URL | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password) return null
  return u
}

export interface FetchedPage {
  html: string
  via: "fetch_page.py" | "fetch"
  status: number
}

/**
 * Fetch through the repo's `tools/fetch_page.py` (GET only, robots.txt
 * enforced, body saved outside the repo), then read the saved HTML. Falls back
 * to a plain fetch - after our own robots check - only when Python or the
 * script is unavailable. A robots refusal is never retried another way.
 */
export async function fetchArticle(url: string): Promise<FetchedPage> {
  if (existsSync(FETCH_PAGE)) {
    const dir = mkdtempSync(join(tmpdir(), "funding-news-detail-"))
    const out = join(dir, "page.html")
    try {
      for (const py of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
        let proc
        try {
          proc = Bun.spawn([py, FETCH_PAGE, url, "--out", out], { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT })
        } catch {
          continue // interpreter not installed
        }
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        if (code === 1) throw new CliError(`robots.txt does not permit fetching ${url}`, "ROBOTS_DISALLOWED")
        const m = /^HTTP (\d+) size=\d+ saved=/m.exec(stdout)
        if (code === 0 && m) {
          const status = Number(m[1])
          const html = new TextDecoder("utf-8").decode(readFileSync(out))
          return { html, via: "fetch_page.py", status }
        }
        // Exit 2 = usage/transport error. A missing interpreter (Windows store stub) also lands here.
        if (/fetch_page:/.test(stderr)) throw new CliError(stderr.trim().split("\n").pop()!.slice(0, 300), "FETCH_FAILED")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const verdict = await robotsCheck(url)
  if (verdict !== "allowed") {
    throw new CliError(`robots.txt ${verdict === "disallowed" ? "does not permit" : "could not confirm permission for"} fetching ${url}`, "ROBOTS_DISALLOWED")
  }
  const res = await fetchText(url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
  return { html: res.text, via: "fetch", status: res.status }
}

function meta(html: string, key: string): string | null {
  const re = new RegExp(`<meta\\b(?=[^>]*\\b(?:property|name)\\s*=\\s*["']${key}["'])[^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`, "i")
  const m = re.exec(html)
  return m ? decodeHtmlEntities(m[1]).trim() || null : null
}

/**
 * The article's readable text: the largest <article> block if there is one,
 * else every <p> in the body. Hidden markup is dropped first (visibleHtml).
 */
export function articleText(html: string): string {
  const visible = visibleHtml(html)
  const articles = [...visible.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((m) => m[1])
  let core = articles.sort((a, b) => b.length - a.length)[0]
  if (!core || htmlToText(core).length < 200) {
    const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(visible)?.[1] ?? visible
    core = [...body.matchAll(/<(p|h[1-3]|li)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)].map((m) => m[0]).join("\n")
  }
  // Navigation / share / related / author blocks inside an <article> are noise.
  core = core.replace(/<(nav|aside|form|button|footer|time)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  core = removeElements(core, (attrs) => NOISE_ATTR.test(attrs))
  return htmlToText(core)
}

const NOISE_ATTR =
  /\b(?:class|id)\s*=\s*["'][^"']*\b(?:share|sharelink|social|bookmark|newsletter|subscribe|related|recommend|author-detail|tags-category|breadcrumb|advert|ad-slot|comments?)[\w-]*\b/i

/** Publication date from meta tags or JSON-LD, YYYY-MM-DD (publisher's own calendar date). */
export function publishedDate(html: string): string | null {
  const m =
    /<meta\b(?=[^>]*\b(?:property|name|itemprop)\s*=\s*["'](?:article:published_time|datePublished|pubdate|publish-date)["'])[^>]*\bcontent\s*=\s*["'](\d{4}-\d{2}-\d{2})/i.exec(html) ??
    /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(html)
  return m ? m[1] : null
}

export function buildDetail(url: string, page: FetchedPage, maxChars: number) {
  const html = page.html
  const title =
    meta(html, "og:title") ?? (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ? htmlToText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)![1]) : null)
  const text = articleText(html)
  const t = title ?? ""
  return stripInvisible({
    url,
    kind: "lead" as const,
    lead_type: "funded_startup" as const,
    title,
    company: t ? extractCompany(t) : null,
    amount: t ? extractAmount(t) : null,
    round: t ? extractRound(t) : null,
    looks_like_funding: t ? classifyFunding(t).funding : false,
    posted_date: publishedDate(html),
    site: meta(html, "og:site_name"),
    summary: meta(html, "og:description") ?? meta(html, "description"),
    http_status: page.status,
    fetched_via: page.via,
    description: text.slice(0, maxChars) || null,
    truncated: text.length > maxChars,
  })
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const u = validUrl(opts.url)
  if (!u) {
    writeError(`"${opts.url}" is not an http(s) article URL`, "BAD_URL")
    return 1
  }
  try {
    const page = await fetchArticle(u.toString())
    if (page.status !== 200) throw new CliError(`Article fetch returned HTTP ${page.status}`, "FETCH_FAILED")
    const d = buildDetail(u.toString(), page, opts.maxChars)
    if (opts.format === "plain") {
      const head = [
        d.title ?? "(no title)",
        `${d.company ?? "—"} · ${d.amount ?? "amount ?"} · ${d.round ?? "round ?"} · ${d.posted_date ?? "—"}${d.site ? ` · ${d.site}` : ""}`,
        d.summary ? `Summary: ${d.summary}` : "",
      ].filter(Boolean)
      process.stdout.write([head.join("\n"), d.description ?? "(no text)", `URL: ${d.url}`].join("\n\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(d, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), e instanceof CliError && e.code !== "HTTP_ERROR" ? e.code : "DETAIL_FAILED")
    return 1
  }
}
