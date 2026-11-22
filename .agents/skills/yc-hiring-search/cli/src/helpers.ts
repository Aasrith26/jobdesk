// Data source: the community-maintained, unofficial YC companies API at
// https://yc-oss.github.io/api/ (static JSON on GitHub Pages, rebuilt daily from
// the YC website's public Algolia index). `companies/hiring.json` lists the
// companies YC marks as hiring (`isHiring: true`); `companies/all.json` every
// launched company (used only by `detail` for a slug not in the hiring list).
// The big files are cached in the OS temp dir for 24 h. Company text is
// third-party content, so every string goes through stripInvisible (and HTML
// through visibleHtml) before output.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const API_URL = "https://yc-oss.github.io/api"
export const YC_COMPANY_URL = "https://www.ycombinator.com/companies/"
export const UA = "ai-job-search-yc-hiring-cli/1.0"
export const CACHE_TTL_MS = 24 * 3600 * 1000

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export class CliError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * GET text with exponential backoff + jitter on 429/5xx (500 ms doubling to
 * 8 s, max 6 retries). 404 -> null. 60 s timeout: all.json is ~11 MB.
 */
export async function fetchText(url: string): Promise<string | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(60000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) throw new CliError(`Request failed: HTTP ${response.status}`, "HTTP_ERROR")
      const jitter = Math.floor(Math.random() * 500)
      await sleep(delay + jitter)
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) throw new CliError(`Request failed: HTTP ${response.status}`, "HTTP_ERROR")
    return await response.text()
  }
  throw new CliError("Request failed after max retries", "HTTP_ERROR")
}

// ---------------------------------------------------------------------------
// 24 h cache in the OS temp dir
// ---------------------------------------------------------------------------

