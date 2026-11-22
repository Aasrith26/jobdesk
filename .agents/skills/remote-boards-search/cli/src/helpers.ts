// Shared plumbing for the remote-boards CLI: fetch with backoff, error writer,
// HTML/RSS/JSON-LD parsing, output hygiene, and the location-restriction
// heuristics behind --india-friendly. Zero runtime dependencies: plain `fetch`
// and regex parsing, like linkedin-search.

export const UA = "Mozilla/5.0 (compatible; remote-boards-cli/1.0)"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export function writeWarning(warning: string, code: string): void {
  process.stderr.write(JSON.stringify({ warning, code }) + "\n")
}

/** An HTTP failure carrying its status, so callers can tell 4xx from transport errors. */
export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

export interface FetchOpts {
  accept?: string
  /** Per-attempt timeout. */
  timeoutMs?: number
  maxRetries?: number
}

/**
 * GET a URL as text with exponential backoff and jitter on 429/5xx (max 6
 * retries). Returns "" on a 404 rather than throwing. Every attempt carries an
 * AbortSignal timeout so a stalled upstream cannot hang the CLI.
 */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const maxRetries = opts.maxRetries ?? 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: opts.accept ?? "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new HttpError(`Request failed: ${response.status} ${response.statusText}`.trim(), response.status)
      }
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((r) => setTimeout(r, delay + jitter))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return ""
    if (!response.ok) {
      throw new HttpError(`Request failed: ${response.status} ${response.statusText}`.trim(), response.status)
    }
    return response.text()
  }
  throw new Error("Request failed after max retries")
}

/** GET and parse JSON. A 404 yields null. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  const text = await fetchText(url, opts)
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Response from ${new URL(url).hostname} was not valid JSON`)
  }
}

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", times: "×", laquo: "«", raquo: "»",
}

/** Decode named and numeric HTML entities in one pass (so `&amp;lt;` decodes once, to `&lt;`). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      return body[1] === "x" || body[1] === "X"
        ? numericEntity(parseInt(body.slice(2), 16))
        : numericEntity(parseInt(body.slice(1), 10))
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Characters a reader of the posting never sees but a model reading this
 * output does: C0/C1 controls other than tab, newline and carriage return, the
 * soft hyphen, bidi marks/embeddings/overrides/isolates, zero-width characters
 * and invisible operators, the BOM, variation selectors, and Unicode tag
 * characters (U+E0000-E007F), which can spell out a whole hidden instruction.
 * (Same set as linkedin-search's helpers.ts, written with escapes.)
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
 * hidden - before tags are stripped. Copied from linkedin-search. CSS-only
 * tricks (off-screen, zero font size) need a renderer and are not caught here.
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

/** One-line plain text from an HTML fragment (titles, names). */
export function cleanInline(html: string | null | undefined): string {
  if (!html) return ""
  return decodeHtmlEntities(visibleHtml(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Readable multi-line text from an HTML description: hidden markup removed
 * first (a hidden element can span line breaks), block ends and <br> become
 * newlines, list items get a bullet, then tags are stripped line by line.
 */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = visibleHtml(html)
    .replace(/\s+/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|ul|ol|div|h\d|tr|blockquote|section)>/gi, "\n")
    .replace(/<(p|ul|ol|h\d|div|section|blockquote)\b[^>]*>/gi, "\n")
  const text = withBreaks
    .split("\n")
    .map((line) => decodeHtmlEntities(line.replace(/<[^>]+>/g, " ")).replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

/**
 * Repair UTF-8 that was decoded as Latin-1 somewhere upstream ("EspaÃ±a" ->
 * "España"). Remote OK serves some fields this way. Only applied when the
 * string looks double-encoded and re-decoding yields valid UTF-8.
 */
export function fixMojibake(s: string): string {
  if (!/[Â-ô][\u0080-¿]/.test(s)) return s
  if (/[^\u0000-ÿ]/.test(s)) return s
  const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0))
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return s
  }
}

/** First `max` characters of a plain-text description, cut at a word boundary. */
export function snippet(text: string | null, max = 280): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const sp = cut.lastIndexOf(" ")
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + "…"
}

// ---------------------------------------------------------------------------
// Dates and salary
// ---------------------------------------------------------------------------

