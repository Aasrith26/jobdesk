// Data source: the official GitHub REST API (api.github.com), read-only.
//   - GET /search/issues        help-wanted / paid / bounty issues (search API)
//   - GET /search/repositories  repos whose README says "we're hiring"
//   - GET /repos/{o}/{r}[/issues/{n}|/readme]  stars, one issue, one README
// Unauthenticated by default. An optional GITHUB_TOKEN env var is sent as a
// Bearer token (higher limits); it is never printed, logged or put in a URL.
// Issue bodies and READMEs are third-party content, so everything goes through
// visibleHtml + stripInvisible before it reaches the output.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const API_URL = "https://api.github.com"
export const UA = "ai-job-search-github-helpwanted-cli/1.0"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

/** Error that carries a machine-readable code to the stderr JSON. */
export class CliError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/** The optional token. Read from the environment only; never echoed anywhere. */
export function githubToken(): string | null {
  const t = process.env.GITHUB_TOKEN?.trim()
  return t ? t : null
}

/** Remove the token from any text before it can reach stdout/stderr (defence in depth). */
export function redact(text: string): string {
  const t = githubToken()
  return t ? text.split(t).join("[redacted]") : text
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * The search API allows 10 requests/minute unauthenticated and 30 with a
 * token. /scrape may run this CLI several times in a row, so the budget is
 * tracked across invocations in a small state file in the OS temp dir, and we
 * stay one under the limit (9 / 28 per rolling 60 s).
 */
export const SEARCH_BUDGET = { anon: 9, authed: 28 }
const WINDOW_MS = 60_000
/** Wait for a reset at most this long; beyond it, fail with RATE_LIMITED instead of hanging. */
export const MAX_RESET_WAIT_MS = 65_000

export function stateDir(): string {
  const dir = process.env.GH_HELPWANTED_STATE_DIR || join(tmpdir(), "ai-job-search-github-helpwanted")
  mkdirSync(dir, { recursive: true })
  return dir
}

interface RateState {
  search_calls: number[]
  /** epoch ms before which no request of that resource may be sent (from x-ratelimit-reset at remaining 0) */
  blocked_until: { search?: number; core?: number }
  core_remaining?: number
}

export function readRateState(): RateState {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir(), "ratelimit.json"), "utf8"))
    return {
      search_calls: Array.isArray(raw.search_calls) ? raw.search_calls.filter((n: unknown) => typeof n === "number") : [],
      blocked_until: raw.blocked_until && typeof raw.blocked_until === "object" ? raw.blocked_until : {},
      core_remaining: typeof raw.core_remaining === "number" ? raw.core_remaining : undefined,
    }
  } catch {
    return { search_calls: [], blocked_until: {} }
  }
}

function writeRateState(s: RateState): void {
  const file = join(stateDir(), "ratelimit.json")
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(s))
    renameSync(tmp, file)
  } catch {
    // Best effort: a missing state file only means we fall back to the headers.
  }
}

/** Block until a search request fits the rolling budget (and any reset window has passed). */
export async function throttle(resource: "search" | "core", now: () => number = Date.now): Promise<void> {
  const state = readRateState()
  const blocked = state.blocked_until[resource]
  if (blocked && blocked > now()) {
    const wait = blocked - now()
    if (wait > MAX_RESET_WAIT_MS) {
      throw new CliError(
        `GitHub ${resource} rate limit exhausted until ${new Date(blocked).toISOString()}; try again later or set GITHUB_TOKEN`,
        "RATE_LIMITED",
      )
    }
    await sleep(wait + 250)
  }
  if (resource !== "search") return
  const cap = githubToken() ? SEARCH_BUDGET.authed : SEARCH_BUDGET.anon
  let calls = state.search_calls.filter((t) => t > now() - WINDOW_MS).sort((a, b) => a - b)
  if (calls.length >= cap) {
    const wait = calls[calls.length - cap] + WINDOW_MS - now()
    if (wait > 0) await sleep(wait + 250)
    calls = calls.filter((t) => t > now() - WINDOW_MS)
  }
  calls.push(now())
  writeRateState({ ...readRateState(), search_calls: calls })
}

