// Data source: Hacker News' monthly "Ask HN: Who is hiring?" threads (posted by
// the `whoishiring` account), read through two official public JSON APIs:
//   - Algolia HN Search (hn.algolia.com/api/v1) for finding threads and
//     searching the top-level comments (= job posts) inside them;
//   - the HN Firebase API (hacker-news.firebaseio.com/v0) for one item's detail.
// No authentication. Comment bodies are HTML, so they go through visibleHtml +
// stripInvisible before anything reaches the output.

export const ALGOLIA_URL = "https://hn.algolia.com/api/v1"
export const FIREBASE_URL = "https://hacker-news.firebaseio.com/v0"
export const ITEM_URL = "https://news.ycombinator.com/item?id="

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "Mozilla/5.0 (compatible; hn-hiring-cli/1.0)"

/**
 * Fetch JSON with exponential backoff + jitter on 429/5xx (max 6 retries).
 * Returns null on a 404 (and Firebase answers a missing item with a literal
 * `null` body, which parses to null too).
 */
export async function jsonFetch<T = unknown>(url: string): Promise<T | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
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
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Response from ${new URL(url).host} was not valid JSON`)
    }
  }
  throw new Error("Request failed after max retries")
}

// ---------------------------------------------------------------------------
// HTML / text hygiene (visibleHtml + stripInvisible copied from linkedin-search)
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
 * blocks, and elements marked hidden - before tags are stripped. HN's comment
 * sanitizer already removes most of this, but the bodies are third-party HTML,
 * so the contract's hygiene step runs regardless.
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

/** Every <a href> in a comment, decoded, in document order. */
export function extractLinks(html: string): string[] {
  const links: string[] = []
  for (const m of visibleHtml(html).matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)) {
    const href = decodeHtmlEntities(m[1]).trim()
    if (/^https?:\/\//i.test(href) && !links.includes(href)) links.push(href)
  }
  return links
}

/**
 * Convert an HN comment's HTML to readable plain text. HN separates paragraphs
 * with <p> (newer comments also carry raw newlines), and truncates long link
 * text with "...", so an anchor is replaced by its full href.
 */
export function htmlToText(html: string): string {
  const text = visibleHtml(html)
    .replace(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>[\s\S]*?<\/a\s*>/gi, (_, href: string) => ` ${href} `)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/?\s*p\b[^>]*>/gi, "\n\n")
    .replace(/<\/(pre|li|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
  return decodeHtmlEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

export interface HeaderSplit {
  /** The header: the first line, or a short one-field-per-line block joined with " | ". */
  header: string
  /** The next line of the first paragraph, if the header used only the first line. */
  secondLine: string | null
  /** Everything after the header, as plain text. */
  body: string
}

/** Split a comment into its header block and body text. */
export function splitComment(html: string): HeaderSplit {
  const text = htmlToText(html)
  const lines = text.split("\n")
  const firstLines: string[] = []
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  while (i < lines.length && lines[i].trim()) firstLines.push(lines[i++].trim())
  if (firstLines.length === 0) return { header: "", secondLine: null, body: "" }
  const after = lines.slice(i).join("\n").trim()
  // A header written one field per line ("DevOps Engineer / Hybrid / Hong Kong /
  // Full-time", each on its own line) is joined into the pipe form when every
  // line is short and the first line has no pipe.
  if (!firstLines[0].includes("|") && firstLines.length >= 2 && firstLines.length <= 6 && firstLines.every((l) => l.length <= 60)) {
    return { header: firstLines.join(" | "), secondLine: null, body: after }
  }
  return {
    header: firstLines[0],
    secondLine: firstLines[1] ?? null,
    body: [firstLines.slice(1).join("\n"), after].join("\n\n").trim(),
  }
}

/** The header line of a comment (see splitComment). */
export function extractHeader(html: string): string {
  return splitComment(html).header
}

const URL_SEG = /^(?:https?:\/\/\S+|www\.\S+)$/i
const DOMAIN_SEG = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?$/i
const WORK_MODE = /\b(?:remote|on-?\s?site|onsite|hybrid|in[- ]office|in[- ]person|wfh|work from home|distributed)\b/i
const PEOPLE_ROLE = /\b(?:engineers?|developers?|scientists?|designers?|managers?|architects?|researchers?|programmers?)\b/i
const ROLE =
  /\b(?:engineers?|engineering|developers?|(?<![./])devs?|scientists?|designers?|managers?|leads?|architects?|researchers?|programmers?|analysts?|consultants?|specialists?|administrators?|admins?|executives?|marketers?|recruiters?|strategists?|founding|staff|principal|head of|director|vp|cto|coo|cfo|ciso|swe|sre|sdet|fde|pm|gtm|devops|mlops|qa|data science|technical|member of technical staff|interns?|multiple roles|multiple positions|multiple engineering|all roles|several roles|openings|positions|roles)\b/i
const SALARY =
  /[$€£₹¥]\s?\d|\b\d+(?:[.,]\d+)?\s?[kK]\b|\b\d{2,3},\d{3}\b|\b(?:usd|eur|gbp|inr|chf|cad|aud)\b|\bequity\b|\bsalary\b|\bstipend\b|\bcompensation\b|\/\s?(?:hr|hour|month|year)\b|\bper (?:hour|month|year)\b|\bcommission\b/i
const EMPLOYMENT =
  /\b(full[- ]?time|fulltime|part[- ]?time|contract(?:or)?|internships?|interns?|freelance|fractional|permanent|temporary|temp-to-hire|1099|w-?2)\b/gi
const GEO_WORDS = [
  // regions / countries
  "us", "u\\.s\\.?", "usa", "united states", "america", "americas", "north america", "south america", "latin america", "latam",
  "canada", "mexico", "brazil", "argentina", "colombia", "chile", "uk", "u\\.k\\.", "united kingdom", "england", "scotland",
  "ireland", "eu", "eea", "europe", "emea", "germany", "france", "spain", "portugal", "italy", "netherlands", "belgium",
  "switzerland", "austria", "poland", "czech republic", "czechia", "sweden", "norway", "denmark", "finland", "estonia",
  "lithuania", "latvia", "romania", "greece", "turkey", "israel", "uae", "dubai", "saudi arabia", "qatar", "egypt",
  "nigeria", "kenya", "south africa", "africa", "india", "pakistan", "bangladesh", "sri lanka", "nepal", "singapore",
  "malaysia", "indonesia", "philippines", "vietnam", "thailand", "japan", "korea", "china", "hong kong", "taiwan",
  "australia", "new zealand", "apac", "asia", "worldwide", "global", "anywhere", "international",
  // cities / metros commonly seen in these threads
  "nyc", "new york", "sf", "san francisco", "bay area", "sf bay", "silicon valley", "los angeles", "seattle", "boston",
  "austin", "chicago", "denver", "atlanta", "miami", "washington", "dc", "toronto", "vancouver", "montreal", "london",
  "berlin", "munich", "hamburg", "paris", "amsterdam", "stockholm", "zurich", "dublin", "barcelona", "madrid", "lisbon",
  "tel aviv", "tokyo", "sydney", "melbourne", "bangalore", "bengaluru", "hyderabad", "pune", "chennai", "mumbai",
  "delhi", "new delhi", "gurgaon", "gurugram", "noida", "kolkata",
  // time zones
  "cet", "cest", "gmt", "utc", "est", "edt", "pst", "pdt", "cst", "et", "pt", "bst", "eastern", "pacific", "central",
]
const GEO = new RegExp(`\\b(?:${GEO_WORDS.join("|")})\\b`, "i")
/** "City, ST" shape (US state / Canadian province / country code); "City, Country" is caught by GEO. */
const CITY_REGION = /\b[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)*,\s*[A-Z]{2}\b/
/** A whole field shaped "Place, Place" that names a known geography ("Cologne, Germany"). */
const PLACE_PAIR = /^[A-Z][\p{L}.' -]+,\s*[A-Z][\p{L}.' -]+$/u

export interface ParsedHeader {
  company: string | null
  title: string | null
  location: string | null
  remote: boolean | null
  work_mode: string[]
  salary: string | null
  employment_type: string | null
}

function cleanCompany(seg: string): string | null {
  let s = seg
    .replace(/\(\s*(?:https?:\/\/|www\.)[^)]*\)/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/:?\s*(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/^[*_\s]+|[*_\s:,-]+$/g, "")
    .replace(/\s+is hiring\b.*$/i, "")
    .trim()
  if (!s) return null
  // A sentence, not a company name.
  if (s.length > 60 || s.split(/\s+/).length > 8) return null
  if (/^(?:i'm|i am|we are|we're|hi|hello|hey|backed by|location:|apply|looking|seeking)\b/i.test(s)) return null
  return s
}

function cleanTitle(seg: string): string {
  return seg
    .replace(/^[*_\s]+|[*_\s]+$/g, "")
    .replace(/^(?:roles?|positions?|hiring|now hiring|open roles?)\s*:?\s+/i, "")
    .trim()
    .slice(0, 160)
}

function isWorkMode(seg: string): boolean {
  return WORK_MODE.test(seg)
}

/** A work-mode field with nothing else in it ("REMOTE", "Fully Remote", "Hybrid", "100% remote"). */
function isPureMode(seg: string): boolean {
  const rest = seg
    .replace(/\b(?:remote|on-?\s?site|onsite|hybrid|in[- ]office|in[- ]person|wfh|work from home|distributed)\b/gi, "")
    .replace(/\b(?:fully|full|100%|first|friendly|only|ok|possible|and|or|also|available|role|roles|position|positions)\b/gi, "")
    .replace(/[^\p{L}\d]+/gu, "")
  return rest.length === 0
}

function isGeo(seg: string): boolean {
  return GEO.test(seg) || CITY_REGION.test(seg)
}

/**
 * Body text that ran into the header line ("| REMOTE (US/UK/India) Full-time AI
 * Risk platform that helps ...", "| Zed is a company for ..."). A long field is
 * cut after its first parenthetical when that comes early, otherwise dropped
 * ("" = not a field).
 */
function trimRunOn(seg: string): string {
  if (seg.split(/\s+/).length <= 14) return seg.slice(0, 160)
  const close = seg.indexOf(")")
  return close > 0 && close <= 80 ? seg.slice(0, close + 1) : ""
}

/** Split a header into its fields: on `|`, or on spaced dashes/bullets when there is no pipe. */
export function splitHeader(header: string): string[] {
  let parts = header.split("|")
  if (parts.length < 2) parts = header.split(/\s+[—–-]\s+|\s+•\s+/)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Work modes the header mentions (remote / hybrid / onsite). */
export function workModes(header: string): string[] {
  const modes: string[] = []
  if (mentionsRemote(header)) modes.push("remote")
  if (/\bhybrid\b/i.test(header)) modes.push("hybrid")
  if (/\b(?:on-?\s?site|onsite|in[- ]office|in[- ]person|work-from-office)\b/i.test(header)) modes.push("onsite")
  return modes
}

/** Whether the header mentions remote work (and does not negate it). */
export function mentionsRemote(header: string): boolean {
  if (/\b(?:no|not|non)[- ]remote\b|\bremote\s*:\s*no\b/i.test(header)) return false
  return /\bremote\b|\bwfh\b|\bwork from home\b|\bfully distributed\b/i.test(header)
}

/**
 * Heuristic header parse. Conservative: a field the heuristics cannot place
 * confidently stays null, and the raw header is always kept alongside.
 */
export function parseHeader(header: string, secondLine: string | null = null): ParsedHeader {
  const segs = splitHeader(header)
  const out: ParsedHeader = {
    company: null,
    title: null,
    location: null,
    remote: null,
    work_mode: workModes(header),
    salary: null,
    employment_type: null,
  }
  out.remote = out.work_mode.includes("remote") ? true : out.work_mode.length ? false : null

  const employment = new Set<string>()
  for (const m of header.matchAll(EMPLOYMENT)) {
    employment.add(
      m[1].toLowerCase()
        .replace(/^full[- ]?time$|^fulltime$/, "full-time")
        .replace(/^part[- ]?time$/, "part-time")
        .replace(/^interns?$|^internships?$/, "internship")
        .replace(/^contractor$/, "contract"),
    )
  }
  out.employment_type = employment.size ? [...employment].join(", ") : null

  if (segs.length === 0) return out
  // Prose (a sentence instead of a header): keep only the header-wide flags.
  if (segs.length === 1 && (segs[0].length > 100 || segs[0].split(/\s+/).length > 14)) return out

  const locations: string[] = []
  let rest = segs
  const first = segs[0]
  const firstIsLocation =
    !PEOPLE_ROLE.test(first) &&
    (isWorkMode(first) ||
      (first.split(/\s+/).length <= 4 && (CITY_REGION.test(first) || (PLACE_PAIR.test(first) && GEO.test(first)))) ||
      /^location\s*:/i.test(first))
  if (segs.length >= 2 && PEOPLE_ROLE.test(first) && !segs.slice(1).some((s) => PEOPLE_ROLE.test(s))) {
    // "Software Engineer — Remote — US Only": the first field is the role, no company given.
    out.title = cleanTitle(first)
    rest = segs.slice(1)
  } else if (segs.length === 1 && PEOPLE_ROLE.test(first)) {
    out.title = cleanTitle(first)
    rest = []
  } else if (firstIsLocation) {
    rest = segs.slice(1)
  } else if (URL_SEG.test(first)) {
    rest = segs.slice(1)
  } else {
    out.company = cleanCompany(first)
    rest = segs.slice(1)
  }

  const unclassified: string[] = []
  for (const raw of rest) {
    // A field that carries a link next to its text ("Full-time – https://x.dev/")
    // is classified on the text alone; the link itself is apply_url material.
    const seg = trimRunOn(raw.replace(/\s*[–—-]?\s*(?:https?:\/\/|www\.)\S+/gi, "").trim())
    if (!seg || URL_SEG.test(seg) || DOMAIN_SEG.test(seg)) continue
    if (isWorkMode(seg)) {
      // Keep the geography a work-mode field carries ("REMOTE (US)", "ONSITE Berlin").
      if (!isPureMode(seg)) locations.push(seg)
      continue
    }
    if (ROLE.test(seg) && !SALARY.test(seg.replace(/\b(?:equity|salary)\b/gi, ""))) {
      if (out.title === null && !/^(?:multiple locations|hiring)$/i.test(seg)) out.title = cleanTitle(seg)
      continue
    }
    if (SALARY.test(seg)) {
      if (out.salary === null) out.salary = seg.slice(0, 100)
      continue
    }
    if (new RegExp(EMPLOYMENT.source, "i").test(seg)) continue
    if (isGeo(seg)) {
      locations.push(seg)
      continue
    }
    unclassified.push(seg)
  }

  // "Cologne, Germany | UMH | ...": company sits in the first short unclassified field.
  if (out.company === null && firstIsLocation && unclassified.length && unclassified[0].split(/\s+/).length <= 4) {
    out.company = cleanCompany(unclassified[0])
  }
  if (firstIsLocation && !isWorkMode(first)) locations.unshift(first.replace(/^location\s*:\s*/i, ""))
  else if (firstIsLocation && !isPureMode(first)) locations.unshift(first)

  // "Taxnova | London | Hybrid\nFounding product engineer": title on the next line.
  if (out.title === null && secondLine && secondLine.length <= 60 && !secondLine.includes("|") && ROLE.test(secondLine)) {
    out.title = cleanTitle(secondLine)
  }

  if (locations.length) out.location = locations.join(" / ").slice(0, 160)
  else if (out.remote) out.location = "Remote"
  return out
}

// ---------------------------------------------------------------------------
// India-friendly heuristic
// ---------------------------------------------------------------------------

const INDIA_EXPLICIT =
  /\b(?:india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|new delhi|delhi|ncr|gurgaon|gurugram|noida|kolkata|ahmedabad|kochi|apac|asia[- ]pacific|asia)\b/i
/** "W Asia" / "West Asia" is the Middle East, not India-friendly. */
const WEST_ASIA = /\b(?:w\.?|west(?:ern)?)\s+asia\b/i
const INDIA_NEGATED = /\b(?:not|no|except|excluding|outside(?: of)?)\b[^|]{0,30}\b(?:india|apac|asia)\b/i
const GLOBAL =
  /\b(?:worldwide|world-wide|anywhere|any time ?zones?|all time ?zones?|globally|global remote|remote global|work from anywhere)\b|\bremote\s*\(\s*(?:global|world)\s*\)|\(\s*(?:global|world)\s*\)/i
/** Region/country restrictions that exclude India when they appear without an India mention. */
const RESTRICTION =
  /\b(?:us|u\.s\.?|usa|united states|americas?|north america|south america|latin america|latam|canada|can|mexico|brazil|eu|eea|europe(?:an)?|emea|uk|united kingdom|britain|germany|france|spain|netherlands|poland|switzerland|sweden|nordics|ireland|portugal|africa|australia|nz|japan|israel|cet|cest|gmt|utc|est|edt|pst|pdt|cst|et|pt|ct|mt|bst|wet|eet|eastern|pacific|central|time ?zones?|hours|overlap|citizens?|citizenship|clearance|clearable|work authori[sz]ation|eligib\w*|only|[a-z]+-based)\b/i
const TIMEZONE_NOTE = /\b(?:cet|cest|gmt|utc|est|edt|pst|pdt|cst|et|pt|bst|eastern|pacific|central|time ?zones?|hours|overlap)\b/i
/** Body phrases that restrict a remote role to a region (checked only for the weakest tier). */
const BODY_RESTRICTIONS = [
  /\b(?:us|u\.s\.|usa|united states|north america|eu|europe|uk|canada|latam)[- ](?:only|based|residents?|citizens?|persons?)\b/i,
  /\b(?:must|need to|needs to|required to|should)\s+(?:be\s+)?(?:located|based|resid(?:e|ing)|liv(?:e|ing))\s+in\b/i,
  /\bauthori[sz](?:ed|ation) to work in (?:the )?(?:us|u\.s\.|usa|united states|uk|eu|europe|canada)\b/i,
  /\b(?:us|u\.s\.|eu|european|uk|cet|est|pst|pacific|eastern|central)\s+(?:business\s+)?(?:time ?zones?|hours)\b/i,
  /\bonly (?:hire|hiring|considering|accepting)\b[^.]{0,40}\b(?:in|from)\b/i,
  /\bwithin (?:the )?(?:us|usa|united states|eu|europe|uk|canada)\b/i,
]

export interface IndiaVerdict {
  india_friendly: boolean
  india_reason: string | null
}

/**
 * Whether a posting looks open to a candidate in India (in India, or remote
 * without a region restriction). Conservative, three tiers, first match wins:
 *   1. "explicit": the header names India, an Indian city, APAC or Asia
 *      (not West Asia, not negated).
 *   2. "global":   the header says worldwide / anywhere / any timezone /
 *      Remote (Global), and that field does not list regions that leave India
 *      out ("Worldwide: US / Canada / Europe" is NOT global).
 *   3. "remote-unrestricted": the header mentions REMOTE and names no other
 *      geography at all (no country, region, city, "City, ST", timezone,
 *      citizenship or "-only"/"-based" wording), AND the body carries none of
 *      the common restriction phrases ("US-based", "must be located in",
 *      "authorized to work in the US", "EU time zones", ...). Weakest tier.
 * A timezone/overlap requirement on a matched posting is noted in the reason.
 */
export function indiaFriendly(header: string, bodyText = ""): IndiaVerdict {
  const segs = splitHeader(header)
  // Only fields that talk about place or work mode count for the timezone note.
  const placeText = segs
    .map(trimRunOn)
    .filter((s) => s && (isWorkMode(s) || isGeo(s) || GLOBAL.test(s)))
    .join(" | ")
    .replace(/\b(?:any|all) time ?zones?\b/gi, "")
  const tzNote = (reason: string) =>
    TIMEZONE_NOTE.test(placeText) ? `${reason}; timezone/hours requirement in header` : reason

  const headerNoWestAsia = header.replace(WEST_ASIA, "")
  if (INDIA_EXPLICIT.test(headerNoWestAsia) && !INDIA_NEGATED.test(header)) {
    return { india_friendly: true, india_reason: tzNote("explicit") }
  }

  for (const seg of segs) {
    if (!GLOBAL.test(seg)) continue
    const withoutGlobal = seg.replace(GLOBAL, "").replace(/\bremote\b/gi, "")
    const regionList = /\b(?:us|usa|canada|europe|eu|uk|latam|americas?|north america|south america|emea)\b/i
    if (regionList.test(withoutGlobal) && !/\b(?:time ?zones?|hours|overlap|preferred)\b/i.test(withoutGlobal)) {
      continue // "Worldwide: US / Canada / Europe / UK / LATAM" names its countries; India is not among them
    }
    return { india_friendly: true, india_reason: tzNote("global") }
  }

  if (mentionsRemote(header)) {
    const geoFree = header
      .replace(/\b(?:remote|full[- ]?time|part[- ]?time)\b/gi, "")
      .replace(/(?:https?:\/\/|www\.)\S+/gi, "")
    // Every field that mentions remote must be a bare remote marker: "Detroit
    // preferred; remote considered" names a place the geography lists miss.
    const bareRemote = segs
      .filter((s) => mentionsRemote(s))
      .every((s) => !/\b[A-Z][a-z]{2,}/.test(s.replace(/\b(?:remote|fully|full|first|friendly|only|possible|ok|work from home)\b/gi, "")))
    if (bareRemote && !RESTRICTION.test(geoFree) && !GEO.test(geoFree) && !CITY_REGION.test(geoFree)) {
      if (!BODY_RESTRICTIONS.some((re) => re.test(bodyText))) {
        return { india_friendly: true, india_reason: "remote-unrestricted" }
      }
    }
  }
  return { india_friendly: false, india_reason: null }
}

// ---------------------------------------------------------------------------
// Job post assembly
// ---------------------------------------------------------------------------

export interface AlgoliaHit {
  objectID: string
  comment_text?: string | null
  author?: string | null
  created_at?: string | null
  created_at_i?: number | null
  parent_id?: number | null
  story_id?: number | null
}

export interface JobPost {
  id: string
  title: string | null
  company: string | null
  location: string | null
  date: string | null
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
}

/**
 * Not a job post: a "Who wants to be hired" template posted in the wrong
 * thread, or a near-empty comment ("." / one word).
 */
export function isNonJobPost(text: string): boolean {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length < 40) return true
  // "Who wants to be hired?" template (Location: / Remote: / Willing to relocate: ...).
  if (/^location\s*:/i.test(flat) && /\bwilling to relocate\s*:/i.test(flat)) return true
  // A job seeker introducing themselves ("I'm <name>, a Full-Stack Engineer ...").
  const head = flat.slice(0, 300)
  if (/^(?:hi[,!.]?\s+)?(?:i'm|i am|my name is)\b/i.test(flat) && !head.includes("|") &&
      !/\b(?:hiring|we're|we are|our team|join us|join our)\b/i.test(head)) {
    return true
  }
  return false
}

export function buildJobPost(
  id: string,
  html: string,
  meta: { author?: string | null; createdAt?: string | null; threadId?: string | null; threadTitle?: string | null },
): JobPost {
  const { header, secondLine, body } = splitComment(html)
  const parsed = parseHeader(header, secondLine)
  const india = indiaFriendly(header, body)
  const links = extractLinks(html)
  const flat = body.replace(/\s+/g, " ").trim()
  return {
    id,
    title: parsed.title,
    company: parsed.company,
    location: parsed.location,
    date: meta.createdAt ? meta.createdAt.slice(0, 10) : null,
    url: `${ITEM_URL}${id}`,
    apply_url: links[0] ?? null,
    remote: parsed.remote,
    work_mode: parsed.work_mode,
    salary: parsed.salary,
    employment_type: parsed.employment_type,
    india_friendly: india.india_friendly,
    india_reason: india.india_reason,
    header,
    snippet: flat ? (flat.length > 280 ? flat.slice(0, 277) + "..." : flat) : null,
    author: meta.author ?? null,
    thread_id: meta.threadId ?? null,
    thread_title: meta.threadTitle ?? null,
  }
}

/** Is this thread title a monthly "Who is hiring?" thread (not "wants to be hired" / "Freelancer")? */
export function isHiringThreadTitle(title: string | null | undefined): boolean {
  return !!title && /^ask hn:\s*who is hiring\?/i.test(title.trim())
}
