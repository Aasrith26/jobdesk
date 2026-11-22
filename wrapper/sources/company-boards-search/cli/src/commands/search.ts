import { fetchBoard, type Job, type Posting } from "../ats.js"
import {
  ageInDays,
  compileLocation,
  compileQuery,
  htmlToText,
  isUnrestrictedRemote,
  mapPool,
  stripInvisible,
  writeError,
  writeWarning,
  type Company,
} from "../helpers.js"

export const CONCURRENCY = 6

export interface SearchOpts {
  companies: Company[] // already narrowed by --company/--tag/--ats
  query?: string
  inDescription?: boolean
  location?: string
  remote?: boolean
  jobage?: number
  page: number
  limit: number
  format: "json" | "table" | "plain"
  withDescription?: boolean
  timeoutMs?: number
}

export interface BoardError {
  company: string
  ats: string
  token: string
  error: string
}

export interface SearchResult extends Job {
  description?: string | null
}

export interface Fetched {
  postings: Posting[]
  errors: BoardError[]
  warnings: BoardError[]
}

/** Fan out over the boards. One company failing never fails the run; it lands in errors. */
export async function fetchAll(companies: Company[], timeoutMs?: number): Promise<Fetched> {
  const errors: BoardError[] = []
  const warnings: BoardError[] = []
  const lists = await mapPool(companies, CONCURRENCY, async (c) => {
    try {
      const { postings, truncated } = await fetchBoard(c, { timeoutMs })
      if (truncated) {
        warnings.push({ company: c.name, ats: c.ats, token: c.token, error: "board truncated: only the first 1000 postings were read" })
      }
      return postings
    } catch (e) {
      const msg = e instanceof Error ? (e.name === "TimeoutError" ? "request timed out" : e.message) : String(e)
      errors.push({ company: c.name, ats: c.ats, token: c.token, error: msg })
      return []
    }
  })
  return { postings: lists.flat(), errors, warnings }
}

export interface FilterOpts {
  query?: string
  inDescription?: boolean
  location?: string
  remote?: boolean
  jobage?: number
  now?: number
}

/** Apply the client-side filters. */
export function filterPostings(postings: Posting[], f: FilterOpts): Posting[] {
  const matchQuery = f.query ? compileQuery(f.query) : null
  const matchLocation = f.location ? compileLocation(f.location) : null
  const descCache = new WeakMap<Posting, string>()
  const descText = (p: Posting) => {
    let t = descCache.get(p)
    if (t === undefined) {
      t = htmlToText(p.descriptionHtml) ?? ""
      descCache.set(p, t)
    }
    return t
  }
  return postings.filter((p) => {
    if (matchQuery) {
      const titleHit = matchQuery(p.job.title)
      if (!titleHit && !(f.inDescription && matchQuery(descText(p)))) return false
    }
    if (matchLocation || f.remote) {
      const haystack = [...p.locations, ...p.locationExtra].join(" | ")
      const inLocation = matchLocation ? matchLocation(haystack) : false
      // --remote alone: remote roles only. With -l: the location's roles plus
      // remote roles that are open anywhere (or name the -l place).
      const remoteOk = f.remote === true && p.job.remote === true && (!matchLocation || isUnrestrictedRemote(p.locations))
      if (!inLocation && !remoteOk) return false
    }
    if (f.jobage !== undefined) {
      const age = ageInDays(p.job.date, f.now)
      if (age === null || age > f.jobage) return false
    }
    return true
  })
}

/** Newest first; undated last; then company and title for a stable order. */
export function sortPostings(postings: Posting[]): Posting[] {
  return [...postings].sort((a, b) => {
    const da = a.job.date ?? ""
    const db = b.job.date ?? ""
    if (da !== db) return da < db ? 1 : -1
    return a.job.company.localeCompare(b.job.company) || a.job.title.localeCompare(b.job.title)
  })
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n)
}

export function renderTable(results: SearchResult[]): string {
  if (results.length === 0) return "No results."
  const header = `${pad("COMPANY", 16)} ${pad("TITLE", 46)} ${pad("LOCATION", 30)} ${pad("WORK", 7)} ${pad("DATE", 10)} ID`
  const rows = results.map((r) =>
    [
      pad(r.company, 16),
      pad(r.title, 46),
      pad(r.location ?? "—", 30),
      pad(r.workplaceType ?? (r.remote ? "remote" : "—"), 7),
      pad(r.date ?? "—", 10),
      r.id,
    ].join(" "),
  )
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export function renderPlain(results: SearchResult[]): string {
  if (results.length === 0) return "No results."
  return results
    .map((r) => {
      const facts = [r.department, r.workplaceType, r.employmentType, r.compensation].filter(Boolean).join(" · ")
      return [
        `${r.title}`,
        `  ${r.company} · ${r.location ?? "—"} · ${r.date ?? "—"}`,
        facts ? `  ${facts}` : "",
        `  id: ${r.id}`,
        `  ${r.url ?? "—"}`,
      ]
        .filter(Boolean)
        .join("\n")
    })
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  const { postings, errors, warnings } = await fetchAll(opts.companies, opts.timeoutMs)
  if (errors.length === opts.companies.length && opts.companies.length > 0) {
    writeError(
      `every board failed: ${errors.map((e) => `${e.company} (${e.error})`).join("; ")}`,
      "ALL_BOARDS_FAILED",
    )
    return 1
  }

  const matched = sortPostings(filterPostings(postings, opts))
  const start = (opts.page - 1) * opts.limit
  const pageItems = matched.slice(start, start + opts.limit)
  const results: SearchResult[] = stripInvisible(
    pageItems.map((p) => (opts.withDescription ? { ...p.job, description: htmlToText(p.descriptionHtml) } : { ...p.job })),
  )

  if (opts.format === "table") {
    process.stdout.write(renderTable(results) + "\n")
  } else if (opts.format === "plain") {
    process.stdout.write(renderPlain(results) + "\n")
  } else {
    const meta = {
      count: results.length,
      page: opts.page,
      limit: opts.limit,
      total: matched.length,
      companies: opts.companies.length,
      errors: stripInvisible(errors),
      warnings: stripInvisible(warnings),
    }
    process.stdout.write(JSON.stringify({ meta, results }, null, 2) + "\n")
  }

  if (errors.length) {
    writeWarning(`${errors.length} of ${opts.companies.length} boards failed; results are partial`, "PARTIAL_RESULTS", {
      errors: stripInvisible(errors),
    })
  }
  return 0
}