/** Any date-ish input (ISO string, RFC-822 string, unix seconds) -> YYYY-MM-DD (UTC), or null. */
export function toIsoDate(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined || input === "") return null
  let d: Date
  if (typeof input === "number") {
    d = new Date(input < 1e12 ? input * 1000 : input)
  } else if (/^\d{9,13}$/.test(input.trim())) {
    const n = Number(input.trim())
    d = new Date(n < 1e12 ? n * 1000 : n)
  } else {
    d = new Date(input)
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

const PERIOD: Record<string, string> = {
  annual: "year", yearly: "year", year: "year", annually: "year",
  monthly: "month", month: "month", weekly: "week", week: "week",
  fortnightly: "fortnight", hourly: "hour", hour: "hour", daily: "day", day: "day",
}

/** "USD 90000–120000/year"; null when neither bound is a positive number. */
export function formatSalary(
  min: unknown,
  max: unknown,
  currency?: string | null,
  period?: string | null,
): string | null {
  const lo = typeof min === "number" && min > 0 ? min : typeof min === "string" && Number(min) > 0 ? Number(min) : null
  const hi = typeof max === "number" && max > 0 ? max : typeof max === "string" && Number(max) > 0 ? Number(max) : null
  if (lo === null && hi === null) return null
  const range = lo !== null && hi !== null && lo !== hi ? `${lo}–${hi}` : String(lo ?? hi)
  const per = period ? PERIOD[period.toLowerCase()] ?? period.toLowerCase() : null
  return `${currency ? currency + " " : ""}${range}${per ? "/" + per : ""}`
}

// ---------------------------------------------------------------------------
// RSS and JSON-LD
// ---------------------------------------------------------------------------

export interface RssItem {
  title: string | null
  link: string | null
  guid: string | null
  pubDate: string | null
  description: string | null // HTML, entity-decoded once (RSS escapes the markup)
  fields: Record<string, string> // every other simple child element, raw text
}

/** Text of one child element, unwrapping CDATA; entity-decoded once. */
function rssField(chunk: string, tag: string): string | null {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = chunk.match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`, "i"))
  if (!m) return null
  const raw = m[1].trim()
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  return cdata ? cdata[1] : decodeHtmlEntities(raw)
}

/**
 * Parse an RSS 2.0 feed by splitting on <item> and reading each chunk on its
 * own, so one malformed item cannot break the rest (the same chunking idea as
 * linkedin-search's parseJobCards).
 */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = []
  for (const part of xml.split(/<item(?:\s[^>]*)?>/i).slice(1)) {
    const end = part.search(/<\/item>/i)
    const chunk = end === -1 ? part : part.slice(0, end)
    const fields: Record<string, string> = {}
    for (const m of chunk.matchAll(/<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>([^<]*(?:<!\[CDATA\[[\s\S]*?\]\]>)?[^<]*)<\/\1>/g)) {
      if (!(m[1] in fields)) fields[m[1]] = m[2].trim()
    }
    const title = rssField(chunk, "title")
    if (!title) continue
    items.push({
      title,
      link: rssField(chunk, "link"),
      guid: rssField(chunk, "guid"),
      pubDate: rssField(chunk, "pubDate"),
      description: rssField(chunk, "description"),
      fields,
    })
  }
  return items
}

/**
 * JSON.parse that tolerates raw control characters inside string literals
 * (We Work Remotely's JSON-LD carries literal newlines in "description").
 */
export function lenientJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    let out = ""
    let inStr = false
    let escaped = false
    for (const ch of text) {
      if (inStr) {
        if (escaped) {
          escaped = false
          out += ch
        } else if (ch === "\\") {
          escaped = true
          out += ch
        } else if (ch === '"') {
          inStr = false
          out += ch
        } else if (ch === "\n") out += "\\n"
        else if (ch === "\r") out += "\\r"
        else if (ch === "\t") out += "\\t"
        else if (ch.charCodeAt(0) < 0x20) out += " "
        else out += ch
      } else {
        if (ch === '"') inStr = true
        out += ch
      }
    }
    return JSON.parse(out)
  }
}

/** The first schema.org JobPosting object in a page's ld+json blocks, or null. */
export function extractJobPosting(html: string): Record<string, unknown> | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    let data: unknown
    try {
      data = lenientJsonParse(m[1].trim())
    } catch {
      continue
    }
    const stack: unknown[] = [data]
    while (stack.length) {
      const node = stack.pop()
      if (Array.isArray(node)) stack.push(...node)
      else if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>
        const type = obj["@type"]
        if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return obj
        if (Array.isArray(obj["@graph"])) stack.push(...(obj["@graph"] as unknown[]))
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Location-restriction heuristics (--india-friendly)
// ---------------------------------------------------------------------------

export type Eligibility = "friendly" | "restricted"

// A token that, standing alone, opens a role to candidates in India.
const FRIENDLY_TOKEN =
  /\b(world ?wide|anywhere|global(ly)?|international|apac|asia|asia[- ]pacific|south asia|india|indian|ist|remote)\b/i

// Phrases that scope "anywhere"/"remote" to somewhere that excludes India:
// "Anywhere in the US", "Remote - USA", "Remote (Europe)", "Global (EU timezones)".
const SCOPED_PLACE =
  /\b(us|u\.s\.?a?\.?|usa|united states|america|americas|north america|latam|latin america|canada|uk|u\.k\.|united kingdom|britain|europe|european|eu|eea|emea|cet|cest|gmt|bst|est|edt|cst|pst|pdt|mst|et|pt|ct|africa|middle east|mena|australia|anz|new zealand|germany|france|spain|brazil|mexico|argentina|poland|netherlands)\b/i

const INDIA_PLACE = /\b(india|indian|apac|asia|asia[- ]pacific|south asia|ist)\b/i

// Standard UTC offsets of abbreviations job boards use in "<TZ> (+/- N hours)".
const TZ_OFFSETS: Record<string, number> = {
  utc: 0, gmt: 0, wet: 0, cet: 1, eet: 2, msk: 3, gst: 4, pkt: 5, ist: 5.5, sgt: 8, cst_cn: 8,
  hkt: 8, jst: 9, aest: 10, nzst: 12, est: -5, et: -5, cst: -6, ct: -6, mst: -7, mt: -7,
  pst: -8, pt: -8, akst: -9, hst: -10, brt: -3, art: -3,
}
const INDIA_OFFSET = 5.5

/**
 * "CET (+/- 3 hours)" / "Time zone: EST +/- 2h" / "UTC+5:30 ± 4" -> whether
 * India (UTC+5:30) falls inside the window. Null when no window is stated.
 */
export function timezoneWindowIncludesIndia(text: string): boolean | null {
  const m = text.match(
    /\b(utc|gmt|[a-z]{2,4})\s*([+\-−]\s*\d{1,2}(?::(\d{2}))?)?\s*\(?\s*(?:\+\/-|\+-|±|plus or minus|\+\s*\/\s*-)\s*(\d{1,2}(?:\.\d)?)\s*(?:h|hrs?|hours?)?\)?/i,
  )
  if (!m) return null
  const abbr = m[1].toLowerCase()
  let base = TZ_OFFSETS[abbr]
  if (base === undefined) return null
  if (m[2]) {
    const sign = /[-−]/.test(m[2]) ? -1 : 1
    const num = m[2].replace(/[^\d:]/g, "")
    const [h, mm] = num.split(":")
    base += sign * (Number(h) + (mm ? Number(mm) / 60 : 0))
  }
  const width = Number(m[4])
  return Math.abs(INDIA_OFFSET - base) <= width
}

/**
 * Classify a free-text candidate-location restriction. Conservative: India,
 * APAC/Asia, Worldwide/Anywhere/Global or an unspecified restriction is
 * "friendly"; anything that names only other places is "restricted", and so is
 * "anywhere"/"remote" scoped to such a place ("Anywhere in the US").
 */
export function classifyRegion(region: string | null | undefined): Eligibility {
  const text = (region ?? "").trim()
  if (!text) return "friendly" // unspecified

  const tz = timezoneWindowIncludesIndia(text)
  if (tz !== null) return tz ? "friendly" : "restricted"

  if (INDIA_PLACE.test(text)) return "friendly"

  // Explicit "<place> only" anywhere in the string restricts the whole thing.
  if (/\bonly\b/i.test(text) && SCOPED_PLACE.test(text)) return "restricted"

  // Split into alternatives and require one to be an unscoped friendly token.
  const tokens = text.split(/\s*(?:,|;|\||\/|\bor\b|\band\b|\+|&)\s*/i).filter(Boolean)
  for (const tok of tokens) {
    if (!FRIENDLY_TOKEN.test(tok)) continue
    if (SCOPED_PLACE.test(tok)) continue // "Remote - US", "Anywhere in Europe"
    // A bare "Remote" says nothing about where; "Japan - Remote" does, so a
    // remote token counts only when nothing else is in it.
    if (!/\b(world ?wide|anywhere|global(ly)?|international)\b/i.test(tok)) {
      const rest = tok.replace(/\b(remote|fully|work from home|wfh|only)\b|100%|[-–—()[\]:.%]/gi, "").trim()
      if (rest) continue
    }
    return "friendly"
  }
  return "restricted"
}

/**
 * Phrases in a description that restrict a role the board labels worldwide /
 * unspecified: residency or work-authorization requirements for a non-India
 * place, or a fixed number of office days. Returns the matched phrase, or null.
 * Deliberately narrow: generic EEO boilerplate ("we hire globally", "equal
 * opportunity employer in the US") is not matched.
 */
const DESCRIPTION_RESTRICTIONS: RegExp[] = [
  /\b(?:must|should|need to|required to)\s+(?:currently\s+)?(?:be\s+)?(?:reside|residing|live|living|be located|located|be based|based|be a resident)\s+(?:in|within)\s+(?:the\s+)?(?:us|u\.s\.?|usa|united states|canada|uk|united kingdom|eu|european union|europe|eea|latam|latin america|north america)\b/i,
  /\b(?:candidates|applicants)\s+(?:must\s+be\s+)?(?:located|based|residing)\s+in\s+(?:the\s+)?(?:us|u\.s\.?|usa|united states|canada|uk|united kingdom|eu|europe|latam|north america)\s+only\b/i,
  /\b(?:only\s+(?:open\s+to|accepting|considering|hiring))\s+(?:candidates|applicants|people|residents)?\s*(?:who\s+(?:are|live)\s+)?(?:in|from|based in|located in|residing in)\s+(?:the\s+)?(?:us|u\.s\.?|usa|united states|canada|uk|united kingdom|eu|europe|latam|north america)\b/i,
  /\b(?:us|u\.s\.?|usa|united states|uk|eu|europe|canada)[- ]based\s+(?:candidates|applicants|only)\b/i,
  /\b(?:must\s+(?:be|have)|requires?|required)\s+(?:legally\s+)?(?:authori[sz]ed|eligible|authori[sz]ation)\s+to\s+work\s+in\s+(?:the\s+)?(?:us|u\.s\.?|usa|united states|uk|united kingdom|eu|european union|canada)\b/i,
  /\b(?:us|u\.s\.?)\s+citizenship\s+(?:is\s+)?required\b|\bmust\s+be\s+a\s+(?:us|u\.s\.?)\s+citizen\b/i,
  /\b(?:on-?site|in[- ](?:the[- ])?office|in[- ]person)\b[^.]{0,40}?\b(?:\d|one|two|three|four|five)\s+days?\s+(?:a|per|each)\s+week\b/i,
]

export function descriptionRestriction(text: string | null | undefined): string | null {
  if (!text) return null
  for (const re of DESCRIPTION_RESTRICTIONS) {
    const m = text.match(re)
    if (m) return m[0].replace(/\s+/g, " ").trim()
  }
  return null
}

// Titles that pin a "worldwide" posting to a non-India market: "Senior AI
// Engineer - EU", "Customer Success Engineer (Singapore)", "Account Executive,
// US East". Upper-case abbreviations are matched case-sensitively so ordinary
// words ("us", "na") are not read as places.
const TITLE_ABBR = /(?<![A-Za-z])(US|USA|U\.S\.A?\.?|EU|UK|EMEA|LATAM|AMER|AMERICAS|NA|NORAM|DACH|ANZ|CET|EST|PST|CST)(?![A-Za-z])/
const TITLE_PLACE =
  /\b(united states|canada|europe|european|north america|latin america|americas|germany|france|spain|italy|brazil|mexico|argentina|colombia|united kingdom|australia|new zealand|singapore|japan|poland|netherlands|portugal|ireland|nordics?|benelux|us east|us west)\b/i
const TITLE_OPEN = /\b(india|apac|asia|global|worldwide|anywhere|international)\b/i

/** The title fragment that restricts a posting to a non-India market, or null. */
export function titleRestriction(title: string | null | undefined): string | null {
  if (!title || TITLE_OPEN.test(title)) return null
  const m = title.match(TITLE_ABBR) ?? title.match(TITLE_PLACE)
  return m ? m[0] : null
}
