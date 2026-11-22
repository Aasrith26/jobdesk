// Data source: Shine.com public job-search (JSRP) and job-description pages.
// No authentication required. Both are server-rendered Next.js pages: the
// search page carries one <article class="result-card_card__..."> per posting
// plus a React flight payload with the same jobs as data; the detail page
// carries a schema.org JobPosting JSON-LD block plus a visible role card and
// job-description <pre>. We parse both with regex, one card at a time, with
// zero runtime dependencies.
//
// robots.txt (User-agent: *) disallows /api/*, /jobs/jobs/, /jobs/1*, /jobs/9*,
// /job-search/simple/, /job-search/similar/ and a few query patterns
// (?jd_cname=, ?rect=, ?vendorid=, ?type=amp). Every URL this CLI builds stays
// on the allowed /job-search/<slug> and /jobs/<title>/<company>/<id> paths.

export const BASE_URL = "https://www.shine.com"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "Mozilla/5.0 (compatible; shine-cli/1.0)"

/** Fetch HTML with exponential backoff + jitter on 429/5xx. Returns "" on a 404. */
export async function htmlFetch(url: string): Promise<string> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((r) => setTimeout(r, delay + jitter))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return ""
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }
  throw new Error("Request failed after max retries")
}

// ---------------------------------------------------------------------------
// Text hygiene (copied from linkedin-search/cli/src/helpers.ts)
// ---------------------------------------------------------------------------

/**
 * Convert a Unicode code point to a string. Uses `fromCodePoint` so
 * supplementary-plane code points decode correctly, and drops out-of-range
 * values instead of throwing.
 */
function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ")
    // &amp; last, so "&amp;lt;" decodes to the literal text "&lt;" once.
    .replace(/&amp;/g, "&")
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
 * Drop markup a browser never renders - comments, <script>/<style>/<template>
 * blocks, and elements marked hidden - before tags are stripped. A plain tag
 * strip keeps their text, which hands the model words the posting's reader
 * never saw. CSS-only tricks (off-screen, zero font size) need a renderer and
 * are not caught here.
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