/** Remember what the response headers said about the remaining budget. */
function recordHeaders(resource: "search" | "core", headers: Headers): void {
  const remaining = Number(headers.get("x-ratelimit-remaining"))
  const reset = Number(headers.get("x-ratelimit-reset"))
  if (!headers.has("x-ratelimit-remaining") || !Number.isFinite(remaining)) return
  const state = readRateState()
  if (resource === "core") state.core_remaining = remaining
  if (remaining <= 0 && Number.isFinite(reset) && reset > 0) state.blocked_until[resource] = reset * 1000
  else delete state.blocked_until[resource]
  writeRateState(state)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface GhResponse<T> {
  data: T
  headers: Headers
}

export interface GhFetchOpts {
  resource: "search" | "core"
  accept?: string
  /** Return the body as text instead of parsing JSON (READMEs rendered as HTML). */
  raw?: boolean
}

/**
 * GET a GitHub API URL. Exponential backoff with jitter on 429/5xx (500 ms
 * doubling to 8 s, max 6 retries). A 403/429 that the headers mark as a rate
 * limit (x-ratelimit-remaining: 0, or retry-after) waits for the reset when
 * that is at most ~1 minute away, else fails with RATE_LIMITED. 404 -> null.
 */
export async function ghFetch<T = unknown>(url: string, opts: GhFetchOpts): Promise<GhResponse<T> | null> {
  const maxRetries = 6
  let delay = 500
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: opts.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  const token = githubToken()
  if (token) headers.Authorization = `Bearer ${token}`

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttle(opts.resource)
    const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(20000) })
    recordHeaders(opts.resource, response.headers)

    const remaining = response.headers.get("x-ratelimit-remaining")
    const retryAfter = Number(response.headers.get("retry-after"))
    const rateLimited =
      (response.status === 403 || response.status === 429) &&
      (remaining === "0" || (Number.isFinite(retryAfter) && retryAfter > 0))
    if (rateLimited) {
      if (attempt === maxRetries) throw new CliError("GitHub rate limit: gave up after retries", "RATE_LIMITED")
      let wait: number
      if (Number.isFinite(retryAfter) && retryAfter > 0) wait = retryAfter * 1000
      else wait = Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now()
      if (!Number.isFinite(wait) || wait > MAX_RESET_WAIT_MS) {
        const reset = Number(response.headers.get("x-ratelimit-reset"))
        const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : ""
        throw new CliError(`GitHub ${opts.resource} rate limit exhausted${when}; try again later or set GITHUB_TOKEN`, "RATE_LIMITED")
      }
      await sleep(Math.max(wait, 0) + 250)
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) throw new CliError(`Request failed: HTTP ${response.status}`, "HTTP_ERROR")
      const jitter = Math.floor(Math.random() * 500)
      await sleep(delay + jitter)
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    const text = await response.text()
    if (!response.ok) {
      let msg = ""
      try {
        msg = String((JSON.parse(text) as { message?: string }).message ?? "")
      } catch {
        // not JSON
      }
      throw new CliError(
        redact(`GitHub API ${response.status}${msg ? `: ${msg.slice(0, 200)}` : ` ${response.statusText}`}`),
        response.status === 422 ? "BAD_QUERY" : "HTTP_ERROR",
      )
    }
    if (opts.raw) return { data: text as T, headers: response.headers }
    try {
      return { data: JSON.parse(text) as T, headers: response.headers }
    } catch {
      throw new CliError(`Response from ${new URL(url).host} was not valid JSON`, "BAD_RESPONSE")
    }
  }
  throw new CliError("Request failed after max retries", "HTTP_ERROR")
}

// ---------------------------------------------------------------------------
// Repo info cache (stars) - 24 h, OS temp dir
// ---------------------------------------------------------------------------

export interface RepoInfo {
  full_name: string
  stars: number | null
  description: string | null
  pushed_at: string | null
  archived: boolean
  owner_type: string | null
  homepage: string | null
  fetched_at: number
}

const REPO_TTL_MS = 24 * 3600 * 1000

function repoCacheFile(): string {
  return join(stateDir(), "repos.json")
}

export function readRepoCache(): Record<string, RepoInfo> {
  try {
    return JSON.parse(readFileSync(repoCacheFile(), "utf8")) as Record<string, RepoInfo>
  } catch {
    return {}
  }
}

