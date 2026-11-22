// Data source: the public web preview of Telegram channels, https://t.me/s/<channel>
// (the page Telegram serves to browsers without a login), and the single-post
// embed https://t.me/<channel>/<id>?embed=1. No authentication, no Bot API, no
// MTProto. Message bodies are third-party HTML, so they go through visibleHtml +
// stripInvisible before anything reaches the output.

import { spawnSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

export const TME = "https://t.me"
/** Repo root: src -> cli -> telegram-channels-search -> skills -> .agents -> root. */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
export const ROBOTS_SCRIPT = join(REPO_ROOT, "tools", "robots_check.py")
export const CONFIG_PATH = join(REPO_ROOT, "wrapper-data", "config.json")

/** The config file to read: $TELEGRAM_CHANNELS_CONFIG when set (tests use it), else wrapper-data/config.json. */
export function configPath(): string {
  return process.env.TELEGRAM_CHANNELS_CONFIG || CONFIG_PATH
}

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export const UA = "Mozilla/5.0 (compatible; ai-job-search-telegram-cli/1.0)"

// ---------------------------------------------------------------------------
// Fetching: rate limit (1 request / 2 s), retry with backoff on 429/5xx
// ---------------------------------------------------------------------------

/** Minimum gap between two requests this process makes, in ms. */
export const MIN_INTERVAL_MS = 2000
let lastRequestAt = 0

/** Test hook: forget the previous request time so the next one is not delayed. */
export function resetRateLimit(): void {
  lastRequestAt = 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now()
  if (lastRequestAt > 0 && wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/**
 * GET a page as text. At most one request every MIN_INTERVAL_MS (retries
 * included); exponential backoff with jitter on 429/5xx (500 ms doubling to
 * 8 s, max 6 retries; a numeric Retry-After is honoured up to 30 s). 404 -> null.
 */
export async function textFetch(url: string): Promise<string | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttle()
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      const retryAfter = Number(response.headers.get("retry-after"))
      const jitter = Math.floor(Math.random() * 500)
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30000) : delay + jitter
      await sleep(wait)
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return await response.text()
  }
  throw new Error("Request failed after max retries")
}

// ---------------------------------------------------------------------------
// robots.txt gate (delegates to the repo's tools/robots_check.py)
// ---------------------------------------------------------------------------

export interface RobotsVerdict {
  allowed: boolean
  message: string
}

export type RobotsChecker = (url: string) => RobotsVerdict

/**
 * Ask tools/robots_check.py whether `url` may be fetched (exit 0 = allowed).
 * Fails closed: if no Python interpreter can run the script, the URL is
 * treated as not allowed. Tries `python` then `python3` on Windows (where
 * `python3` is often the Store stub), the reverse elsewhere.
 */
export function pythonRobotsCheck(url: string): RobotsVerdict {
  if (!existsSync(ROBOTS_SCRIPT)) {
    return { allowed: false, message: `robots check unavailable: ${ROBOTS_SCRIPT} not found` }
  }
  const interpreters = process.env.ROBOTS_CHECK_PYTHON
    ? [process.env.ROBOTS_CHECK_PYTHON]
    : process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]
  for (const py of interpreters) {
    const r = spawnSync(py, [ROBOTS_SCRIPT, url], { encoding: "utf-8", timeout: 60000 })
    const out = `${r.stdout ?? ""}`.trim()
    // Only a verdict line from the script counts; a missing or stub interpreter does not.
    if (/^(?:ALLOWED|DISALLOWED|UNCONFIRMED)\b/.test(out)) {
      // Drop the tool's pointer into the web-research workflow; it means nothing here.
      const message = out.split("\n")[0].replace(/ - do not retry, go to step 3$/, "")
      return { allowed: r.status === 0 && out.startsWith("ALLOWED"), message }
    }
  }
  return { allowed: false, message: "robots check unavailable: no Python interpreter could run tools/robots_check.py" }
}