function stripTags(html: string): string {
  return visibleHtml(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

/** Visible text of an HTML fragment, entities decoded, whitespace collapsed. */
export function clean(html: string): string {
  // Tag stripping leaves "Bangalore , Pune" where links were joined by ", ".
  return decodeHtmlEntities(stripTags(html)).replace(/\s+/g, " ").replace(/ ,/g, ",").trim()
}

/**
 * Turn a description fragment (Shine's <pre> body, or HTML inside JSON-LD)
 * into readable text that keeps line and paragraph breaks.
 */
export function cleanDescription(html: string): string | null {
  const withBreaks = visibleHtml(html)
    .replace(/\r\n?/g, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|ul|ol|div|h\d|tr|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  const text = decodeHtmlEntities(withBreaks)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/**
 * Slugify a keyword or city the way Shine's own search box does: a few
 * symbols are spelled out (c++ -> c-plus-plus, node.js -> node-dot-js,
 * c# -> c-sharp), then everything that is not a-z/0-9 becomes a hyphen.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/\./g, " dot ")
    .replace(/#/g, " sharp ")
    .replace(/&/g, " n ")
    .replace(/["']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export type SortOrder = "relevance" | "date"

export interface SearchUrlOpts {
  query?: string
  location?: string
  page: number
  sort: SortOrder
}

/**
 * Build a Shine search URL:
 *   /job-search/<kw>-jobs[-in-<city>][-<page>][?sort=1]
 *   /job-search/jobs-in-<city>[-<page>][?sort=1]
 * Page 1 has no suffix; ?sort=1 is Shine's "Most recent" sort.
 */
export function buildSearchUrl(opts: SearchUrlOpts): string {
  // A trailing "jobs" in the query would produce "<kw>-jobs-jobs".
  const kw = opts.query ? slugify(opts.query).replace(/(^|-)jobs?$/, "") : ""
  // Shine slugs carry the city only ("hyderabad", "new-delhi"); drop any
  // ", State, Country" tail a caller passes.
  const loc = opts.location ? slugify(opts.location.split(",")[0]) : ""
  let slug: string
  if (kw && loc) slug = `${kw}-jobs-in-${loc}`
  else if (kw) slug = `${kw}-jobs`
  else if (loc) slug = `jobs-in-${loc}`
  else throw new Error("a query or a location is required")
  if (opts.page > 1) slug += `-${opts.page}`
  const qs = opts.sort === "date" ? "?sort=1" : ""
  return `${BASE_URL}/job-search/${slug}${qs}`
}

const SHINE_HOST = /(^|\.)shine\.com$/i

/** Job-detail path on shine.com -> numeric id, or null. */
export function idFromJobPath(pathname: string): string | null {
  const m = pathname.match(/^\/jobs\/[^/]+\/[^/]+\/(\d{5,})\/?$/)
  return m ? m[1] : null
}

/**
 * Accept a numeric job id or a shine.com job URL (with or without scheme or
 * query string). Returns { id, url } where url is the allowed detail path, or
 * null. URLs on any other host are rejected - host is read via URL parsing so
 * look-alike hosts (shine.com.evil.io) and userinfo tricks fail too.
 */
export function normalizeDetailInput(input: string): { id: string; url: string } | null {
  const trimmed = input.trim()
  if (/^\d{5,}$/.test(trimmed)) {
    // Shine serves a posting at /jobs/<any-slug>/<any-slug>/<id> and points
    // its canonical link at the real slugs. /jobs/<digit>... is disallowed by
    // robots.txt, so the placeholder slugs are letters.
    return { id: trimmed, url: `${BASE_URL}/jobs/job/company/${trimmed}` }
  }
  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (!hasScheme && !/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (!SHINE_HOST.test(parsed.hostname)) return null
  const id = idFromJobPath(parsed.pathname)
  if (!id) return null
  const [, , titleSlug, companySlug] = parsed.pathname.split("/")
  // Keep the caller's slugs unless they would land on a robots-disallowed
  // prefix (/jobs/jobs/, /jobs/1*, /jobs/9*).
  const safe = /^[a-z]/i.test(titleSlug) && titleSlug.toLowerCase() !== "jobs" && !/^[19]/.test(titleSlug)
  const path = safe ? `/jobs/${titleSlug}/${companySlug}/${id}` : `/jobs/job/company/${id}`
  return { id, url: `${BASE_URL}${path}` }
}

// ---------------------------------------------------------------------------
// Search page parsing
// ---------------------------------------------------------------------------

export interface JobCard {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  postedAt: string | null
  posted: string | null
  experience: string | null
  salary: string | null
  skills: string[]
  badges: string[]
  url: string
}

export interface SearchMeta {
  total: number | null
  pageCount: number | null
  hasNextPage: boolean | null
  pageTitle: string | null
  renderedAt: string | null
}

/**
 * Decode the React flight payload (`self.__next_f.push([1,"..."])` scripts)
 * into one string. Each push is parsed on its own so one malformed chunk
 * cannot drop the rest.
 */
export function decodeFlight(html: string): string {
  const parts: string[] = []
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\[\s\S])*")\]\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    try {
      const s = JSON.parse(m[1])
      if (typeof s === "string") parts.push(s)
    } catch {
      // skip a malformed chunk
    }
  }
  return parts.join("")
}

const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

/**
 * Map job id -> absolute posting timestamp from the flight payload. The
 * visible card only says "2 weeks ago"; the hydration data carries the same
 * jobs with `postedAt` in IST without an offset. Only a strict ISO timestamp
 * is accepted, so nothing free-text leaves this function.
 */
export function parsePostedAtMap(flight: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const chunk of flight.split(/\{"badges":/).slice(1)) {
    const id = chunk.match(/"id":"(\d+)"/)?.[1]
    const at = chunk.match(/"postedAt":"([^"]+)"/)?.[1]
    if (id && at && ISO_LOCAL.test(at) && !map.has(id)) map.set(id, `${at}+05:30`)
  }
  return map
}

export function parseSearchMeta(html: string, flight = decodeFlight(html)): SearchMeta {
  const num = (k: string): number | null => {
    const m = flight.match(new RegExp(`"${k}":(\\d+)`))
    return m ? parseInt(m[1], 10) : null
  }
  const next = flight.match(/"hasNextPage":(true|false)/)
  // <title> is Shine's SEO title for the slug, e.g. "Engineer Jobs in New
  // Delhi - 1,217 ..." for "llm engineer". It hints when keywords were
  // dropped, but it is SEO text, not a reliable echo of the search.
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)
  let pageTitle: string | null = null
  if (title) {
    const head = clean(title[1]).split(" - ")[0].trim()
    pageTitle = head && !/^shine\.com$/i.test(head) ? head : null
  }
  // When the server rendered this page. Some search slugs are served from a
  // server-side snapshot days or weeks old; the cards' "N days ago" labels
  // are relative to this moment, not to now.
  const dehydrated = num("dehydratedAt")
  const renderedAt = dehydrated && dehydrated > 1e12 && dehydrated < 1e13 ? new Date(dehydrated).toISOString() : null
  return {
    total: num("totalCount"),
    pageCount: num("pageCount"),
    hasNextPage: next ? next[1] === "true" : null,
    pageTitle,
    renderedAt,
  }
}

