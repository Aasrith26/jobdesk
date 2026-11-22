// Shared plumbing for company-boards-search: fetch with backoff, text hygiene,
// the companies.json loader, and the client-side filters. Zero runtime
// dependencies - plain bun + fetch.

import { readFileSync } from "node:fs"
import { join } from "node:path"

export const UA = "Mozilla/5.0 (compatible; company-boards-cli/1.0)"

export const ATS_NAMES = ["greenhouse", "lever", "ashby", "smartrecruiters", "workable"] as const
export type Ats = (typeof ATS_NAMES)[number]

export function isAts(value: string): value is Ats {
  return (ATS_NAMES as readonly string[]).includes(value)
}

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export function writeWarning(warning: string, code: string, extra: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ warning, code, ...extra }) + "\n")
}

export const DEFAULT_TIMEOUT_MS = 30000

export interface FetchOpts {
  /** Per-request timeout. Lever answers large boards slowly (10-30s seen live). */
  timeoutMs?: number
  /** Retries after the first attempt on 429/5xx. */
  retries?: number
}

/**
 * GET a JSON document with exponential backoff and jitter on 429/5xx (max 6
 * retries, honouring a numeric Retry-After up to 8s). Returns null on 404 so a
 * missing board or posting is a value, not a crash. A timeout or connection
 * error is not retried: in a fan-out it is one company's failure, and retrying
 * it would only stretch the whole run.
 */