let robotsChecker: RobotsChecker = pythonRobotsCheck
const robotsCache = new Map<string, RobotsVerdict>()

/** Test hook: replace the robots checker (and clear the per-run cache). */
export function setRobotsChecker(fn: RobotsChecker | null): void {
  robotsChecker = fn ?? pythonRobotsCheck
  robotsCache.clear()
}

export function robotsAllowed(url: string): RobotsVerdict {
  const hit = robotsCache.get(url)
  if (hit) return hit
  const v = robotsChecker(url)
  robotsCache.set(url, v)
  return v
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * `telegram_channels` from wrapper-data/config.json, or null when the file or
 * key is absent. A present-but-malformed value throws (never silently ignored).
 */
export function channelsFromConfig(path = configPath()): string[] | null {
  if (!existsSync(path)) return null
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
  if (data === null || typeof data !== "object" || !("telegram_channels" in data)) return null
  const v = (data as Record<string, unknown>).telegram_channels
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`${path}: "telegram_channels" must be an array of strings`)
  }
  return v as string[]
}

/** Public channel usernames: 4-32 chars of letters, digits and underscores, starting with a letter. */
const CHANNEL_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/

/** Normalise "@name", "name", "t.me/name" or "https://t.me/s/name" to "name"; null if not a valid public username. */
export function normalizeChannel(input: string): string | null {
  let s = input.trim()
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?([^/?#]+)\/?$/i)
  if (m) s = m[1]
  s = s.replace(/^@/, "")
  return CHANNEL_RE.test(s) ? s : null
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
 * Characters a reader of the posting never sees but a model reading this
 * output does: C0/C1 controls other than tab/newline/CR, soft hyphen, bidi
 * marks/overrides/isolates, zero-width characters and invisible operators,
 * BOM, variation selectors and Unicode tag characters.
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
 * Decode an href. Telegram double-escapes `&` inside link URLs
 * (`?a=1&amp;amp;b=2` in the page source), so after the single entity pass a
 * literal `&amp;` is folded once more.
 */
function decodeHref(raw: string): string {
  return decodeHtmlEntities(raw).replace(/&amp;/g, "&").trim()
}

/** Every external http(s) link in a message body, decoded, in document order. */
export function extractLinks(html: string): string[] {
  const links: string[] = []
  for (const m of visibleHtml(html).matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)) {
    const href = decodeHref(m[1])
    if (/^https?:\/\//i.test(href) && !links.includes(href)) links.push(href)
  }
  return links
}

/**
 * Telegram message HTML -> plain text. `<br/>` is a line break; a link whose
 * text differs from its URL becomes `text (url)`; relative hashtag links
 * (`?q=%23tag`) keep only their text.
 */
export function htmlToText(html: string): string {
  const text = visibleHtml(html)
    .replace(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, rawHref: string, inner: string) => {
      const href = decodeHref(rawHref)
      const label = decodeHtmlEntities(inner.replace(/<[^>]+>/g, "")).trim()
      if (!/^https?:\/\//i.test(href)) return inner
      const bare = (u: string) => u.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase()
      if (!label) return ` ${href} `
      // Autolinked text (the label is the bare domain the link points to): keep what the reader sees.
      if (bare(label) === bare(href)) return inner
      // Re-escape the label: the whole string is entity-decoded once below.
      return `${label.replace(/&/g, "&amp;").replace(/</g, "&lt;")} (${href.replace(/&/g, "&amp;")})`
    })
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/?\s*p\b[^>]*>/gi, "\n\n")
    .replace(/<\/(pre|li|div|h\d|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
  return decodeHtmlEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// ---------------------------------------------------------------------------
// Channel preview parsing
// ---------------------------------------------------------------------------

export interface RawMessage {
  channel: string
  id: string
  html: string
  datetime: string | null
  forwarded: boolean
}

/** Inner HTML of the first `<div class="<cls> ...">`, matched by div depth. */
function divInner(chunk: string, cls: string): string | null {
  const open = new RegExp(`<div\\b[^>]*\\bclass="${cls}(?:\\s[^"]*)?"[^>]*>`, "i")
  const m = open.exec(chunk)
  if (!m) return null
  const start = m.index + m[0].length
  const tags = /<(\/?)div\b[^>]*>/gi
  tags.lastIndex = start
  let depth = 1
  let t: RegExpExecArray | null
  while ((t = tags.exec(chunk)) !== null) {
    if (t[1]) depth--
    else if (!t[0].endsWith("/>")) depth++
    if (depth === 0) return chunk.slice(start, t.index)
  }
  return chunk.slice(start)
}

/**
 * Split a t.me/s/<channel> page (or a ?embed=1 page) into its messages. Each
 * message is the chunk from one `<div class="tgme_widget_message ..."
 * data-post="channel/id">` to the next, parsed independently so one odd
 * message cannot break the rest. Messages without text (photo/sticker only,
 * service messages) come back with an empty `html`.
 */
export function parseMessages(page: string): RawMessage[] {
  const starts = [...page.matchAll(/<div\b[^>]*\bclass="tgme_widget_message(?=[\s"])[^"]*"[^>]*\bdata-post="([^"\/]+)\/(\d+)"/gi)]
  const out: RawMessage[] = []
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]
    const chunk = page.slice(s.index!, i + 1 < starts.length ? starts[i + 1].index : page.length)
    const html = divInner(chunk, "tgme_widget_message_text") ?? ""
    const dt = chunk.match(/<a\b[^>]*class="tgme_widget_message_date"[^>]*>\s*<time\b[^>]*\bdatetime="([^"]+)"/i)
      ?? chunk.match(/<time\b[^>]*\bdatetime="([^"]+)"/i)
    out.push({
      channel: s[1],
      id: s[2],
      html,
      datetime: dt ? dt[1] : null,
      forwarded: /tgme_widget_message_forwarded_from/.test(chunk),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Posting fields (light heuristics; conservative, null when unsure)
// ---------------------------------------------------------------------------

const SALARY_RE =
  /(?:[$€£₹¥]\s?\d[\d.,\s]*(?:k\b)?(?:\s*[-–]\s*[$€£₹¥]?\s?\d[\d.,]*(?:k\b)?)?(?:\s*\/\s*(?:hr|hour|h|month|mo|year|yr)\b)?|\b\d[\d.,]*\s?(?:k\s?)?(?:usd|eur|gbp|inr|\$|€|£)(?:\s*\/\s*(?:hr|hour|month|mo|year|yr))?|\b\d+(?:\.\d+)?\s?(?:lpa|lakhs?|ctc)\b)/i
const EMPLOYMENT_RE = /\b(full[- ]?time|part[- ]?time|contract(?:or)?|internships?|freelance|permanent|temporary|b2b contract)\b/gi
const INDIA_EXPLICIT =
  /\b(?:india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|new delhi|delhi|ncr|gurgaon|gurugram|noida|kolkata|ahmedabad|kochi|apac|asia[- ]pacific)\b/i
const INDIA_NEGATED = /\b(?:not|no|except|excluding|outside(?: of)?)\b[^.\n]{0,30}\b(?:india|apac)\b/i
const GLOBAL = /\b(?:worldwide|world-wide|anywhere|any time ?zones?|globally|work from anywhere)\b|\bremote\s*\(\s*(?:global|world)\s*\)/i

/**
 * Location from the header lines: a "📍 ..." line; else a short line or `|`
 * field (<= 60 chars) that carries "(Remote)"-style work mode in parentheses or
 * names India/an Indian city/APAC or worldwide/anywhere ("Worldwide, Cyprus
 * (Remote)", "Bengaluru, India"); else the parenthetical of a longer field when
 * it names a place next to the mode ("... (Remote, Worldwide)" -> "Remote, Worldwide").
 */
export function locationFromHeader(header: string): string | null {
  for (const line of header.split("\n")) {
    const pin = line.match(/^\s*📍\s*(.+)$/u)
    if (pin) return pin[1].trim().slice(0, 120)
    for (const seg of line.split("|").map((x) => x.trim())) {
      const modeParen = seg.match(/\(([^)]*\b(?:remote|hybrid|on-?site)\b[^)]*)\)/i)
      if (seg.length > 2 && seg.length <= 60 && (modeParen || INDIA_EXPLICIT.test(seg) || GLOBAL.test(seg))) return seg
      if (modeParen && /[,/]|\b(?:worldwide|anywhere|global|[A-Z][a-z]+)\b/.test(modeParen[1].replace(/\b(?:remote|hybrid|on-?site)\b/gi, ""))) {
        return modeParen[1].trim()
      }
    }
  }
  return null
}

export interface PostingFields {
  location: string | null
  remote: boolean | null
  work_mode: string[]
  salary: string | null
  employment_type: string | null
  india_friendly: boolean
  india_reason: string | null
}

/** Work modes mentioned in the text (remote / hybrid / onsite). */
export function workModes(text: string): string[] {
  const modes: string[] = []
  if (/\bremote\b|\bwfh\b|\bwork from home\b|удал[её]нн?/i.test(text) && !/\b(?:no|not|non)[- ]remote\b/i.test(text)) modes.push("remote")
  if (/\bhybrid\b|гибрид/i.test(text)) modes.push("hybrid")
  if (/\b(?:on-?\s?site|onsite|in[- ]office|in[- ]person|work from office)\b|в офисе|офис\b/i.test(text)) modes.push("onsite")
  return modes
}

/**
 * Heuristic fields from a short header (title + first lines) and the full
 * body. Location comes from an explicit `Location:` line, else from a short
 * line in the header that mentions a work mode with a place (`Worldwide,
 * Cyprus (Remote)`), else "Remote" when only a bare remote marker is present.
 */
export function postingFields(header: string, body: string): PostingFields {
  const modes = workModes(header)
  let location: string | null = null
  const locLine = body.match(/^\s*(?:📍\s*)?(?:location|локация|город|местоположение)\s*[:\-–]\s*(.{2,120})$/im)
  if (locLine) location = locLine[1].trim()
  if (!location) location = locationFromHeader(header)
  if (!location && modes.includes("remote")) location = "Remote"
  const salaryM = (header + "\n" + body).match(SALARY_RE)
  const employment = new Set<string>()
  for (const m of (header + "\n" + body.slice(0, 600)).matchAll(EMPLOYMENT_RE)) {
    employment.add(
      m[1].toLowerCase()
        .replace(/^full[- ]?time$/, "full-time")
        .replace(/^part[- ]?time$/, "part-time")
        .replace(/^internships?$/, "internship")
        .replace(/^contractor$/, "contract"),
    )
  }
  const placeText = [header, location ?? ""].join("\n")
  let india_friendly = false
  let india_reason: string | null = null
  if (INDIA_EXPLICIT.test(placeText) && !INDIA_NEGATED.test(placeText)) {
    india_friendly = true
    india_reason = "explicit"
  } else if (GLOBAL.test(placeText)) {
    india_friendly = true
    india_reason = "global"
  }
  return {
    location,
    remote: modes.includes("remote") ? true : modes.length ? false : null,
    work_mode: modes,
    salary: salaryM ? salaryM[0].trim().slice(0, 100) : null,
    employment_type: employment.size ? [...employment].join(", ") : null,
    india_friendly,
    india_reason,
  }
}

// ---------------------------------------------------------------------------
// Lead assembly
// ---------------------------------------------------------------------------

export interface Lead {
  id: string
  kind: "lead"
  title: string
  company: string
  location: string | null
  date: string | null
  posted_date: string | null
  url: string
  apply_url: string | null
  remote: boolean | null
  work_mode: string[]
  salary: string | null
  employment_type: string | null
  india_friendly: boolean
  india_reason: string | null
  header: string
  snippet: string | null
  author: string | null
  thread_id: string | null
  thread_title: string | null
  channel: string
  forwarded: boolean
}

/** A line made only of hashtags ("#python #remote") is a tag line, not a title. */
function isTagLine(line: string): boolean {
  return /^(?:#[\p{L}\p{N}_]+[\s,]*)+$/u.test(line.trim())
}

const TITLE_MAX = 120

/** Title = first non-empty line that is not only hashtags (fallback: the first line), max 120 chars. */
export function titleOf(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  const raw = lines.find((l) => !isTagLine(l)) ?? lines[0] ?? ""
  // Drop "(https://...)" link targets and decorative emoji/arrows at either end.
  const cleaned = raw
    .replace(/\s*\(https?:\/\/[^)\s]*\)/gi, "")
    .replace(/^[\s\p{Extended_Pictographic}\p{Regional_Indicator}←-⇿☀-➿️‍]+/u, "")
    .replace(/[\s\p{Extended_Pictographic}\p{Regional_Indicator}←-⇿☀-➿️‍]+$/u, "")
  const line = cleaned || raw
  return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX - 1).trimEnd() + "…" : line
}

/** Hiring company from an explicit "Company:" line (also "Компания:", "Employer:"), or null. */
export function companyOf(text: string): string | null {
  const m = text.match(/^\s*(?:[*•\-]\s*)?(?:company(?: name)?|компания|employer|работодатель)\s*[:\-–]\s*(.{1,80}?)\s*$/im)
  if (!m) return null
  const c = m[1].replace(/\s*\((?:https?:\/\/)[^)]*\)\s*$/, "").replace(/^[*_\s]+|[*_\s.,;]+$/g, "")
  return c || null
}

