import {
  classifyRegion,
  descriptionRestriction,
  snippet,
  stripInvisible,
  titleRestriction,
  writeError,
  writeWarning,
} from "../helpers.js"
import { SOURCES, type RawJob, type SourceName } from "../sources.js"

export interface SearchOpts {
  query?: string
  sources: SourceName[]
  regions: string[] // --region, comma = OR, case-insensitive substring of the region text
  indiaFriendly: boolean
  titleOnly?: boolean // --title-only: match -q against title + tags, not the description
  jobage?: number
  page: number
  limit: number
  format: "json" | "table" | "plain"
  timeoutMs: number
}

export interface SearchResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  source: SourceName
  region: string | null
  tags: string[]
  salary: string | null
  indiaFriendly: boolean
  restrictionHint: string | null
  snippet: string | null
  alsoOn: { source: SourceName; id: string; url: string; region: string | null }[]
}

export interface SourceError {
  source: SourceName
  error: string
  code: string
}

// ---------------------------------------------------------------------------
// Pure pipeline pieces (exported for tests)
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** `machine learning OR llm` -> [["machine","learning"],["llm"]]: alternatives (uppercase OR) of phrases. */
export function parseQuery(query: string | undefined): string[][] {
  if (!query) return []
  return query
    .split(/\s+OR\s+/)
    .map((alt) => alt.toLowerCase().replace(/^"|"$/g, "").split(/[\s-]+/).filter(Boolean))
    .filter((alt) => alt.length > 0)
}

/**
 * Phrase match: the words in order, separated by spaces/hyphens/slashes, whole
 * words only, with an optional plural on the last ("llm" matches "LLMs",
 * "machine learning" matches "Machine-Learning"). Safe for "c++" / "node.js".
 */
function phraseRe(words: string[]): RegExp {
  const body = words.map(escapeRe).join("[\\s\\-/]+")
  return new RegExp(`(?<![a-z0-9])${body}(?:s|es)?(?![a-z0-9])`, "i")
}

export function matchesQuery(text: string, alts: string[][]): boolean {
  if (alts.length === 0) return true
  return alts.some((words) => phraseRe(words).test(text))
}

/** Normalized key for "same job on two boards": company + title, letters and digits only. */
export function dedupeKey(job: { company: string | null; title: string }): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\b(inc|llc|ltd|gmbh|corp|co|limited|remote)\b/g, "")
      .replace(/[^a-z0-9]+/g, "")
  return `${norm(job.company ?? "")}|${norm(job.title)}`
}

const WORLDWIDE_ALIASES = /^(worldwide|anywhere|global|world ?wide|anywhere in the world)$/i
const WORLDWIDE_TEXT = /\b(world ?wide|anywhere|global)\b/i

export function matchesRegion(region: string | null, wanted: string[]): boolean {
  if (wanted.length === 0) return true
  const text = region ?? ""
  return wanted.some((w) => {
    if (WORLDWIDE_ALIASES.test(w.trim())) return WORLDWIDE_TEXT.test(text)
    return text.toLowerCase().includes(w.trim().toLowerCase())
  })
}

/**
 * India eligibility for one posting. Step 1: the board's structured verdict
 * (Himalayas) or the region-text heuristic (classifyRegion). Step 2, only for
 * a friendly verdict that does not name India itself: a title pinned to another
 * market ("... - EU") or a description residency/authorization/office-days
 * requirement downgrades it, and the matched fragment is returned as the hint.
 */
export function assessIndia(job: Pick<RawJob, "eligibility" | "region" | "title" | "description">): {
  indiaFriendly: boolean
  restrictionHint: string | null
} {
  const eligibility = job.eligibility ?? classifyRegion(job.region)
  if (eligibility !== "friendly") return { indiaFriendly: false, restrictionHint: null }
  if (/\bindia\b/i.test(job.region ?? "")) return { indiaFriendly: true, restrictionHint: null }
  const t = titleRestriction(job.title)
  if (t) return { indiaFriendly: false, restrictionHint: `title: ${t}` }
  const d = descriptionRestriction(job.description)
  if (d) return { indiaFriendly: false, restrictionHint: `description: ${d}` }
  return { indiaFriendly: true, restrictionHint: null }
}