export function cacheDir(): string {
  const dir = process.env.YC_HIRING_CACHE_DIR || join(tmpdir(), "ai-job-search-yc-hiring")
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface Loaded<T> {
  data: T
  /** "fresh" = downloaded now; "cache" = served from a <24 h file; "stale" = download failed, older file used */
  cache: "fresh" | "cache" | "stale"
  fetched_at: string
}

/**
 * JSON from `${API_URL}/${path}`, cached as `<cacheDir>/<name>` for 24 h.
 * `refresh` skips the cache. If the download fails and an older cache file
 * exists, that file is used and marked "stale" rather than failing.
 */
export async function loadJson<T>(path: string, opts: { refresh?: boolean } = {}): Promise<Loaded<T>> {
  const file = join(cacheDir(), path.replace(/[\\/]/g, "_"))
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    mtime = 0
  }
  const readCache = (): T | null => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T
    } catch {
      return null
    }
  }
  if (!opts.refresh && mtime && Date.now() - mtime < CACHE_TTL_MS) {
    const data = readCache()
    if (data !== null) return { data, cache: "cache", fetched_at: new Date(mtime).toISOString() }
  }
  try {
    const text = await fetchText(`${API_URL}/${path}`)
    if (text === null) throw new CliError(`${API_URL}/${path} returned 404 (has the yc-oss API moved?)`, "NOT_FOUND")
    let data: T
    try {
      data = JSON.parse(text) as T
    } catch {
      throw new CliError(`${API_URL}/${path} was not valid JSON`, "BAD_RESPONSE")
    }
    try {
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, text)
      renameSync(tmp, file)
    } catch {
      // best effort: an unwritable temp dir only costs a re-download next time
    }
    return { data, cache: "fresh", fetched_at: new Date().toISOString() }
  } catch (e) {
    const stale = mtime ? readCache() : null
    if (stale !== null) return { data: stale, cache: "stale", fetched_at: new Date(mtime).toISOString() }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Company records
// ---------------------------------------------------------------------------

export interface YcCompany {
  id?: number
  name: string
  slug: string
  former_names?: string[]
  website?: string | null
  all_locations?: string | null
  long_description?: string | null
  one_liner?: string | null
  team_size?: number | null
  industry?: string | null
  subindustry?: string | null
  launched_at?: number | null
  tags?: string[]
  top_company?: boolean
  isHiring?: boolean
  nonprofit?: boolean
  batch?: string | null
  status?: string | null
  industries?: string[]
  regions?: string[]
  stage?: string | null
  url?: string | null
}

const SEASONS: Record<string, string> = { w: "Winter", s: "Summer", f: "Fall", x: "Spring", sp: "Spring" }

/**
 * Normalize a batch: "W24" / "w2024" / "Winter 2024" / "winter-2024" ->
 * "Winter 2024"; "X25" / "Sp25" -> "Spring 2025"; "F24" -> "Fall 2024".
 * A bare year ("2024") matches every batch of that year. Null if unrecognized.
 */
export function normalizeBatch(input: string): { season: string | null; year: string } | null {
  const s = input.trim().toLowerCase().replace(/[-_\s]+/g, " ")
  let m = /^(winter|summer|fall|autumn|spring) ?(\d{4}|\d{2})$/.exec(s)
  if (m) {
    const season = m[1] === "autumn" ? "Fall" : m[1][0].toUpperCase() + m[1].slice(1)
    return { season, year: m[2].length === 2 ? `20${m[2]}` : m[2] }
  }
  m = /^(sp|w|s|f|x) ?(\d{4}|\d{2})$/.exec(s)
  if (m) return { season: SEASONS[m[1]], year: m[2].length === 2 ? `20${m[2]}` : m[2] }
  m = /^(\d{4})$/.exec(s)
  if (m) return { season: null, year: m[1] }
  return null
}

export function batchMatches(batch: string | null | undefined, wanted: { season: string | null; year: string }[]): boolean {
  if (!batch) return false
  const [season, year] = batch.split(" ")
  return wanted.some((w) => w.year === year && (w.season === null || w.season === season))
}

const SEASON_ORDER: Record<string, number> = { Winter: 1, Spring: 2, Summer: 3, Fall: 4 }

/** Sort key: newer batches first ("Winter 2027" > "Fall 2026" > ...); "Unspecified" last. */
export function batchRank(batch: string | null | undefined): number {
  const m = /^(Winter|Spring|Summer|Fall) (\d{4})$/.exec(batch ?? "")
  return m ? Number(m[2]) * 10 + SEASON_ORDER[m[1]] : 0
}

/** "Summer 2024" -> "S24", "Spring 2025" -> "X25" (YC's own short codes). */
export function shortBatch(batch: string | null | undefined): string | null {
  const m = /^(Winter|Spring|Summer|Fall) \d{2}(\d{2})$/.exec(batch ?? "")
  if (!m) return null
  return `${{ Winter: "W", Spring: "X", Summer: "S", Fall: "F" }[m[1]]}${m[2]}`
}

export function remoteKind(regions: string[] | undefined): "fully" | "partly" | "remote" | null {
  const r = regions ?? []
  if (r.includes("Fully Remote")) return "fully"
  if (r.includes("Partly Remote")) return "partly"
  if (r.includes("Remote")) return "remote"
  return null
}

/** Word-start match of every query word against name, one-liner, tags and industries. */
export function matchesQuery(c: YcCompany, query: string | undefined): boolean {
  const words = (query ?? "").split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [c.name, ...(c.former_names ?? []), c.one_liner ?? "", ...(c.tags ?? []), ...(c.industries ?? []), c.industry ?? "", c.subindustry ?? ""].join(" | ")
  return words.every((w) => new RegExp(`(?:^|[^\\p{L}\\d])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu").test(hay))
}

export function matchesLocation(c: YcCompany, location: string | undefined): boolean {
  if (!location) return true
  const hay = [c.all_locations ?? "", ...(c.regions ?? [])].join(" | ").toLowerCase()
  return location
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((l) => hay.includes(l))
}

/** The company's YC page, if the record's url is one; else its website if http(s); else the YC page built from the slug. */
export function companyUrl(c: YcCompany): string {
  if (c.url && /^https:\/\/www\.ycombinator\.com\/companies\/[a-z0-9-]+$/i.test(c.url)) return c.url
  if (/^[a-z0-9-]+$/i.test(c.slug)) return `${YC_COMPANY_URL}${c.slug}`
  return c.website && /^https?:\/\//i.test(c.website) ? c.website : `${YC_COMPANY_URL}${encodeURIComponent(c.slug)}`
}

// ---------------------------------------------------------------------------
// Text hygiene (stripInvisible + visibleHtml copied from hn-hiring-search)
// ---------------------------------------------------------------------------

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X"
      return numericEntity(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10))
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁯︀-️﻿\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

export function stripInvisible<T>(value: T): T {
  if (typeof value === "string") return value.replace(INVISIBLE_CHARS, "") as T
  if (Array.isArray(value)) return value.map(stripInvisible) as T
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripInvisible(v)])) as T
  }
  return value
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])

function isHiddenTag(attrs: string): boolean {
  for (const m of attrs.matchAll(/([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ""
    if (name === "hidden") return true
    if (name === "aria-hidden" && value.toLowerCase() === "true") return true
    if (name === "style" && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i.test(value)) return true
  }
  return false
}

/** Drop markup a browser never renders (comments, script/style/template, hidden elements). */
export function visibleHtml(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
  const open = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g
  const kept: string[] = []
  let from = 0
  let m: RegExpExecArray | null
  while ((m = open.exec(src)) !== null) {
    if (!m[2] || !isHiddenTag(m[2])) continue
    const tag = m[1].toLowerCase()
    let end = open.lastIndex
    if (!VOID_TAGS.has(tag) && !m[0].endsWith("/>")) {
      const same = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi")
      same.lastIndex = end
      end = src.length
      let depth = 1
      let s: RegExpExecArray | null
      while ((s = same.exec(src)) !== null) {
        if (s[1]) depth--
        else if (!s[0].endsWith("/>")) depth++
        if (depth === 0) {
          end = same.lastIndex
          break
        }
      }
    }
    kept.push(src.slice(from, m.index))
    from = end
    open.lastIndex = end
  }
  kept.push(src.slice(from))
  return kept.join("")
}

/**
 * The directory's text fields are plain text today, but they are written by
 * the companies themselves: any markup that sneaks in is reduced to what a
 * reader would see, and invisible characters are stripped.
 */
export function cleanText(s: string | null | undefined): string | null {
  if (!s) return null
  const t = /<[a-z!/]/i.test(s) ? decodeHtmlEntities(visibleHtml(s).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")) : s
  const out = stripInvisible(t).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
  return out || null
}

export function snippet(text: string | null, n = 280): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/g, " ").trim()
  return flat ? (flat.length > n ? flat.slice(0, n - 3) + "..." : flat) : null
}
