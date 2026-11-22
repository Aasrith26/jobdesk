import {
  API_URL,
  CliError,
  classifyIssue,
  getRepo,
  ghFetch,
  isoDate,
  markdownToText,
  readRateState,
  readRepoCache,
  redact,
  repoFromApiUrl,
  sinceDate,
  snippet,
  stripInvisible,
  writeError,
  writeRepoCache,
  type RawRepo,
  type RepoInfo,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  mode: "issues" | "repos"
  days: number
  language?: string
  minStars?: number
  noStars: boolean
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

interface RawIssue {
  html_url: string
  repository_url: string
  number: number
  title: string
  body?: string | null
  state?: string
  labels?: Array<{ name?: string } | string>
  user?: { login?: string } | null
  comments?: number
  created_at?: string
  updated_at?: string
  pull_request?: unknown
}

interface SearchResponse<T> {
  total_count?: number
  incomplete_results?: boolean
  items: T[]
}

export interface Lead {
  id: string
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
  india_friendly: boolean | null
  india_reason: string | null
  header: string
  snippet: string | null
  author: string | null
  kind: "lead"
  lead_type: "github_issue" | "github_repo_hiring"
  repo: string
  repo_stars: number | null
  labels: string[]
  match: string[]
  updated_date: string | null
  comments: number | null
}

/** Results fetched per search query (one page). */
export const PER_PAGE = 100
/** Max repo lookups (core API, for stars) per run: 60/h unauthenticated, 5000/h with a token. */
export const MAX_REPO_LOOKUPS = { anon: 15, authed: 60 }
/** Stop looking up repos when the core budget drops this low (leave room for `detail`). */
const CORE_RESERVE = 5

function qualifier(opts: SearchOpts): string {
  const parts: string[] = []
  if (opts.query) parts.push(opts.query)
  if (opts.language) parts.push(`language:"${opts.language.replace(/"/g, "")}"`)
  return parts.join(" ")
}

/** The two issue queries: the help-wanted label, and the lead keywords (OR, advanced search). */
export function buildIssueQueries(opts: SearchOpts, now = Date.now()): string[] {
  const since = sinceDate(opts.days, now)
  const base = [qualifier(opts), "is:issue", "is:open", "archived:false"].filter(Boolean).join(" ")
  return [
    `${base} label:"help wanted" updated:>=${since}`,
    `${base} (hiring OR paid OR bounty OR contract) updated:>=${since}`,
  ]
}

export function buildRepoQuery(opts: SearchOpts, now = Date.now()): string {
  const parts = [qualifier(opts), `"we're hiring" in:readme`, "archived:false", `pushed:>=${sinceDate(opts.days, now)}`]
  if (opts.minStars !== undefined) parts.push(`stars:>=${opts.minStars}`)
  return parts.filter(Boolean).join(" ")
}

function searchUrl(kind: "issues" | "repositories", q: string, advanced: boolean): string {
  const params = new URLSearchParams({ q, sort: "updated", order: "desc", per_page: String(PER_PAGE), page: "1" })
  if (advanced) params.set("advanced_search", "true")
  return `${API_URL}/search/${kind}?${params}`
}

function labelNames(labels: RawIssue["labels"]): string[] {
  return (labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean)
}

export function issueToLead(it: RawIssue, match: string[]): Lead | null {
  const repo = repoFromApiUrl(it.repository_url)
  if (!repo || !/^https:\/\/github\.com\//.test(it.html_url) || it.pull_request) return null
  const owner = repo.split("/")[0]
  const labels = labelNames(it.labels)
  const body = markdownToText(it.body ?? "")
  return {
    id: `${repo}#${it.number}`,
    title: it.title.trim(),
    company: owner,
    location: null,
    date: isoDate(it.created_at),
    posted_date: isoDate(it.created_at),
    url: it.html_url,
    apply_url: null,
    remote: null,
    work_mode: [],
    salary: null,
    employment_type: null,
    india_friendly: null,
    india_reason: null,
    header: `${repo}#${it.number}${labels.length ? ` [${labels.slice(0, 5).join(", ")}]` : ""}`,
    snippet: snippet(body),
    author: it.user?.login ?? null,
    kind: "lead",
    lead_type: "github_issue",
    repo,
    repo_stars: null,
    labels,
    match,
    updated_date: isoDate(it.updated_at),
    comments: typeof it.comments === "number" ? it.comments : null,
  }
}

export function repoToLead(r: RawRepo): Lead | null {
  if (!r.html_url || !/^https:\/\/github\.com\//.test(r.html_url) || !r.owner?.login) return null
  const owner = r.owner.login
  return {
    id: r.full_name,
    title: `${owner} is hiring (README of ${r.full_name})`,
    company: owner,
    location: null,
    // A README mention has no publication date; never infer one.
    date: null,
    posted_date: null,
    url: r.html_url,
    apply_url: r.homepage && /^https?:\/\//i.test(r.homepage) ? r.homepage : null,
    remote: null,
    work_mode: [],
    salary: null,
    employment_type: null,
    india_friendly: null,
    india_reason: null,
    header: `${r.full_name} (${r.owner.type ?? "?"})${r.language ? ` · ${r.language}` : ""}`,
    snippet: snippet(r.description ?? ""),
    author: null,
    kind: "lead",
    lead_type: "github_repo_hiring",
    repo: r.full_name,
    repo_stars: typeof r.stargazers_count === "number" ? r.stargazers_count : null,
    labels: r.topics ?? [],
    match: ["readme:we're hiring (GitHub search)"],
    updated_date: isoDate(r.pushed_at),
    comments: null,
  }
}

/** Run both issue queries, keep the verified leads, newest update first. */
export async function searchIssues(opts: SearchOpts): Promise<{ leads: Lead[]; totals: number[]; dropped: number }> {
  const [qLabel, qKeyword] = buildIssueQueries(opts)
  const a = await ghFetch<SearchResponse<RawIssue>>(searchUrl("issues", qLabel, false), { resource: "search" })
  const b = await ghFetch<SearchResponse<RawIssue>>(searchUrl("issues", qKeyword, true), { resource: "search" })
  const seen = new Map<string, { lead: Lead; updated: string }>()
  let dropped = 0
  for (const it of [...(a?.data.items ?? []), ...(b?.data.items ?? [])]) {
    if (seen.has(it.html_url)) continue
    // GitHub's keyword OR matches anywhere in the body ("API contract"), so
    // every hit is re-checked client-side; anything without a lead signal goes.
    const m = classifyIssue(it.title ?? "", labelNames(it.labels), it.body ?? "")
    if (!m.matched) {
      dropped++
      continue
    }
    const lead = issueToLead(it, m.reasons)
    if (lead) seen.set(it.html_url, { lead, updated: it.updated_at ?? "" })
  }
  const leads = [...seen.values()].sort((x, y) => (x.updated < y.updated ? 1 : -1)).map((v) => v.lead)
  return { leads, totals: [a?.data.total_count ?? 0, b?.data.total_count ?? 0], dropped }
}

/**
 * Fill repo_stars from the 24 h cache or the core API, for at most
 * MAX_REPO_LOOKUPS uncached repos, and never below the CORE_RESERVE budget.
 */
export async function enrichStars(leads: Lead[]): Promise<{ looked_up: number; unresolved: number }> {
  const cache = readRepoCache()
  const cap = process.env.GITHUB_TOKEN?.trim() ? MAX_REPO_LOOKUPS.authed : MAX_REPO_LOOKUPS.anon
  let lookups = 0
  const infos = new Map<string, RepoInfo | null>()
  for (const lead of leads) {
    const key = lead.repo.toLowerCase()
    if (!infos.has(key)) {
      const cached = cache[key]
      if (cached && Date.now() - cached.fetched_at < 24 * 3600 * 1000) {
        infos.set(key, cached)
      } else {
        const remaining = readRateState().core_remaining
        if (lookups >= cap || (remaining !== undefined && remaining <= CORE_RESERVE)) continue
        lookups++
        infos.set(key, await getRepo(lead.repo, cache))
      }
    }
    const info = infos.get(key)
    if (info) lead.repo_stars = info.stars
  }
  writeRepoCache(cache)
  return { looked_up: lookups, unresolved: leads.filter((l) => l.repo_stars === null).length }
}

function pad(s: string | null | undefined, n: number): string {
  const v = (s ?? "—").replace(/\s+/g, " ")
  return (v.length > n ? v.slice(0, n - 1) + "…" : v).padEnd(n)
}

function renderTable(leads: Lead[]): string {
  if (leads.length === 0) return "No results."
  const header = `${pad("REPO", 34)} ${"STARS".padStart(6)} ${pad("TITLE", 50)} ${pad("MATCH", 22)} UPDATED`
  const rows = leads.map(
    (l) =>
      `${pad(l.lead_type === "github_issue" ? l.id : l.repo, 34)} ${String(l.repo_stars ?? "?").padStart(6)} ${pad(l.title, 50)} ${pad(l.match.join(","), 22)} ${l.updated_date ?? "—"}`,
  )
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(leads: Lead[]): string {
  if (leads.length === 0) return "No results."
  return leads
    .map((l) =>
      [
        l.title,
        `  ${l.repo} · ★${l.repo_stars ?? "?"} · ${l.labels.slice(0, 6).join(", ") || "no labels"}`,
        `  match: ${l.match.join(", ")} · created ${l.posted_date ?? "—"} · updated ${l.updated_date ?? "—"}`,
        `  ${l.url}`,
      ].join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    let leads: Lead[]
    let totals: number[]
    let dropped = 0
    if (opts.mode === "repos") {
      const q = buildRepoQuery(opts)
      const res = await ghFetch<SearchResponse<RawRepo>>(searchUrl("repositories", q, false), { resource: "search" })
      leads = (res?.data.items ?? []).map(repoToLead).filter((l): l is Lead => l !== null)
      totals = [res?.data.total_count ?? 0]
    } else {
      ;({ leads, totals, dropped } = await searchIssues(opts))
    }

    // Stars: repo search carries them; issue search needs a repo lookup each.
    let stars = { looked_up: 0, unresolved: 0 }
    const start = (opts.page - 1) * opts.limit
    if (opts.mode === "issues" && opts.minStars !== undefined) {
      stars = await enrichStars(leads)
      leads = leads.filter((l) => l.repo_stars !== null && l.repo_stars >= opts.minStars!)
    }
    const pageItems = leads.slice(start, start + opts.limit)
    if (opts.mode === "issues" && opts.minStars === undefined && !opts.noStars) {
      stars = await enrichStars(pageItems)
    }

    const out = stripInvisible(pageItems)
    if (opts.format === "table") {
      process.stdout.write(renderTable(out) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(out) + "\n")
    } else {
      const meta = {
        count: out.length,
        page: opts.page,
        limit: opts.limit,
        total: leads.length,
        github_total_count: totals,
        dropped_no_lead_signal: dropped,
        mode: opts.mode,
        query: opts.query ?? null,
        filters: {
          days: opts.days,
          since: sinceDate(opts.days),
          language: opts.language ?? null,
          min_stars: opts.minStars ?? null,
        },
        repo_lookups: stars.looked_up,
        stars_unresolved: stars.unresolved,
        stars_unresolved_dropped: opts.minStars !== undefined,
        authenticated: !!process.env.GITHUB_TOKEN?.trim(),
      }
      process.stdout.write(JSON.stringify({ meta, results: out }, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    const code = e instanceof CliError ? e.code : "SEARCH_FAILED"
    writeError(redact(e instanceof Error ? e.message : String(e)), code === "HTTP_ERROR" ? "SEARCH_FAILED" : code)
    return 1
  }
}
