import {
  CliError,
  DEFAULT_FEEDS,
  classifyFunding,
  extractAmount,
  extractCompany,
  extractRound,
  fetchText,
  isFeed,
  normUrl,
  parseFeed,
  robotsCheck,
  snippet,
  stripInvisible,
  writeError,
  type FeedDef,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  feeds?: string[]
  days?: number
  keepUnparsed: boolean
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

export interface Lead {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  posted_date: string | null
  url: string
  apply_url: string | null
  remote: boolean | null
  work_mode: string[]
  salary: string | null
  employment_type: string | null
  india_friendly: boolean | null
  india_reason: string | null
  header: string
  snippet: string | null
  author: string | null
  kind: "lead"
  lead_type: "funded_startup"
  amount: string | null
  round: string | null
  source: string
  categories: string[]
  also_reported: string[]
}

export interface FeedStatus {
  name: string
  url: string
  status: "ok" | "robots-disallowed" | "robots-unconfirmed" | "http-error" | "not-a-feed" | "error"
  http_status?: number
  items: number
  funding: number
  error?: string
}

/** A custom --feeds URL gets its host as its name. */
export function feedsFromUrls(urls: string[]): FeedDef[] {
  return urls.map((u) => ({ name: new URL(u).hostname.replace(/^www\./, ""), url: u, fundingFeed: false }))
}

export interface Collected {
  leads: Lead[]
  feeds: FeedStatus[]
  skipped: { not_funding: number; roundup: number; vc_fund: number; no_company: number; duplicate: number }
}

/** Fetch + parse one feed; failures are reported in its status, never thrown. */
async function readFeed(def: FeedDef): Promise<{ status: FeedStatus; items: ReturnType<typeof parseFeed> }> {
  const status: FeedStatus = { name: def.name, url: def.url, status: "ok", items: 0, funding: 0 }
  try {
    const verdict = await robotsCheck(def.url)
    if (verdict !== "allowed") {
      status.status = verdict === "disallowed" ? "robots-disallowed" : "robots-unconfirmed"
      return { status, items: [] }
    }
    const res = await fetchText(def.url)
    status.http_status = res.status
    if (res.status !== 200) {
      status.status = "http-error"
      return { status, items: [] }
    }
    if (!isFeed(res.text)) {
      status.status = "not-a-feed"
      return { status, items: [] }
    }
    const items = parseFeed(res.text)
    status.items = items.length
    return { status, items }
  } catch (e) {
    status.status = "error"
    status.error = e instanceof Error ? e.message : String(e)
    return { status, items: [] }
  }
}

export async function collect(defs: FeedDef[], opts: Pick<SearchOpts, "keepUnparsed">): Promise<Collected> {
  const results = await Promise.all(defs.map(readFeed))
  const leads: Lead[] = []
  const seenUrl = new Set<string>()
  const seenTitle = new Set<string>()
  const skipped = { not_funding: 0, roundup: 0, vc_fund: 0, no_company: 0, duplicate: 0 }
  results.forEach(({ status, items }, i) => {
    const def = defs[i]
    for (const it of items) {
      if (!it.link || !it.title) continue
      const v = classifyFunding(it.title, { fundingFeed: def.fundingFeed, categories: it.categories })
      if (!v.funding) {
        skipped[v.reason as "not_funding" | "roundup" | "vc_fund"]++
        continue
      }
      status.funding++
      const company = extractCompany(it.title)
      if (!company && !opts.keepUnparsed) {
        skipped.no_company++
        continue
      }
      const key = normUrl(it.link)
      const tkey = it.title.toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim()
      if (seenUrl.has(key) || seenTitle.has(tkey)) {
        skipped.duplicate++
        continue
      }
      seenUrl.add(key)
      seenTitle.add(tkey)
      leads.push({
        id: key,
        title: it.title,
        company,
        location: null,
        date: it.date,
        posted_date: it.date,
        url: it.link,
        apply_url: null,
        remote: null,
        work_mode: [],
        salary: null,
        employment_type: null,
        india_friendly: null,
        india_reason: null,
        header: `${def.name} · ${it.date ?? "undated"}`,
        snippet: snippet(it.description),
        author: null,
        kind: "lead",
        lead_type: "funded_startup",
        amount: extractAmount(it.title),
        round: extractRound(it.title),
        source: def.name,
        categories: it.categories.slice(0, 8),
        also_reported: [],
      })
    }
  })
  // Newest first; undated last.
  leads.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
  // The same raise reported by two outlets is one lead: keep the newest article,
  // list the others in also_reported.
  const byCompany = new Map<string, Lead>()
  const merged: Lead[] = []
  for (const l of leads) {
    const key = l.company?.toLowerCase().replace(/[^\p{L}\d]+/gu, "")
    const first = key ? byCompany.get(key) : undefined
    if (first) {
      first.also_reported.push(l.url)
      skipped.duplicate++
      continue
    }
    if (key) byCompany.set(key, l)
    merged.push(l)
  }
  return { leads: merged, feeds: results.map((r) => r.status), skipped }
}

/**
 * Client-side keyword filter: every word must start a word somewhere in the
 * headline, snippet, categories, source or company ("ai" matches "AI-led",
 * not "raises").
 */
export function applyFilters(leads: Lead[], opts: Pick<SearchOpts, "query" | "days">, now = Date.now()): Lead[] {
  const words = (opts.query ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => new RegExp(`(?:^|[^\\p{L}\\d])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu"))
  const since = opts.days !== undefined ? new Date(now - opts.days * 86400_000).toISOString().slice(0, 10) : null
  return leads.filter((l) => {
    if (since && (!l.date || l.date < since)) return false
    if (!words.length) return true
    const hay = [l.title, l.snippet ?? "", l.categories.join(" "), l.source, l.company ?? ""].join(" ")
    return words.every((re) => re.test(hay))
  })
}

function pad(s: string | null | undefined, n: number): string {
  const v = (s ?? "—").replace(/\s+/g, " ")
  return (v.length > n ? v.slice(0, n - 1) + "…" : v).padEnd(n)
}

function renderTable(leads: Lead[]): string {
  if (leads.length === 0) return "No results."
  const header = `${pad("COMPANY", 24)} ${pad("AMOUNT", 12)} ${pad("ROUND", 14)} ${pad("SOURCE", 19)} ${"DATE".padEnd(10)} HEADLINE`
  const rows = leads.map(
    (l) => `${pad(l.company, 24)} ${pad(l.amount, 12)} ${pad(l.round, 14)} ${pad(l.source, 19)} ${(l.date ?? "—").padEnd(10)} ${pad(l.title, 70).trimEnd()}`,
  )
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(leads: Lead[]): string {
  if (leads.length === 0) return "No results."
  return leads
    .map((l) =>
      [
        l.title,
        `  ${l.company ?? "—"} · ${l.amount ?? "amount ?"} · ${l.round ?? "round ?"} · ${l.source} · ${l.date ?? "—"}`,
        `  ${l.url}`,
      ].join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const defs = opts.feeds ? feedsFromUrls(opts.feeds) : DEFAULT_FEEDS
    const { leads, feeds, skipped } = await collect(defs, opts)
    if (feeds.every((f) => f.status !== "ok")) {
      throw new CliError(
        `No feed could be read: ${feeds.map((f) => `${f.name} (${f.status}${f.http_status ? ` ${f.http_status}` : ""}${f.error ? `: ${f.error}` : ""})`).join("; ")}`,
        "FEEDS_FAILED",
      )
    }
    const filtered = stripInvisible(applyFilters(leads, opts))
    const start = (opts.page - 1) * opts.limit
    const pageItems = filtered.slice(start, start + opts.limit)

    if (opts.format === "table") {
      process.stdout.write(renderTable(pageItems) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(pageItems) + "\n")
    } else {
      const meta = {
        count: pageItems.length,
        page: opts.page,
        limit: opts.limit,
        total: filtered.length,
        scanned: feeds.reduce((n, f) => n + f.items, 0),
        funding_items: leads.length,
        skipped,
        query: opts.query ?? null,
        filters: { days: opts.days ?? null, keep_unparsed: opts.keepUnparsed },
        feeds: stripInvisible(feeds),
      }
      process.stdout.write(JSON.stringify({ meta, results: pageItems }, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), e instanceof CliError && e.code !== "HTTP_ERROR" ? e.code : "SEARCH_FAILED")
    return 1
  }
}
