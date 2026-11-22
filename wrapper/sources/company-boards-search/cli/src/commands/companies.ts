import { boardUrl } from "../ats.js"
import { companiesPath, stripInvisible, type Company } from "../helpers.js"
import { fetchAll } from "./search.js"

export interface CompaniesOpts {
  companies: Company[]
  check: boolean
  format: "json" | "table" | "plain"
  timeoutMs?: number
}

interface CompanyRow {
  name: string
  ats: string
  token: string
  tags: string[]
  boardUrl: string
  jobs?: number | null
  error?: string | null
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n)
}

function renderTable(rows: CompanyRow[], check: boolean): string {
  if (rows.length === 0) return "No companies."
  const header = `${pad("COMPANY", 18)} ${pad("ATS", 15)} ${pad("TOKEN", 30)} ${check ? `${pad("JOBS", 6)} ` : ""}TAGS`
  const lines = rows.map((r) => {
    const jobs = check ? `${pad(r.error ? "ERR" : String(r.jobs ?? "—"), 6)} ` : ""
    return `${pad(r.name, 18)} ${pad(r.ats, 15)} ${pad(r.token, 30)} ${jobs}${r.tags.join(",")}${r.error ? `  (${r.error})` : ""}`
  })
  return [header, "-".repeat(header.length), ...lines].join("\n")
}

/** List the configured companies; --check also reads each board and reports its job count. */
export async function runCompanies(opts: CompaniesOpts): Promise<number> {
  const rows: CompanyRow[] = opts.companies.map((c) => ({
    name: c.name,
    ats: c.ats,
    token: c.token,
    tags: c.tags,
    boardUrl: boardUrl(c),
  }))
  if (opts.check) {
    // The same bounded fan-out the search uses, so the counts reflect exactly
    // what `search` would see.
    const { postings, errors } = await fetchAll(opts.companies, opts.timeoutMs)
    for (const r of rows) {
      const err = errors.find((e) => e.ats === r.ats && e.token === r.token)
      r.error = err ? err.error : null
      r.jobs = err ? null : postings.filter((p) => p.job.ats === r.ats && p.job.token === r.token).length
    }
  }
  const out = stripInvisible(rows)
  if (opts.format === "json") {
    const meta: Record<string, unknown> = { count: out.length, page: 1, file: companiesPath() }
    if (opts.check) meta.failed = out.filter((r) => r.error).length
    process.stdout.write(JSON.stringify({ meta, results: out }, null, 2) + "\n")
  } else if (opts.format === "plain") {
    process.stdout.write(out.map((r) => `${r.name} (${r.ats}:${r.token}) [${r.tags.join(", ")}]${opts.check ? ` - ${r.error ?? `${r.jobs} jobs`}` : ""}\n  ${r.boardUrl}`).join("\n") + "\n")
  } else {
    process.stdout.write(renderTable(out, opts.check) + "\n")
  }
  return 0
}