export async function jsonFetch<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  const maxRetries = opts.retries ?? 6
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`.trim())
      }
      const retryAfter = Number(response.headers.get("retry-after"))
      const base = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : delay
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((r) => setTimeout(r, base + jitter))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`.trim())
    }
    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Response from ${new URL(url).host} was not JSON`)
    }
  }
  throw new Error("Request failed after max retries")
}

/** Run fn over items with at most `limit` in flight. Never rejects: fn must catch. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// ---------------------------------------------------------------------------
// Text hygiene (copied from linkedin-search/cli/src/helpers.ts, the contract's
// reference implementation; decodeHtmlEntities is single-pass here because
// Greenhouse serves entity-encoded HTML that must be decoded exactly once).
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
  euro: "€", pound: "£", yen: "¥", rupee: "₹", deg: "°", times: "×", rarr: "→", larr: "←",
}

/**
 * Convert a Unicode code point to a string. Uses `fromCodePoint` so
 * supplementary-plane code points decode correctly, and drops out-of-range
 * values instead of throwing.
 */
function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

/** Decode HTML character references in one pass (so "&amp;lt;" becomes "&lt;", not "<"). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      return numericEntity(ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10))
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole
  })
}

/**
 * Characters a reader of the posting never sees but a model reading this
 * output does: C0/C1 controls other than tab, newline and carriage return, the
 * soft hyphen, bidi marks/embeddings/overrides/isolates, zero-width characters
 * and invisible operators, the BOM, variation selectors, and Unicode tag
 * characters (U+E0000-E007F), which can spell out a whole hidden instruction.
 */
const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁯︀-️﻿\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Strip INVISIBLE_CHARS from every string in a result, recursively: the CLI's output boundary. */
export function stripInvisible<T>(value: T): T {
  if (typeof value === "string") return value.replace(INVISIBLE_CHARS, "") as T
  if (Array.isArray(value)) return value.map(stripInvisible) as T
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripInvisible(v)])) as T
  }
  return value
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])

/** Whether an opening tag's attributes keep it from rendering: `hidden`, or an inline style that hides it. */
function isHiddenTag(attrs: string): boolean {
  for (const m of attrs.matchAll(/([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ""
    if (name === "hidden") return true
    if (name === "style" && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i.test(value)) {
      return true
    }
  }
  return false
}

/**
 * Drop markup a browser never renders - comments (including Word's
 * conditional ones), <script>/<style>/<template> blocks, and elements marked
 * hidden - before tags are stripped. A plain tag strip keeps their text, which
 * hands the model words the posting's reader never saw. CSS-only tricks
 * (off-screen, zero font size) need a renderer and are not caught here.
 */
export function visibleHtml(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
  const open = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g
  const kept: string[] = []
  let from = 0
  let m: RegExpExecArray | null
  while ((m = open.exec(src)) !== null) {
    if (!m[2] || !isHiddenTag(m[2])) continue
    const tag = m[1].toLowerCase()
    let end = open.lastIndex
    if (!VOID_TAGS.has(tag) && !m[0].endsWith("/>")) {
      // Skip to the matching close tag, counting nested same-name elements. An
      // unclosed hidden element runs to the end: failing closed drops visible
      // text, failing open would leak the hidden text.
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
 * Render posting HTML as readable text: hidden markup dropped first (it can
 * span the line breaks), block elements become line breaks, list items become
 * "- " bullets, entities are decoded once per line after the tags are gone.
 */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = visibleHtml(html)
    .replace(/\s+/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n- ")
    .replace(/<\/\s*(p|li|ul|ol|div|h\d|tr|table|section|blockquote|pre)\s*>/gi, "\n")
    .replace(/<(p|div|h\d|ul|ol|table|section|blockquote|pre)\b[^>]*>/gi, "\n")
  const text = withBreaks
    .split("\n")
    .map((line) => decodeHtmlEntities(line.replace(/<[^>]*>/g, " ")).replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n(?=- )/g, "\n")
    .trim()
  return text || null
}

/** Plain text (no markup) -> single-line, whitespace-collapsed, or null. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const t = decodeHtmlEntities(value).replace(/\s+/g, " ").trim()
  return t || null
}

/** Any date-ish value (ISO string, epoch ms) -> "YYYY-MM-DD" (UTC), or null. */
export function toDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  const d = typeof value === "number" ? new Date(value) : new Date(String(value))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

let regionNames: Intl.DisplayNames | null = null
/** ISO-3166 alpha-2 -> English country name ("IN" -> "India"), or null. */
export function countryName(code: unknown): string | null {
  if (typeof code !== "string" || !/^[a-z]{2}$/i.test(code.trim())) return null
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" })
    const name = regionNames.of(code.trim().toUpperCase())
    return name && name.toUpperCase() !== code.trim().toUpperCase() ? name : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// companies.json
// ---------------------------------------------------------------------------

export interface Company {
  name: string
  ats: Ats
  token: string
  tags: string[]
}

/** companies.json lives at the skill root; COMPANY_BOARDS_FILE overrides it (tests, alternate lists). */
export function companiesPath(): string {
  return process.env.COMPANY_BOARDS_FILE || join(import.meta.dir, "..", "..", "companies.json")
}

export class ConfigError extends Error {}

/** Validate a parsed companies.json ({companies:[...]} or a bare array). Throws ConfigError. */
export function parseCompanies(raw: unknown): Company[] {
  const list = Array.isArray(raw) ? raw : (raw as { companies?: unknown } | null)?.companies
  if (!Array.isArray(list)) throw new ConfigError('companies file must be {"companies": [...]} or a JSON array')
  const seen = new Set<string>()
  return list.map((entry, i) => {
    const e = entry as Record<string, unknown>
    const where = `companies[${i}]`
    if (!e || typeof e !== "object") throw new ConfigError(`${where} must be an object`)
    const name = typeof e.name === "string" ? e.name.trim() : ""
    const ats = typeof e.ats === "string" ? e.ats.trim().toLowerCase() : ""
    const token = typeof e.token === "string" ? e.token.trim() : ""
    if (!name) throw new ConfigError(`${where}.name is required`)
    if (!isAts(ats)) throw new ConfigError(`${where}.ats must be one of ${ATS_NAMES.join("|")}, got ${JSON.stringify(e.ats)}`)
    // The token is interpolated into an API path: keep it to slug characters.
    if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new ConfigError(`${where}.token must be a board slug (letters, digits, . _ -), got ${JSON.stringify(e.token)}`)
    const tags = Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase()).filter(Boolean) : []
    const key = `${ats}:${token.toLowerCase()}`
    if (seen.has(key)) throw new ConfigError(`${where} duplicates ${key}`)
    seen.add(key)
    return { name, ats, token, tags }
  })
}

export function loadCompanies(path = companiesPath()): Company[] {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new ConfigError(`cannot read companies file at ${path}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ConfigError(`companies file ${path} is not valid JSON: ${e instanceof Error ? e.message : e}`)
  }
  return parseCompanies(raw)
}

/** Split "a, b,c" into trimmed, lowercased, non-empty items. */
export function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
}

