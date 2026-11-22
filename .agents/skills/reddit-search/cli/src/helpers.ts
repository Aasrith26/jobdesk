// Data source: public subreddit RSS/Atom feeds, https://www.reddit.com/r/<sub>/new/.rss,
// and a post's own feed (<permalink>.rss) for one post's detail. No OAuth, no
// JSON API, no login. Every URL is checked with tools/robots_check.py first and
// skipped unless it reports ALLOWED. Post bodies are third-party HTML, so they
// go through visibleHtml + stripInvisible before anything reaches the output.

import { spawnSync } from "child_process"
import { existsSync } from "fs"
import { join } from "path"

export const REDDIT = "https://www.reddit.com"
/** Repo root: src -> cli -> reddit-search -> skills -> .agents -> root. */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
export const ROBOTS_SCRIPT = join(REPO_ROOT, "tools", "robots_check.py")

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export const UA = "Mozilla/5.0 (compatible; ai-job-search-reddit-cli/1.0)"

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
      headers: { "User-Agent": UA, Accept: "application/atom+xml,application/rss+xml;q=0.9,*/*;q=0.5" },
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
 * Decode an href. Reddit's feed HTML is XML-escaped once more, and some
 * links still carry a literal `&amp;` after both passes, so it is folded once.
 */
function decodeHref(raw: string): string {
  return decodeHtmlEntities(raw).replace(/&amp;/g, "&").trim()
}

/** Every external http(s) link in a post body, decoded, in document order. */
export function extractLinks(html: string): string[] {
  const links: string[] = []
  for (const m of visibleHtml(html).matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)) {
    const href = decodeHref(m[1])
    if (/^https?:\/\//i.test(href) && !links.includes(href)) links.push(href)
  }
  return links
}

/**
 * Post HTML -> plain text. `<p>` is a blank line, `<br/>`/`<li>` a line break;
 * a link whose text differs from its URL becomes `text (url)`; relative links
 * keep only their text.
 */
