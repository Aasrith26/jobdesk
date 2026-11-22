import {
  CliError,
  batchMatches,
  batchRank,
  cleanText,
  companyUrl,
  loadJson,
  matchesLocation,
  matchesQuery,
  remoteKind,
  shortBatch,
  snippet,
  stripInvisible,
  writeError,
  type YcCompany,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  batches?: { season: string | null; year: string }[]
  location?: string
  remote: boolean
  refresh: boolean
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

export interface Lead {
  id: string
  title: string
  company: string
  location: string | null
  date: null
  posted_date: null
  url: string
  apply_url: string | null
  remote: boolean | null
  remote_kind: "fully" | "partly" | "remote" | null
  work_mode: string[]
  salary: null
  employment_type: null
  india_friendly: boolean | null
  india_reason: string | null
  header: string
  snippet: string | null
  author: null
  kind: "lead"
  lead_type: "yc_hiring"
  one_liner: string | null
  batch: string | null
  stage: string | null
  team_size: number | null
  status: string | null
  industries: string[]
  tags: string[]
  regions: string[]
  website: string | null
  top_company: boolean
}

export function toLead(c: YcCompany): Lead {
  const url = companyUrl(c)
  const kind = remoteKind(c.regions)
  const regions = c.regions ?? []
  const inIndia = regions.includes("India") || /\bindia\b/i.test(c.all_locations ?? "")
  const oneLiner = cleanText(c.one_liner)
  const b = shortBatch(c.batch)
  return {
    id: c.slug,
    title: `${c.name} is hiring`,
    company: c.name,
    location: cleanText(c.all_locations),
    // The directory carries no job-posting date (launched_at is the company's
    // launch, not a posting); never infer one.
    date: null,
    posted_date: null,
    url,
    apply_url: url.startsWith("https://www.ycombinator.com/companies/") ? `${url}/jobs` : null,
    // The directory lists remote regions when a company accepts remote; absence says nothing, so no `false`.
    remote: kind !== null ? true : null,
    remote_kind: kind,
    work_mode: kind ? ["remote"] : [],
    salary: null,
    employment_type: null,
    // Only the explicit signal the directory gives: an India office/region. Remote-friendliness is in remote_kind.
    india_friendly: inIndia,
    india_reason: inIndia ? "explicit" : null,
    header: `${c.name}${b ? ` (YC ${b})` : ""}${oneLiner ? ` · ${oneLiner}` : ""}`,
    snippet: snippet(cleanText(c.long_description) ?? oneLiner),
    author: null,
    kind: "lead",
    lead_type: "yc_hiring",
    one_liner: oneLiner,
    batch: c.batch ?? null,
    stage: c.stage ?? null,
    team_size: typeof c.team_size === "number" ? c.team_size : null,
    status: c.status ?? null,
    industries: c.industries ?? [],
    tags: c.tags ?? [],
    regions,
    website: c.website && /^https?:\/\//i.test(c.website) ? c.website : null,
    top_company: c.top_company === true,
  }
}

export function applyFilters(companies: YcCompany[], opts: Pick<SearchOpts, "query" | "batches" | "location" | "remote">): YcCompany[] {
  return companies
    .filter((c) => c.isHiring !== false && c.name && c.slug)
    .filter((c) => matchesQuery(c, opts.query))
    .filter((c) => !opts.batches?.length || batchMatches(c.batch, opts.batches))
    .filter((c) => matchesLocation(c, opts.location))
    .filter((c) => !opts.remote || remoteKind(c.regions) !== null)
    .sort((a, b) => batchRank(b.batch) - batchRank(a.batch) || a.name.localeCompare(b.name))
}

function pad(s: string | null | undefined, n: number): string {
  const v = (s ?? "—").replace(/\s+/g, " ")
  return (v.length > n ? v.slice(0, n - 1) + "…" : v).padEnd(n)
}

function renderTable(leads: Lead[]): string {
  if (leads.length === 0) return "No results."
  const header = `${pad("COMPANY", 22)} ${"BATCH".padEnd(5)} ${"SIZE".padStart(5)} ${pad("REMOTE", 7)} ${pad("LOCATION", 28)} ONE-LINER`
  const rows = leads.map(
    (l) =>
      `${pad(l.company, 22)} ${(shortBatch(l.batch) ?? "—").padEnd(5)} ${String(l.team_size ?? "?").padStart(5)} ${pad(l.remote_kind ?? "no", 7)} ${pad(l.location, 28)} ${pad(l.one_liner, 60).trimEnd()}`,
  )
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(leads: Lead[]): string {
  if (leads.length === 0) return "No results."
  return leads
    .map((l) =>
      [
        l.header,
        `  ${l.location ?? "—"} · team ${l.team_size ?? "?"} · ${l.stage ?? "—"} · remote: ${l.remote_kind ?? "no"}`,
        `  ${l.url}${l.apply_url ? `\n  jobs: ${l.apply_url}` : ""}`,
      ].join("\n"),
    )
    .join("\n\n")
}

interface Meta {
  last_updated?: string
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const companies = await loadJson<YcCompany[]>("companies/hiring.json", { refresh: opts.refresh })
    if (!Array.isArray(companies.data)) throw new CliError("companies/hiring.json is not a JSON array", "BAD_RESPONSE")
    // meta.json is small; a failure there must not fail the search.
    const meta = await loadJson<Meta>("meta.json", { refresh: opts.refresh }).catch(() => null)

    const filtered = applyFilters(companies.data, opts)
    const start = (opts.page - 1) * opts.limit
    const pageItems = stripInvisible(filtered.slice(start, start + opts.limit).map(toLead))

    if (opts.format === "table") {
      process.stdout.write(renderTable(pageItems) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(pageItems) + "\n")
    } else {
      const out = {
        meta: {
          count: pageItems.length,
          page: opts.page,
          limit: opts.limit,
          total: filtered.length,
          scanned: companies.data.length,
          query: opts.query ?? null,
          filters: {
            batch: opts.batches?.map((b) => (b.season ? `${b.season} ${b.year}` : b.year)) ?? null,
            location: opts.location ?? null,
            remote: opts.remote,
          },
          source: "https://yc-oss.github.io/api/companies/hiring.json",
          data_last_updated: meta?.data.last_updated ?? null,
          cache: companies.cache,
          fetched_at: companies.fetched_at,
        },
        results: pageItems,
      }
      process.stdout.write(JSON.stringify(out, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), e instanceof CliError && e.code !== "HTTP_ERROR" ? e.code : "SEARCH_FAILED")
    return 1
  }
}