/** Turn a RawJob into the output shape, computing India eligibility. */
export function toResult(job: RawJob): SearchResult {
  const { indiaFriendly, restrictionHint } = assessIndia(job)
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.region ? `Remote (${job.region})` : "Remote",
    date: job.date,
    url: job.url,
    source: job.source,
    region: job.region,
    tags: job.tags,
    salary: job.salary,
    indiaFriendly,
    restrictionHint,
    snippet: snippet(job.description),
    alsoOn: [],
  }
}

export interface FilterStats {
  fetched: number
  afterQuery: number
  afterRegion: number
  afterIndia: number
  afterAge: number
  duplicates: number
}

export function filterAndRank(
  raw: RawJob[],
  opts: Pick<SearchOpts, "query" | "regions" | "indiaFriendly" | "jobage" | "titleOnly">,
  now = Date.now(),
): { results: SearchResult[]; stats: FilterStats } {
  const alts = parseQuery(opts.query)
  const stats: FilterStats = { fetched: raw.length, afterQuery: 0, afterRegion: 0, afterIndia: 0, afterAge: 0, duplicates: 0 }

  const scored: { r: SearchResult; titleHit: boolean }[] = []
  const cutoff = opts.jobage ? new Date(now - opts.jobage * 86400000).toISOString().slice(0, 10) : null
  for (const job of raw) {
    const titleAndTags = `${job.title}\n${job.tags.join(" ")}`
    const hay = opts.titleOnly ? titleAndTags : `${titleAndTags}\n${job.description ?? ""}`
    if (!matchesQuery(hay, alts)) continue
    stats.afterQuery++
    if (!matchesRegion(job.region, opts.regions)) continue
    stats.afterRegion++
    const r = toResult(job)
    if (opts.indiaFriendly && !r.indiaFriendly) continue
    stats.afterIndia++
    // Postings without a date cannot be shown to be recent: dropped under --jobage.
    if (cutoff && (!r.date || r.date < cutoff)) continue
    stats.afterAge++
    scored.push({ r, titleHit: alts.length > 0 && matchesQuery(titleAndTags, alts) })
  }

  // Dedupe on company+title across boards; the first occurrence (source order)
  // stays and records where else the posting appeared.
  const byKey = new Map<string, { r: SearchResult; titleHit: boolean }>()
  for (const s of scored) {
    const key = dedupeKey(s.r)
    const seen = byKey.get(key)
    if (!seen) {
      byKey.set(key, s)
      continue
    }
    stats.duplicates++
    if (seen.r.id !== s.r.id && !seen.r.alsoOn.some((a) => a.id === s.r.id)) {
      seen.r.alsoOn.push({ source: s.r.source, id: s.r.id, url: s.r.url, region: s.r.region })
    }
    if (!seen.r.salary && s.r.salary) seen.r.salary = s.r.salary
    seen.titleHit ||= s.titleHit
  }

  const results = [...byKey.values()]
    .sort((a, b) => {
      if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1
      return (b.r.date ?? "").localeCompare(a.r.date ?? "")
    })
    .map((s) => s.r)
  return { results, stats }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function withDeadline<T>(p: Promise<T>, ms: number, source: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${source} did not answer within ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

export async function fetchAll(
  opts: Pick<SearchOpts, "sources" | "query" | "indiaFriendly" | "timeoutMs">,
): Promise<{ jobs: RawJob[]; perSource: Record<string, number>; errors: SourceError[] }> {
  const settled = await Promise.allSettled(
    opts.sources.map((name) =>
      withDeadline(
        SOURCES[name].search({ query: opts.query, indiaFriendly: opts.indiaFriendly, timeoutMs: opts.timeoutMs }),
        // Overall budget per source: retries with backoff included.
        opts.timeoutMs * 2,
        SOURCES[name].label,
      ),
    ),
  )
  const jobs: RawJob[] = []
  const perSource: Record<string, number> = {}
  const errors: SourceError[] = []
  settled.forEach((s, i) => {
    const name = opts.sources[i]
    if (s.status === "fulfilled") {
      perSource[name] = s.value.length
      jobs.push(...s.value)
    } else {
      perSource[name] = 0
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
      const code = /did not answer|timed? ?out|abort/i.test(msg) ? "SOURCE_TIMEOUT" : "SOURCE_FAILED"
      errors.push({ source: name, error: msg, code })
    }
  })
  return { jobs, perSource, errors }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cell(s: string | null | undefined, w: number): string {
  const v = (s ?? "—").replace(/\s+/g, " ")
  return (v.length > w ? v.slice(0, w - 1) + "…" : v).padEnd(w)
}

const SHORT: Record<SourceName, string> = {
  remoteok: "remoteok",
  himalayas: "himalayas",
  jobicy: "jobicy",
  weworkremotely: "wwr",
  workingnomads: "wnomads",
}

export function renderTable(results: SearchResult[]): string {
  if (results.length === 0) return "No results."
  const header = `${cell("DATE", 10)} ${cell("SOURCE", 9)} ${cell("TITLE", 44)} ${cell("COMPANY", 22)} ${cell("REGION", 26)} IN ID`
  const rows = results.map(
    (r) =>
      `${cell(r.date, 10)} ${cell(SHORT[r.source], 9)} ${cell(r.title, 44)} ${cell(r.company, 22)} ${cell(r.region ?? "unspecified", 26)} ${r.indiaFriendly ? "Y " : "- "} ${r.id}`,
  )
  return [header, "-".repeat(header.length + 20), ...rows].join("\n")
}

export function renderPlain(results: SearchResult[]): string {
  if (results.length === 0) return "No results."
  return results
    .map((r) => {
      const lines = [
        r.title,
        `  ${r.company ?? "—"} · ${r.region ?? "region unspecified"} · ${r.date ?? "—"} · ${r.source}${r.salary ? " · " + r.salary : ""}`,
        `  india-friendly: ${r.indiaFriendly ? "yes" : "no"}${r.restrictionHint ? ` (${r.restrictionHint})` : ""}`,
        `  id: ${r.id}`,
        `  ${r.url}`,
      ]
      if (r.alsoOn.length) lines.push(`  also listed: ${r.alsoOn.map((a) => `${a.id} (${a.region ?? "unspecified"})`).join("; ")}`)
      return lines.join("\n")
    })
    .join("\n\n")
}

function attributionLines(sources: SourceName[]): string[] {
  return sources.map((s) => SOURCES[s].attribution)
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const { jobs, perSource, errors } = await fetchAll(opts)
    if (errors.length === opts.sources.length) {
      writeError(
        `every selected source failed: ${errors.map((e) => `${e.source}: ${e.error}`).join("; ")}`,
        "SEARCH_FAILED",
      )
      return 1
    }
    const { results, stats } = filterAndRank(jobs, opts)
    const start = (opts.page - 1) * opts.limit
    const pageResults = stripInvisible(results.slice(start, start + opts.limit))

    if (opts.format === "json") {
      const out = {
        meta: {
          count: pageResults.length,
          page: opts.page,
          limit: opts.limit,
          total: results.length,
          hasMore: start + opts.limit < results.length,
          query: opts.query ?? null,
          indiaFriendly: opts.indiaFriendly,
          sources: opts.sources,
          fetched: perSource,
          filtered: stats,
          errors,
          attribution: attributionLines(opts.sources),
        },
        results: pageResults,
      }
      process.stdout.write(JSON.stringify(stripInvisible(out), null, 2) + "\n")
    } else {
      const body = opts.format === "table" ? renderTable(pageResults) : renderPlain(pageResults)
      const footer = [
        "",
        `${pageResults.length} of ${results.length} matching (page ${opts.page}); fetched ${Object.entries(perSource)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
        "Sources (link back / credit required):",
        ...attributionLines(opts.sources).map((a) => `  ${a}`),
      ]
      process.stdout.write(body + "\n" + footer.join("\n") + "\n")
      for (const e of errors) writeWarning(`${e.source}: ${e.error}`, e.code)
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