function firstText(chunk: string, re: RegExp): string | null {
  const m = chunk.match(re)
  if (!m) return null
  return clean(m[1]) || null
}

/**
 * Parse search-result cards. Each <article class="result-card_card__..."> is
 * cut out and parsed independently, so one malformed card cannot break the
 * rest. Class names carry CSS-module hashes (result-card_company__V6mN_), so
 * every anchor matches the stable prefix only.
 */
export function parseJobCards(html: string, postedAt: Map<string, string> = new Map()): JobCard[] {
  const results: JobCard[] = []
  const chunks = html.split(/<article\b[^>]*class="[^"]*\bresult-card_card__/).slice(1)

  for (const raw of chunks) {
    try {
      const end = raw.indexOf("</article>")
      // Drop hidden markup before reading any field.
      const chunk = visibleHtml(end === -1 ? raw : raw.slice(0, end))

      // Canonical job URL: schema.org meta, else the title link (query stripped).
      let url: string | null = null
      const metaUrl = chunk.match(/<meta\s+itemProp="url"\s+content="([^"]+)"/i)?.[1]
      const hitHref = chunk.match(/class="[^"]*result-card_hit__[^"]*"[^>]*href="([^"]+)"/i)?.[1]
      for (const cand of [metaUrl, hitHref]) {
        if (!cand) continue
        try {
          const u = new URL(decodeHtmlEntities(cand), BASE_URL)
          if (SHINE_HOST.test(u.hostname) && idFromJobPath(u.pathname)) {
            url = `${BASE_URL}${u.pathname}`
            break
          }
        } catch {
          // try next candidate
        }
      }
      if (!url) continue
      const id = idFromJobPath(new URL(url).pathname)!

      const title = firstText(chunk, /class="[^"]*result-card_hit__[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
        ?? firstText(chunk, /class="[^"]*result-card_role__[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)
      if (!title) continue

      const company = firstText(chunk, /class="[^"]*result-card_company__[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
      const posted = firstText(chunk, /class="[^"]*result-card_posted__[^"]*"[^>]*>([\s\S]*?)<\/span>/i)

      // Meta row: experience (briefcase), salary (rupee), location (pin).
      let experience: string | null = null
      let salary: string | null = null
      let location: string | null = null
      for (const item of chunk.split(/class="[^"]*result-card_meta-item__/).slice(1)) {
        const icon = item.match(/#result-card-icon-([a-zA-Z]+)/)?.[1]
        const text = firstText(item, /class="[^"]*result-card_meta-text__[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
        if (!text) continue
        if (icon === "briefcase") experience = text
        else if (icon === "rupee") salary = text
        else if (icon === "pin") location = text
      }

      const badges: string[] = []
      for (const b of chunk.matchAll(/class="[^"]*result-card_chip__[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)) {
        const t = clean(b[1])
        if (t) badges.push(t)
      }

      const skills: string[] = []
      // Each skill item is "<span item>[<span dot>·</span>]name</span>": drop
      // the decorative dot, then read up to the item's own closing tag.
      for (const piece of chunk.split(/<span[^>]*class="[^"]*result-card_skills-item__[^"]*"[^>]*>/i).slice(1)) {
        const body = piece.replace(/^\s*<span[^>]*result-card_skill-dot[^>]*>[\s\S]*?<\/span>/i, "")
        const t = clean(body.split(/<\/span>/i)[0]).replace(/^[·•]\s*/, "")
        if (t) skills.push(t)
      }

      const at = postedAt.get(id) ?? null
      results.push({
        id,
        title,
        company,
        location,
        date: at ? at.slice(0, 10) : null,
        postedAt: at,
        posted,
        experience,
        salary,
        skills,
        badges,
        url,
      })
    } catch {
      // one bad card must not break the others
      continue
    }
  }
  return results
}

