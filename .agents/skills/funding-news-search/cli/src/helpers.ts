// Data source: public RSS feeds of startup-funding news (India-focused plus
// global). Feeds are fetched with an honest User-Agent, only where the site's
// robots.txt allows it, and parsed with plain regexes (zero runtime
// dependencies). Headlines and descriptions are third-party HTML, so they go
// through visibleHtml + stripInvisible before anything reaches the output.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const UA = "ai-job-search-funding-news-cli/1.0"
/** The product token matched against robots.txt User-agent lines. */
export const UA_TOKEN = "ai-job-search-funding-news-cli"

export interface FeedDef {
  name: string
  url: string
  /** Every item in this feed is funding-tagged by the publisher (counts as funding context). */
  fundingFeed: boolean
}

/** Verified live 2026-11-11 (HTTP 200, valid RSS 2.0, fresh items); see url-reference.md. */
export const DEFAULT_FEEDS: FeedDef[] = [
  { name: "Inc42", url: "https://inc42.com/buzz/feed/", fundingFeed: false },
  { name: "Entrackr", url: "https://entrackr.com/rss", fundingFeed: false },
  { name: "YourStory", url: "https://yourstory.com/tag/funding/feed", fundingFeed: true },
  { name: "TechCrunch Venture", url: "https://techcrunch.com/category/venture/feed/", fundingFeed: false },
  { name: "TechCrunch Startups", url: "https://techcrunch.com/category/startups/feed/", fundingFeed: false },
]

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export class CliError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface TextResponse {
  status: number
  text: string
  contentType: string
}

/**
 * GET text with exponential backoff + jitter on 429/5xx (500 ms doubling to
 * 8 s, max 6 retries) and a 20 s timeout. Other statuses are returned, not
 * thrown: a feed's 404 is reported per feed, not as a crash.
 */
export async function fetchText(url: string, accept = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5"): Promise<TextResponse> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) throw new CliError(`Request failed: HTTP ${response.status}`, "HTTP_ERROR")
      const jitter = Math.floor(Math.random() * 500)
      await sleep(delay + jitter)
      delay = Math.min(delay * 2, 8000)
      continue
    }
    return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") ?? "" }
  }
  throw new CliError("Request failed after max retries", "HTTP_ERROR")
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309 subset, cautious; cached 24 h in the OS temp dir)
// ---------------------------------------------------------------------------

export function stateDir(): string {
  const dir = process.env.FUNDING_NEWS_STATE_DIR || join(tmpdir(), "ai-job-search-funding-news")
  mkdirSync(dir, { recursive: true })
  return dir
}

interface Rule {
  allow: boolean
  pattern: string
}