/** Keep companies matching every given selector (each selector is an OR list). */
export function selectCompanies(
  companies: Company[],
  sel: { company?: string[]; tag?: string[]; ats?: string[] },
): Company[] {
  return companies.filter((c) => {
    if (sel.company?.length) {
      const name = c.name.toLowerCase()
      const token = c.token.toLowerCase()
      if (!sel.company.some((q) => name.includes(q) || token === q)) return false
    }
    if (sel.tag?.length && !sel.tag.some((t) => c.tags.includes(t))) return false
    if (sel.ats?.length && !sel.ats.includes(c.ats)) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Client-side filters
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A term that must start at a word boundary: "ai" matches "AI Engineer", not "Maintenance". */
function wordStart(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}`, "iu")
}

/**
 * Compile --query. Alternatives are separated by an uppercase " OR " or "|";
 * inside one alternative every word (or "quoted phrase") must appear, each
 * matched case-insensitively at the start of a word.
 */
export function compileQuery(q: string): (text: string) => boolean {
  const alternatives = q
    .split(/\s+OR\s+|\|/)
    .map((alt) => {
      const terms: string[] = []
      for (const m of alt.matchAll(/"([^"]+)"|(\S+)/g)) {
        const t = (m[1] ?? m[2]).trim()
        if (t) terms.push(t)
      }
      return terms.map(wordStart)
    })
    .filter((terms) => terms.length > 0)
  if (alternatives.length === 0) return () => true
  return (text) => alternatives.some((terms) => terms.every((re) => re.test(text)))
}

const INDIA_PLACES = [
  "india", "bengaluru", "bangalore", "hyderabad", "secunderabad", "mumbai", "navi mumbai", "pune", "chennai",
  "delhi", "new delhi", "ncr", "gurugram", "gurgaon", "noida", "kolkata", "ahmedabad", "kochi", "jaipur",
  "chandigarh", "coimbatore", "indore", "thiruvananthapuram", "trivandrum", "karnataka", "telangana", "maharashtra",
  "tamil nadu", "haryana",
]

/**
 * --location terms that expand to a set of whole-word place names. Postings
 * often name only the city ("Bengaluru") or only a country code (Lever "IN"),
 * so a bare -l India would otherwise miss most Indian roles.
 */
export const LOCATION_ALIASES: Record<string, string[]> = {
  india: INDIA_PLACES,
  bengaluru: ["bengaluru", "bangalore"],
  bangalore: ["bengaluru", "bangalore"],
  gurugram: ["gurugram", "gurgaon"],
  gurgaon: ["gurugram", "gurgaon"],
  delhi: ["delhi", "new delhi", "ncr", "gurugram", "gurgaon", "noida"],
  hyderabad: ["hyderabad", "secunderabad"],
  mumbai: ["mumbai", "navi mumbai", "bombay"],
  chennai: ["chennai", "madras"],
  "united states": ["united states", "usa", "u.s.", "us"],
  usa: ["united states", "usa", "u.s.", "us"],
  uk: ["united kingdom", "uk", "england", "london"],
}

/**
 * Compile --location (comma-separated, OR). A term with an alias entry matches
 * any alias as a whole word; any other term is a case-insensitive substring.
 */
export function compileLocation(value: string): (haystack: string) => boolean {
  const matchers = splitList(value).map((term) => {
    const aliases = LOCATION_ALIASES[term]
    if (aliases) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${aliases.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "iu")
      return (h: string) => re.test(h)
    }
    return (h: string) => h.toLowerCase().includes(term)
  })
  return (h) => matchers.some((m) => m(h))
}

const GENERIC_REMOTE_WORDS =
  /\b(?:remote|remotely|anywhere|worldwide|global|globally|fully|friendly|first|distributed|work from home|wfh|flexible|or|and|in|the|location|locations|multiple|various|tbd|n\/a)\b/gi

/**
 * Whether a remote posting's location names no specific place ("Remote",
 * "Anywhere", "Remote - Worldwide"), so it is open to a candidate anywhere.
 * "Remote - US" or a remote job listed under "United States" is not.
 */
export function isUnrestrictedRemote(locations: string[]): boolean {
  if (locations.length === 0) return true
  return locations.every((l) => !/[\p{L}\p{N}]/u.test(l.replace(GENERIC_REMOTE_WORDS, " ")))
}

/** Days between a YYYY-MM-DD date and now; null for a missing date. */
export function ageInDays(date: string | null, now = Date.now()): number | null {
  if (!date) return null
  const t = Date.parse(`${date}T00:00:00Z`)
  return Number.isNaN(t) ? null : (now - t) / 86400000
}