export function htmlToText(html: string): string {
  const text = visibleHtml(html)
    .replace(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, rawHref: string, inner: string) => {
      const href = decodeHref(rawHref)
      const label = decodeHtmlEntities(inner.replace(/<[^>]+>/g, "")).trim()
      if (!/^https?:\/\//i.test(href)) return inner
      const bare = (u: string) => u.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase()
      if (!label) return ` ${href} `
      // Autolinked text ("CVAT.ai" -> http://CVAT.ai/): keep what the reader sees.
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
// Subreddits and URLs
// ---------------------------------------------------------------------------

export const DEFAULT_SUBREDDITS = ["forhire", "developersIndia", "MachineLearningJobs", "remotejs", "jobbit", "PythonJobs"]

/** Subreddit names: 2-21 chars of letters, digits and underscores. */
const SUB_RE = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/

/** Normalise "name", "r/name", "/r/name" or a reddit.com/r/name URL to "name"; null if invalid. */
export function normalizeSubreddit(input: string): string | null {
  let s = input.trim()
  const m = s.match(/^(?:https?:\/\/)?(?:(?:www|old|new)\.)?reddit\.com\/r\/([^/?#]+)\/?$/i)
  if (m) s = m[1]
  s = s.replace(/^\/?r\//i, "")
  return SUB_RE.test(s) ? s : null
}

/** The /new feed of one subreddit. `limit` is honoured by Reddit's feed (max 100). */
export function feedUrl(sub: string, limit: number): string {
  return `${REDDIT}/r/${sub}/new/.rss?limit=${limit}`
}

const POST_ID = /^[a-z0-9]{3,12}$/i

/**
 * Resolve a detail argument to the post's own feed URL (`<permalink>.rss`).
 * Accepts a reddit.com/old/new/np permalink `/r/<sub>/comments/<id>[/<slug>]`,
 * a redd.it/<id> short link, `t3_<id>` or a bare base36 post id (a search
 * result's `id`). Other hosts, userinfo and ports are rejected.
 */
export function postFeedUrl(input: string): string | null {
  const trimmed = input.trim()
  const bare = trimmed.match(/^(?:t3_)?([a-z0-9]{3,12})$/i)
  if (bare && POST_ID.test(bare[1])) return `${REDDIT}/comments/${bare[1].toLowerCase()}/.rss`
  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (!hasScheme && !/^(?:(?:www|old|new|np)\.)?(?:reddit\.com|redd\.it)\//i.test(trimmed)) return null
  let u: URL
  try {
    u = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase()
  if (host === "redd.it") {
    const m = u.pathname.match(/^\/([a-z0-9]{3,12})\/?$/i)
    return m ? `${REDDIT}/comments/${m[1].toLowerCase()}/.rss` : null
  }
  if (!/^(?:(?:www|old|new|np)\.)?reddit\.com$/.test(host)) return null
  const m = u.pathname.match(/^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,12})(?:\/([^/]*))?\/?(?:\.rss)?$/i)
  if (!m) return null
  const slug = m[3] && m[3] !== ".rss" ? `${m[3]}/` : ""
  return `${REDDIT}/r/${m[1]}/comments/${m[2].toLowerCase()}/${slug}.rss`
}

// ---------------------------------------------------------------------------
// Atom feed parsing
// ---------------------------------------------------------------------------

export interface FeedEntry {
  /** Reddit fullname, e.g. t3_abc123 (post) or t1_xyz (comment). */
  fullname: string
  title: string
  author: string | null
  link: string | null
  published: string | null
  contentHtml: string
  subreddit: string | null
}

/** XML text node -> string: CDATA kept verbatim, otherwise entities decoded once. */
function xmlText(raw: string | undefined): string {
  if (raw === undefined) return ""
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return cdata ? cdata[1] : decodeHtmlEntities(raw)
}

/**
 * Split an Atom feed into its `<entry>` elements and parse each independently,
 * so one malformed entry cannot break the rest.
 */
export function parseFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = []
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]
    const fullname = xmlText(e.match(/<id>([\s\S]*?)<\/id>/)?.[1]).trim()
    if (!fullname) continue
    const author = xmlText(e.match(/<author>\s*<name>([\s\S]*?)<\/name>/)?.[1]).trim().replace(/^\/?u\//, "")
    out.push({
      fullname,
      title: xmlText(e.match(/<title\b[^>]*>([\s\S]*?)<\/title>/)?.[1]).trim(),
      author: author || null,
      link: decodeHtmlEntities(e.match(/<link\b[^>]*\bhref="([^"]*)"/)?.[1] ?? "") || null,
      published: (e.match(/<published>([^<]*)<\/published>/)?.[1] ?? e.match(/<updated>([^<]*)<\/updated>/)?.[1] ?? "").trim() || null,
      contentHtml: xmlText(e.match(/<content\b[^>]*>([\s\S]*?)<\/content>/)?.[1]),
      subreddit: decodeHtmlEntities(e.match(/<category\b[^>]*\bterm="([^"]*)"/)?.[1] ?? "") || null,
    })
  }
  return out
}

/**
 * Split a post's content HTML into its body and the feed's own trailer
 * ("submitted by /u/x [link] [comments]"). The `[link]` target of a link post
 * is returned when it points off Reddit.
 */
export function splitContent(html: string): { body: string; externalLink: string | null } {
  const at = html.search(/(?:&#32;|\s)*submitted by(?:&#32;|\s)*<a\b/i)
  const body = at >= 0 ? html.slice(0, at) : html
  const trailer = at >= 0 ? html.slice(at) : ""
  const link = trailer.match(/<a\b[^>]*href="([^"]+)"[^>]*>\s*\[link\]\s*<\/a>/i)?.[1]
  const href = link ? decodeHtmlEntities(link).trim() : null
  const external = href && /^https?:\/\//i.test(href) && !/^https?:\/\/(?:[a-z0-9-]+\.)*(?:reddit\.com|redd\.it|redditmedia\.com)\//i.test(href) ? href : null
  return { body, externalLink: external }
}

// ---------------------------------------------------------------------------
// Post assembly
// ---------------------------------------------------------------------------

export interface RedditPost {
  id: string
  kind: "job" | "lead"
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
  subreddit: string | null
  tags: string[]
}

/** Leading bracket tags of a title: "[Hiring] [Remote] Dev" -> ["Hiring", "Remote"]. */
export function titleTags(title: string): { tags: string[]; rest: string } {
  const tags: string[] = []
  let rest = title.trim()
  let m: RegExpMatchArray | null
  while ((m = rest.match(/^[\[(]\s*([^\])]{1,40}?)\s*[\])]\s*[:\-–—|]?\s*/))) {
    tags.push(m[1])
    rest = rest.slice(m[0].length)
  }
  return { tags, rest: rest.trim() }
}

export function isHiringTitle(title: string): boolean {
  return /\[\s*hiring\s*\]/i.test(title)
}

/** "[Hiring] Acme Corp is hiring a ..." / "Acme is looking for ..." -> "Acme Corp"; else null. */
export function companyFromTitle(rest: string): string | null {
  const m = rest.match(/^([A-Z][\w&.'-]*(?:\s+[A-Z0-9][\w&.'-]*){0,4})\s+(?:is hiring|is looking for|are hiring|are looking for)\b/)
  if (!m) return null
  if (/^(?:we|i|my|our|hiring|looking|anyone|startup|company|team)$/i.test(m[1])) return null
  return m[1]
}

/** Canonical post URL from the entry link: https://www.reddit.com/r/<sub>/comments/<id>/<slug>/ */
function canonicalUrl(link: string | null, id: string, sub: string | null): string {
  if (link) {
    try {
      const u = new URL(link)
      if (/^(?:(?:www|old|new)\.)?reddit\.com$/i.test(u.hostname) && /\/comments\//.test(u.pathname)) {
        return `${REDDIT}${u.pathname.endsWith("/") ? u.pathname : u.pathname + "/"}`
      }
    } catch {
      // fall through
    }
  }
  return sub ? `${REDDIT}/r/${sub}/comments/${id}/` : `${REDDIT}/comments/${id}/`
}

/** Build one post from a feed entry; null for anything that is not a post (t3_). */
export function buildPost(entry: FeedEntry, fallbackSub: string | null = null): RedditPost | null {
  const fm = entry.fullname.match(/^t3_([a-z0-9]+)$/i)
  if (!fm) return null
  const id = fm[1].toLowerCase()
  // Titles are plain text that Reddit escapes once more inside the feed.
  const rawTitle = decodeHtmlEntities(entry.title).replace(/\s+/g, " ").trim()
  const { tags, rest } = titleTags(rawTitle)
  const title = rest || rawTitle || "(untitled)"
  const { body, externalLink } = splitContent(entry.contentHtml)
  const text = htmlToText(body)
  const sub = entry.subreddit ?? fallbackSub
  const firstLines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2)
  const header = [rawTitle, ...firstLines].join("\n")
  const fields = postingFields([rawTitle, tags.join(" ")].join("\n"), text)
  const company = companyOf(text) ?? companyFromTitle(rest)
  const links = extractLinks(body).filter((u) => !/^https?:\/\/(?:[a-z0-9-]+\.)*(?:reddit\.com|redd\.it)\//i.test(u))
  const flat = text.replace(/\s+/g, " ").trim()
  const date = entry.published && /^\d{4}-\d{2}-\d{2}/.test(entry.published) ? entry.published.slice(0, 10) : null
  const author = entry.author && entry.author !== "[deleted]" ? entry.author : null
  return {
    id,
    kind: company ? "job" : "lead",
    title,
    company: company ?? (author ? `u/${author}` : "u/[deleted]"),
    location: fields.location,
    date,
    posted_date: date,
    url: canonicalUrl(entry.link, id, sub),
    apply_url: externalLink ?? links[0] ?? null,
    remote: fields.remote,
    work_mode: fields.work_mode,
    salary: fields.salary,
    employment_type: fields.employment_type,
    india_friendly: fields.india_friendly,
    india_reason: fields.india_reason,
    header,
    snippet: flat ? (flat.length > 280 ? flat.slice(0, 277) + "..." : flat) : null,
    author,
    thread_id: sub,
    thread_title: sub ? `r/${sub}` : null,
    subreddit: sub,
    tags,
  }
}

/** Plain text of a post's body (title excluded), for the keyword filter and detail. */
export function postText(entry: FeedEntry): string {
  return htmlToText(splitContent(entry.contentHtml).body)
}

/** Hiring company from an explicit "Company:" line (also "Компания:", "Employer:"), or null. */
export function companyOf(text: string): string | null {
  const m = text.match(/^\s*(?:[*•\-]\s*)?(?:company(?: name)?|компания|employer|работодатель)\s*[:\-–]\s*(.{1,80}?)\s*$/im)
  if (!m) return null
  const c = m[1].replace(/\s*\((?:https?:\/\/)[^)]*\)\s*$/, "").replace(/^[*_\s]+|[*_\s.,;]+$/g, "")
  return c || null
}

/** Client-side keyword match: every whitespace-separated term must occur (case-insensitive) in title + text. */
export function matchesQuery(haystack: string, query: string | undefined): boolean {
  if (!query) return true
  const h = haystack.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((t) => h.includes(t))
}