/** Parse robots.txt into the rules for our token, else for `*`. Blank lines do not end a group. */
export function robotsRules(txt: string, token = UA_TOKEN): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = []
  let current: { agents: string[]; rules: Rule[] } | null = null
  let lastWasAgent = false
  for (const raw of txt.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim()
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false
      if (key === "disallow" && value === "") continue // empty Disallow = allow all
      current.rules.push({ allow: key === "allow", pattern: value })
    } else {
      lastWasAgent = false
    }
  }
  const t = token.toLowerCase()
  const mine = groups.filter((g) => g.agents.includes(t))
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"))
  return chosen.flatMap((g) => g.rules)
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith("$")
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${body}${anchored ? "$" : ""}`)
}

/** Longest match wins; on equal length Disallow wins (cautious, like tools/robots_check.py). */
export function robotsAllows(rules: Rule[], pathAndQuery: string): boolean {
  let best: Rule | null = null
  for (const r of rules) {
    if (!patternToRegex(r.pattern).test(pathAndQuery)) continue
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && !r.allow)) best = r
  }
  return best ? best.allow : true
}

export type RobotsVerdict = "allowed" | "disallowed" | "unconfirmed"

/**
 * May this URL be fetched? 200 -> evaluate rules; 404/410 -> no policy, allowed;
 * anything else (403, a challenge page, network failure) -> unconfirmed, and the
 * caller does not fetch. Cached per origin for 24 h.
 */
const robotsChain = new Map<string, Promise<unknown>>()

export function robotsCheck(url: string): Promise<RobotsVerdict> {
  // Two feeds on one host (TechCrunch) are read in parallel: checks for one
  // origin run one after another, so the second reads the first's cache entry.
  const u = new URL(url)
  const prev = robotsChain.get(u.origin) ?? Promise.resolve()
  const p = prev.catch(() => undefined).then(() => robotsCheckOnce(u))
  robotsChain.set(u.origin, p)
  return p
}

async function robotsCheckOnce(u: URL): Promise<RobotsVerdict> {
  const file = join(stateDir(), "robots.json")
  let cache: Record<string, { at: number; status: number; txt: string }> = {}
  try {
    cache = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    cache = {}
  }
  let entry = cache[u.origin]
  if (!entry || Date.now() - entry.at > 24 * 3600 * 1000) {
    try {
      const r = await fetchText(`${u.origin}/robots.txt`, "text/plain, */*;q=0.5")
      entry = { at: Date.now(), status: r.status, txt: r.status === 200 ? r.text.slice(0, 500_000) : "" }
    } catch {
      return "unconfirmed"
    }
    try {
      // Re-read before writing: other origins are checked concurrently and write the same file.
      let latest: typeof cache = {}
      try {
        latest = JSON.parse(readFileSync(file, "utf8"))
      } catch {
        latest = {}
      }
      latest[u.origin] = entry
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(tmp, JSON.stringify(latest))
      renameSync(tmp, file)
    } catch {
      // best effort: without the cache the next run simply re-reads robots.txt
    }
  }
  if (entry.status === 404 || entry.status === 410) return "allowed"
  if (entry.status !== 200 || /<html[\s>]/i.test(entry.txt.slice(0, 2000))) return "unconfirmed"
  return robotsAllows(robotsRules(entry.txt), u.pathname + u.search) ? "allowed" : "disallowed"
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
  euro: "€", pound: "£", yen: "¥", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", rupee: "₹",
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

const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁯︀-️﻿\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Strip invisible characters from every string in a result, recursively: the CLI's output boundary. */
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

/** Drop markup a browser never renders (comments, script/style/template/noscript, hidden elements). */
export function visibleHtml(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|template|noscript|svg)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
  return removeElements(src, isHiddenTag)
}

/** Remove every element (with its nested content) whose attribute string matches `drop`. */
export function removeElements(src: string, drop: (attrs: string) => boolean): string {
  const open = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g
  const kept: string[] = []
  let from = 0
  let m: RegExpExecArray | null
  while ((m = open.exec(src)) !== null) {
    if (!m[2] || !drop(m[2])) continue
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

/** Visible HTML to readable plain text (paragraphs kept, links dropped to their text). */
export function htmlToText(html: string): string {
  const text = visibleHtml(html)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n- ")
    .replace(/<\s*\/?\s*(?:p|div|h\d|ul|ol|pre|blockquote|table|tr|figure|figcaption|section|article|header|footer)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
  return decodeHtmlEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function snippet(text: string, n = 280): string | null {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat ? (flat.length > n ? flat.slice(0, n - 3) + "..." : flat) : null
}

// ---------------------------------------------------------------------------
// RSS / Atom parsing
// ---------------------------------------------------------------------------

export interface FeedItem {
  title: string
  link: string | null
  date: string | null
  description: string
  categories: string[]
}

function unCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
}

function tagText(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(block)
  return m ? unCdata(m[1]).trim() : null
}

/** Is this body an RSS 2.0 / RSS 1.0 / Atom document (not an HTML error or challenge page)? */
export function isFeed(body: string): boolean {
  const head = body.replace(/^﻿/, "").trimStart().slice(0, 2000)
  if (/^<!doctype html|^<html[\s>]/i.test(head)) return false
  return /<rss[\s>]|<rdf:RDF[\s>]|<feed[\s>][^>]*|<feed\s+xmlns/i.test(head)
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
}

/**
 * YYYY-MM-DD of an RSS pubDate ("Wed, 11 Nov 2026 11:56:52 +0530") or an Atom
 * ISO date, taken from the string itself so the publisher's own calendar date
 * is kept (no timezone shift). Null when unparseable; never guessed.
 */
export function feedDate(s: string | null): string | null {
  if (!s) return null
  const t = s.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const rfc = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(t)
  if (rfc && MONTHS[rfc[2].toLowerCase()]) return `${rfc[3]}-${MONTHS[rfc[2].toLowerCase()]}-${rfc[1].padStart(2, "0")}`
  return null
}

function cleanInline(s: string): string {
  // Titles are entity-escaped (often doubly: CDATA holding &#038;), may carry tags.
  return decodeHtmlEntities(decodeHtmlEntities(visibleHtml(s)).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
}

/** Parse RSS <item>s or Atom <entry>s. */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = []
  const blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].map((m) => m[1])
  const atom = blocks.length === 0
  if (atom) blocks.push(...[...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi)].map((m) => m[1]))
  for (const b of blocks) {
    const title = cleanInline(tagText(b, "title") ?? "")
    let link: string | null = null
    if (atom) {
      const alt = /<link\b(?=[^>]*\brel\s*=\s*["']alternate["'])[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(b) ?? /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(b)
      link = alt ? decodeHtmlEntities(alt[1]) : null
    } else {
      link = tagText(b, "link")
      if (!link) {
        const guid = /<guid\b(?![^>]*isPermaLink\s*=\s*["']false["'])[^>]*>([\s\S]*?)<\/guid>/i.exec(b)
        link = guid ? unCdata(guid[1]).trim() : null
      }
      link = link ? decodeHtmlEntities(link).trim() : null
    }
    if (link && !/^https?:\/\//i.test(link)) link = null
    const date = feedDate(tagText(b, "pubDate") ?? tagText(b, "dc:date") ?? tagText(b, "published") ?? tagText(b, "updated"))
    const descHtml = tagText(b, "description") ?? tagText(b, "summary") ?? tagText(b, "content") ?? ""
    const categories = [
      ...[...b.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category\s*>/gi)].map((m) => cleanInline(unCdata(m[1]))),
      ...[...b.matchAll(/<category\b[^>]*\bterm\s*=\s*["']([^"']+)["'][^>]*\/?>/gi)].map((m) => cleanInline(m[1])),
    ].filter(Boolean)
    items.push({ title, link, date, description: htmlToText(decodeHtmlEntities(descHtml).includes("<") ? decodeHtmlEntities(descHtml) : descHtml), categories })
  }
  return items
}

// ---------------------------------------------------------------------------
// Funding classification + company extraction (headline heuristics)
// ---------------------------------------------------------------------------

/** Explicit funding words from the brief: raised/funding/Series/seed/pre-seed (+ close variants). */
export const FUNDING_WORDS = /\b(?:rais(?:e|es|ed|ing)|fund-?raise|funding|series [a-h]\b|pre-series|pre-?seed|seed)\b/i
const RAISE_VERB = /\b(?:raises|raised|raise|bags|secures|lands|closes|nets|picks up|gets|receives|mops up|scoops up|snags|grabs|garners|attracts|kicks off)\b/i
const MONEY = /(?:US\$|\$|₹|€|£|\bRs\.?|\bINR|\bUSD|\bEUR)\s?\d[\d,.]*\s?(?:mn|million|m|bn|billion|b|k|cr|crore|crores|lakh|lakhs)?\b|\b\d[\d,.]*\s?(?:mn|million|bn|billion|cr|crore|crores|lakh|lakhs)\b/i
const INVESTOR_CUE = /\b(?:from|led by|co-led by|backed by|in (?:a|its) (?:\w+ )?round|round|investors?|valuation|debt|financing|capital)\b/i
/** Round-ups and trend pieces mention funding but announce nobody's round. */
const ROUNDUP =
  /\b(?:round-?up|this week|weekly|monthly|funding galore|funding report|funding tracker|top \d+ |startups (?:raised|raise|bag|bagged|secured)|(?:vc|venture|startup|seed) funding (?:into|in|for)\b)/i
/** A VC firm raising its own fund is not a funded startup. */
const VC_FUND = /\b(?:debut|new|maiden|first|second|third|\w+-themed)?\s*(?:fund|funds|fund [ivx]+|vehicle)\b(?!ing)/i

export type FundingVerdict = { funding: boolean; reason: "announcement" | "roundup" | "vc_fund" | "not_funding" }

export function classifyFunding(title: string, opts: { fundingFeed?: boolean; categories?: string[] } = {}): FundingVerdict {
  const t = title.replace(/\s+/g, " ").trim()
  const verb = RAISE_VERB.exec(t)
  const invest = INVEST_IN.exec(t) ?? ALT_PATTERNS.map((re) => re.exec(t)).find(Boolean) ?? null
  if (!verb && !invest) return { funding: false, reason: "not_funding" }
  if (/^\s*(?:decoding|explained|analysis|opinion)\s*:/i.test(t)) return { funding: false, reason: "not_funding" }
  const isRaise = verb && /^rais/i.test(verb[0])
  const fundingContext =
    FUNDING_WORDS.test(t) || opts.fundingFeed === true || (opts.categories ?? []).some((c) => /\bfund(?:ing|raise)\b/i.test(c))
  if (verb) {
    // Object of the verb, up to the investor cue: "raises debut fund" vs "raises $5M from SBI Mutual Fund".
    const obj = t.slice(verb.index + verb[0].length).split(/\b(?:from|led by|co-led by|with participation)\b/i)[0]
    if (VC_FUND.test(obj) && !/\bfunding\b/i.test(obj)) return { funding: false, reason: "vc_fund" }
  }
  const money = MONEY.test(t)
  const ok = invest
    ? money
    : isRaise
      ? money || FUNDING_WORDS.test(t.replace(verb![0], ""))
      : money && (fundingContext || INVESTOR_CUE.test(t.slice(verb!.index)))
  if (!ok) return { funding: false, reason: "not_funding" }
  if (ROUNDUP.test(t)) return { funding: false, reason: "roundup" }
  return { funding: true, reason: "announcement" }
}

const INVEST_IN = /^(?<investors>.+?)\s+(?:invest|invests|back|backs|bet on|bets on|pump|pumps|infuse|infuses)\s+(?<middle>.*?)\bin\s+(?<company>.+?)(?:\s+(?:ahead of|to|for|as|amid|at|via|after|in)\b.*)?$/i
/** Other headline shapes that name the funded company in a group. */
const ALT_PATTERNS = [
  // "Enrission India Capital participates in Ottonomy’s Rs 40.6 Cr funding round"
  /\bparticipates? in (?<company>[^’']{2,60})[’']s?\s.*\b(?:round|funding)\b/i,
  // "Ex-Palantir execs launch Dream with $17M from a16z"
  /\b(?:launch|launches|unveil|unveils|start|starts)\s+(?<company>.{2,60}?)\s+with\s+(?:US\$|\$|₹|€|£|Rs\.?\s?|INR\s?)\d/i,
]

/** Words that describe a company rather than name it ("D2C brand", "Bengaluru-based fintech startup"). */
const DESCRIPTORS = new Set([
  "startup", "startups", "start-up", "platform", "brand", "label", "firm", "company", "maker", "manufacturer", "provider",
  "player", "unicorn", "soonicorn", "marketplace", "app", "fintech", "edtech", "healthtech", "medtech", "agritech", "agtech",
  "proptech", "insurtech", "legaltech", "deeptech", "spacetech", "cleantech", "climatetech", "foodtech", "traveltech",
  "biotech", "saas", "d2c", "b2b", "b2c", "retailer", "lender", "nbfc", "operator", "aggregator", "distributor", "parent",
  "owner", "developer", "chain", "venture", "studio", "solution", "solutions", "service", "services", "network", "outfit",
  "specialist", "manager", "exchange", "broker", "neobank", "bank", "chipmaker", "carmaker", "automaker", "producer",
  "supplier", "enabler", "consultancy", "agency", "operator", "infra", "infrastructure", "commerce", "ecommerce", "e-commerce",
])
const SMALL_WORDS = new Set(["of", "and", "the", "for", "de", "la", "&", "x", "on", "by"])

function isDescriptor(tok: string): boolean {
  const w = tok.toLowerCase().replace(/[’']s$/, "").replace(/[^\p{L}\d&-]/gu, "")
  if (!w) return false
  if (DESCRIPTORS.has(w)) return true
  if (/-(?:based|backed|focused|led|owned|founded|first|native|enabled|powered)$/.test(w)) return true
  // An all-lowercase word in a sentence-case headline is description ("jewellery brand GIVA").
  return /^[\p{Ll}][\p{Ll}-]*$/u.test(tok) && !SMALL_WORDS.has(w)
}

/**
 * Heuristic startup name from a funding headline: the subject before the
 * funding verb ("raises"/"bags"/"secures"/...), with leading descriptors
 * dropped; for "X, Y invest Rs N Cr in Z" it is Z. Null when unsure.
 */
export function extractCompany(title: string): string | null {
  let t = title.replace(/\s+/g, " ").trim()
  t = t.replace(/^(?:\[[^\]]{1,30}\]|\((?:update|exclusive)[^)]*\))\s*/i, "")
  t = t.replace(/^(?:exclusive|breaking|funding alert|update|just in|scoop)\s*[:|-]\s*/i, "")
  const inv = INVEST_IN.exec(t)
  const alt = ALT_PATTERNS.map((re) => re.exec(t)).find(Boolean)
  const verb = RAISE_VERB.exec(t)
  let subject: string
  if (inv && !RAISE_VERB.test(t.slice(0, inv.index + inv.groups!.investors.length + 1))) {
    subject = inv.groups!.company
  } else if (alt && (!verb || alt.index < verb.index)) {
    subject = alt.groups!.company
  } else {
    if (!verb) return null
    // "IIFL Finance to raise", "Foo in talks to raise", "Foo set to bag": drop the auxiliary.
    subject = t.slice(0, verb.index).replace(/\s+(?:is |are )?(?:in talks to|plans to|set to|looks to|aims to|seeks to|to|will|has|have|may)\s*$/i, "")
  }
  // "Funding news: Foo raises" / "After pivot, Foo raises": keep the part after the last colon/comma.
  subject = subject.split(/:\s|;\s|\s[—–]\s|,\s/).pop() ?? subject
  subject = subject.replace(/["“”‘’']/g, (c) => (c === "’" || c === "'" ? c : "")).trim()
  const toks = subject.split(" ").filter(Boolean)
  let start = 0
  for (let i = 0; i < toks.length - 1; i++) if (isDescriptor(toks[i])) start = i + 1
  // "Bakingo parent raises": the brand is what a reader searches for.
  if (toks.length > 1 && /^(?:parent|owner|operator)$/i.test(toks[toks.length - 1])) toks.pop()
  const name = toks
    .slice(start)
    .join(" ")
    .replace(/[’']s$/, "")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
  if (!name || name.split(" ").length > 6 || name.length > 60) return null
  if (/^(?:it|this|the startup|the company|startup|company|indian startups?|startups?)$/i.test(name)) return null
  return name
}

export function extractAmount(title: string): string | null {
  const m = MONEY.exec(title)
  return m ? m[0].replace(/\s+/g, " ").trim() : null
}

export function extractRound(title: string): string | null {
  // Bare "growth"/"debt" are too common in names ("Daksham Growth Ventures"); they need "round"/"funding".
  const m =
    /\b(pre-?seed|seed|pre-?series [a-h]\+?|series [a-h]\d?\+?|venture debt)\b/i.exec(title) ??
    /\b(bridge|angel|debt|growth)\s+(?:round|funding|financing)\b/i.exec(title)
  if (!m) return null
  return m[1]
    .toLowerCase()
    .replace(/^pre-?seed$/, "Pre-seed")
    .replace(/^seed$/, "Seed")
    .replace(/^pre-?series ([a-h])\+?$/, (_, l: string) => `Pre-Series ${l.toUpperCase()}`)
    .replace(/^series ([a-h])(\d?\+?)$/, (_, l: string, r: string) => `Series ${l.toUpperCase()}${r}`)
    .replace(/^(bridge|angel|debt|venture debt|growth)$/, (w) => w[0].toUpperCase() + w.slice(1))
}

/** Normalize an article URL for de-duplication (no query/hash, no trailing slash, lowercase host). */
export function normUrl(u: string): string {
  try {
    const x = new URL(u)
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}`
  } catch {
    return u
  }
}