export function writeRepoCache(cache: Record<string, RepoInfo>): void {
  const now = Date.now()
  const fresh = Object.fromEntries(Object.entries(cache).filter(([, v]) => now - v.fetched_at < REPO_TTL_MS))
  const tmp = `${repoCacheFile()}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(fresh))
    renameSync(tmp, repoCacheFile())
  } catch {
    // best effort
  }
}

export interface RawRepo {
  full_name: string
  stargazers_count?: number
  description?: string | null
  pushed_at?: string | null
  archived?: boolean
  homepage?: string | null
  owner?: { login?: string; type?: string } | null
  html_url?: string
  topics?: string[]
  language?: string | null
}

export function toRepoInfo(r: RawRepo): RepoInfo {
  return {
    full_name: r.full_name,
    stars: typeof r.stargazers_count === "number" ? r.stargazers_count : null,
    description: r.description ?? null,
    pushed_at: r.pushed_at ?? null,
    archived: r.archived === true,
    owner_type: r.owner?.type ?? null,
    homepage: r.homepage || null,
    fetched_at: Date.now(),
  }
}

/** Repo info for one "owner/repo", from the 24 h cache or one core API request. */
export async function getRepo(fullName: string, cache: Record<string, RepoInfo>): Promise<RepoInfo | null> {
  const hit = cache[fullName.toLowerCase()]
  if (hit && Date.now() - hit.fetched_at < REPO_TTL_MS) return hit
  const res = await ghFetch<RawRepo>(`${API_URL}/repos/${fullName}`, { resource: "core" })
  if (!res) return null
  const info = toRepoInfo(res.data)
  cache[fullName.toLowerCase()] = info
  return info
}

// ---------------------------------------------------------------------------
// HTML / text hygiene (visibleHtml + stripInvisible copied from hn-hiring-search)
// ---------------------------------------------------------------------------

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  euro: "€", pound: "£", yen: "¥", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·",
}

/** Decode HTML entities in a single pass (so `&amp;lt;` stays `&lt;`, not `<`). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X"
      return numericEntity(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10))
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Characters a reader never sees but a model reading this output does: C0/C1
 * controls other than tab/newline/CR, soft hyphen, bidi marks/overrides/
 * isolates, zero-width characters and invisible operators, BOM, variation
 * selectors and Unicode tag characters.
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

function isHiddenTag(attrs: string): boolean {
  for (const m of attrs.matchAll(/([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ""
    if (name === "hidden") return true
    if (name === "aria-hidden" && value.toLowerCase() === "true") return true
    if (name === "style" && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i.test(value)) {
      return true
    }
  }
  return false
}

/**
 * Drop markup a browser never renders - comments, <script>/<style>/<template>
 * blocks, and elements marked hidden - before tags are stripped.
 */
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

/** Every http(s) <a href> in visible HTML, decoded, in document order. */
export function extractLinks(html: string): string[] {
  const links: string[] = []
  for (const m of visibleHtml(html).matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)) {
    const href = decodeHtmlEntities(m[1]).trim()
    if (/^https?:\/\//i.test(href) && !links.includes(href)) links.push(href)
  }
  return links
}

/** Rendered HTML (GitHub's body_html / README html) to readable plain text. */
export function htmlToText(html: string): string {
  const text = visibleHtml(html)
    .replace(/<a\b[^>]*\bhref\s*=\s*"(https?:[^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim()
      const h = decodeHtmlEntities(href)
      return label && decodeHtmlEntities(label) !== h ? `${label} (${h})` : ` ${h} `
    })
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n- ")
    .replace(/<\s*\/?\s*(?:p|div|h\d|ul|ol|pre|blockquote|table|tr|details|summary)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
  return decodeHtmlEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Raw issue markdown to plain text, for the search snippet (the search API
 * returns markdown only). HTML comments - issue templates are full of them,
 * and they never render - and inline HTML tags are dropped.
 */
export function markdownToText(md: string): string {
  return htmlToText(
    md
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/```[\s\S]*?(?:```|$)/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1 ($2)"),
  )
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>]+/g, "")
    .replace(/[ \t]+/g, " ")
    .trim()
}

// ---------------------------------------------------------------------------
// Lead classification
// ---------------------------------------------------------------------------

/** Keyword hits that count in a title or a label name. */
export const LEAD_WORD = /\b(hiring|paid|bounty|bounties|contract|contractor|contractors|freelance)\b|💎/i

/**
 * Phrases that count in an issue body. The bare words are far too noisy there
 * ("API contract", "paid plan"), so the body needs a lead-shaped phrase.
 */
export const BODY_LEAD =
  /\b(?:we(?:'|’)?re hiring|we are hiring|(?:is|are) hiring|paid (?:task|bounty|gig|contract|work|role|position|opportunity|contribution|issue|engagement)|this (?:is a )?paid|bounty of|bounty: ?\$?\d|\$\s?\d[\d,.]*k?\s*(?:usd\s*)?(?:bounty|reward)|contract (?:role|position|opportunity|developer|engineer|work|gig)|freelance (?:role|position|opportunity|developer|engineer|work|gig))\b|\/bounty\s+\$?\d/i

export interface IssueMatch {
  matched: boolean
  reasons: string[]
}

/** Why an issue counts as a lead: a help-wanted label, or a lead keyword in title/labels/body. */
export function classifyIssue(title: string, labels: string[], body: string): IssueMatch {
  const reasons: string[] = []
  if (labels.some((l) => /^help[ -]?wanted$/i.test(l.trim()))) reasons.push("label:help wanted")
  for (const l of labels) {
    const m = l.match(LEAD_WORD)
    if (m && !/^help[ -]?wanted$/i.test(l.trim())) reasons.push(`label:${l.trim()}`)
  }
  const t = title.match(LEAD_WORD)
  if (t) reasons.push(`title:${t[0].toLowerCase()}`)
  const b = markdownToText(body).match(BODY_LEAD)
  if (b) reasons.push(`body:${b[0].toLowerCase().trim()}`)
  return { matched: reasons.length > 0, reasons: [...new Set(reasons)] }
}

/** "https://api.github.com/repos/o/r" -> "o/r". */
export function repoFromApiUrl(url: string): string | null {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(url)
  return m ? `${m[1]}/${m[2]}` : null
}

export function snippet(text: string, n = 280): string | null {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat ? (flat.length > n ? flat.slice(0, n - 3) + "..." : flat) : null
}

/** YYYY-MM-DD of an ISO timestamp, or null. */
export function isoDate(s: string | null | undefined): string | null {
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null
}

/** UTC date `days` ago, YYYY-MM-DD. */
export function sinceDate(days: number, now = Date.now()): string {
  return new Date(now - days * 86400_000).toISOString().slice(0, 10)
}