/** Build one lead from a parsed message, or null when it has no text. */
export function buildLead(msg: RawMessage): Lead | null {
  const text = htmlToText(msg.html)
  if (!text) return null
  const title = titleOf(text)
  if (!title) return null
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  // Header = the title line and the two after it (where these channels put company / location).
  const titleIdx = Math.max(0, lines.findIndex((l) => !isTagLine(l)))
  const header = lines.slice(titleIdx, titleIdx + 3).join("\n")
  const fields = postingFields(header, text)
  const links = extractLinks(msg.html).filter((u) => !/^https?:\/\/(?:www\.)?(?:t|telegram)\.me\//i.test(u))
  const flat = text.replace(/\s+/g, " ").trim()
  const date = msg.datetime && /^\d{4}-\d{2}-\d{2}/.test(msg.datetime) ? msg.datetime.slice(0, 10) : null
  return {
    id: `${msg.channel}/${msg.id}`,
    kind: "lead",
    title,
    company: companyOf(text) ?? `@${msg.channel}`,
    location: fields.location,
    date,
    posted_date: date,
    url: `${TME}/${msg.channel}/${msg.id}`,
    apply_url: links[0] ?? null,
    remote: fields.remote,
    work_mode: fields.work_mode,
    salary: fields.salary,
    employment_type: fields.employment_type,
    india_friendly: fields.india_friendly,
    india_reason: fields.india_reason,
    header,
    snippet: flat.length > 280 ? flat.slice(0, 277) + "..." : flat,
    author: null,
    thread_id: msg.channel,
    thread_title: `t.me/${msg.channel}`,
    channel: msg.channel,
    forwarded: msg.forwarded,
  }
}

/** Client-side keyword match: every whitespace-separated term must occur (case-insensitive) in title + text. */
export function matchesQuery(haystack: string, query: string | undefined): boolean {
  if (!query) return true
  const h = haystack.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((t) => h.includes(t))
}