/**
 * Approximate age in days from Shine's relative label ("today", "5 days ago",
 * "2 weeks ago", "1 month ago"). Used only when no absolute timestamp exists.
 */
export function relativeAgeDays(label: string | null): number | null {
  if (!label) return null
  const t = label.toLowerCase()
  if (/just now|today|hour|minute|second/.test(t)) return 0
  if (/yesterday/.test(t)) return 1
  const m = t.match(/(\d+|an?)\s+(day|week|month|year)s?\s+ago/)
  if (!m) return null
  const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 1
  const unit = { day: 1, week: 7, month: 30, year: 365 }[m[2] as "day" | "week" | "month" | "year"]
  return n * unit
}

/** Age of a card in days: absolute timestamp first, relative label second. */
export function cardAgeDays(card: JobCard, now: Date = new Date(), renderedAt: string | null = null): number | null {
  if (card.postedAt) {
    const t = Date.parse(card.postedAt)
    if (!Number.isNaN(t)) return Math.max(0, (now.getTime() - t) / 86400000)
  }
  const rel = relativeAgeDays(card.posted)
  if (rel === null) return null
  // The label is relative to when the page was rendered, which can be weeks ago.
  const r = renderedAt ? Date.parse(renderedAt) : NaN
  const snapshotAge = Number.isNaN(r) ? 0 : Math.max(0, (now.getTime() - r) / 86400000)
  return rel + snapshotAge
}

// ---------------------------------------------------------------------------
// Detail page parsing
// ---------------------------------------------------------------------------

export interface JobDetail {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  postedAt: string | null
  validThrough: string | null
  expired: boolean | null
  experience: string | null
  salary: string | null
  employmentType: string | null
  industry: string | null
  category: string | null
  skills: string[]
  description: string | null
  url: string
}

type Json = Record<string, unknown>

/** The first schema.org JobPosting JSON-LD object on the page, or null. */
export function findJobPostingLd(html: string): Json | null {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]) as unknown
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        if (item && typeof item === "object" && (item as Json)["@type"] === "JobPosting") return item as Json
      }
    } catch {
      // ignore a malformed block
    }
  }
  return null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

export function parseJobDetail(html: string, id: string): JobDetail {
  const ld = findJobPostingLd(html)
  const page = visibleHtml(html)

  const title =
    firstText(page, /<h1[^>]*class="[^"]*role-overview-card_title__[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ??
    (str(ld?.title) ? clean(str(ld?.title)!) : null)

  const org = ld?.hiringOrganization as Json | undefined
  const company =
    firstText(page, /class="[^"]*role-overview-card_companyName__[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ??
    (str(org?.name) ? clean(str(org?.name)!) : null)

  // Role card meta row: Location / Experience / Salary / Type.
  const meta: Record<string, string> = {}
  for (const item of page.split(/class="[^"]*role-overview-card_metaItem__/).slice(1)) {
    const label = firstText(item, /class="[^"]*role-overview-card_metaLabel__[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    const value = firstText(item, /class="[^"]*role-overview-card_metaValue__[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/i)
    if (label && value) meta[label.toLowerCase()] = value
  }

  let location: string | null = meta["location"] ?? null
  if (!location && Array.isArray(ld?.jobLocation)) {
    const names = (ld!.jobLocation as Json[])
      .map((p) => str((p?.address as Json | undefined)?.addressLocality))
      .filter((s): s is string => !!s)
    location = names.length ? names.join(", ") : null
  }

  const timeAttr = page.match(/class="[^"]*role-overview-card_bylinePosted__[^"]*"[\s\S]*?<time[^>]*dateTime="([^"]+)"/i)?.[1]
  const ldPosted = str(ld?.datePosted)
  let postedAt: string | null = null
  if (ldPosted && /^\d{4}-\d{2}-\d{2}/.test(ldPosted)) postedAt = ldPosted
  else if (timeAttr && ISO_LOCAL.test(timeAttr)) postedAt = `${timeAttr}+05:30`

  const validThrough = str(ld?.validThrough)
  let expired: boolean | null = null
  if (validThrough) {
    const t = Date.parse(validThrough)
    if (!Number.isNaN(t)) expired = t < Date.now()
  }

  // Visible job description first (<pre class="collapsible-jd-body_body__">);
  // JSON-LD description only as a fallback.
  let description: string | null = null
  const pre = page.match(/<pre[^>]*class="[^"]*collapsible-jd-body_body__[^"]*"[^>]*>([\s\S]*?)<\/pre>/i)?.[1]
  if (pre) description = cleanDescription(pre)
  if (!description && str(ld?.description)) description = cleanDescription(str(ld?.description)!)

  let skills: string[] = []
  if (Array.isArray(ld?.skills)) {
    skills = (ld!.skills as unknown[]).map((s) => (typeof s === "string" ? clean(s) : "")).filter(Boolean)
  }
  if (!skills.length) {
    for (const s of page.matchAll(/class="[^"]*skills-list_skill__[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const t = clean(s[1])
      if (t) skills.push(t)
    }
  }

  const category = Array.isArray(ld?.occupationalCategory)
    ? (ld!.occupationalCategory as unknown[]).filter((c): c is string => typeof c === "string").map(clean).join(", ") || null
    : str(ld?.occupationalCategory)

  const canonical = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1]
  let url = `${BASE_URL}/jobs/job/company/${id}`
  if (canonical) {
    try {
      const u = new URL(decodeHtmlEntities(canonical))
      if (SHINE_HOST.test(u.hostname) && idFromJobPath(u.pathname) === id) url = `${BASE_URL}${u.pathname}`
    } catch {
      // keep the constructed URL
    }
  }

  const ldType = str(ld?.employmentType)
  return {
    id,
    title: title ?? "(untitled)",
    company,
    location,
    date: postedAt ? postedAt.slice(0, 10) : null,
    postedAt,
    validThrough,
    expired,
    experience: meta["experience"] ?? null,
    salary: meta["salary"] ?? null,
    employmentType: meta["type"] ?? (ldType ? ldType.replace(/_/g, " ").toLowerCase() : null),
    industry: str(ld?.industry) ? clean(str(ld?.industry)!) : null,
    category,
    skills,
    description,
    url,
  }
}
