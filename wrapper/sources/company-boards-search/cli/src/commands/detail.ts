import { fetchPosting, toDetail, type JobDetail } from "../ats.js"
import { isAts, stripInvisible, writeError, type Ats, type Company } from "../helpers.js"

export interface DetailOpts {
  ref: string
  companies: Company[]
  format: "json" | "plain"
  timeoutMs?: number
}

export interface DetailRef {
  ats: Ats
  token: string
  id: string
}

const SLUG = /^[A-Za-z0-9._-]+$/

function ref(ats: Ats, token: string | undefined, id: string | undefined): DetailRef | null {
  if (!token || !id || !SLUG.test(token) || !SLUG.test(id)) return null
  return { ats, token, id }
}

/**
 * Parse a `detail` argument: the `<ats>:<token>:<id>` id a search result
 * carries, or a posting URL on one of the five ATS hosts. Host and path are
 * read through real URL parsing, so look-alike hosts (jobs.lever.co.evil.io)
 * and userinfo tricks are rejected. A Greenhouse posting embedded on a
 * company's own site (?gh_jid=) does not name its board token, so it is
 * rejected with a pointer to the id form.
 */
export function parseDetailRef(input: string): DetailRef | null {
  const trimmed = input.trim()
  const idForm = trimmed.match(/^([a-z]+):([^:/\s]+):([^:/\s]+)$/i)
  if (idForm) {
    const ats = idForm[1].toLowerCase()
    return isAts(ats) ? ref(ats, idForm[2], idForm[3]) : null
  }

  const hasScheme = /^https?:\/\//i.test(trimmed)
  let url: URL
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)

  // job-boards.greenhouse.io/<token>/jobs/<id>, boards.greenhouse.io, *.eu.greenhouse.io,
  // boards.greenhouse.io/embed/job_app?for=<token>&token=<id>, boards-api.greenhouse.io/v1/boards/<token>/jobs/<id>
  if (/^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) {
    if (parts[0] === "embed") return ref("greenhouse", url.searchParams.get("for") ?? undefined, url.searchParams.get("token") ?? undefined)
    return parts[1] === "jobs" ? ref("greenhouse", parts[0], parts[2]) : null
  }
  if (host === "boards-api.greenhouse.io") {
    return parts[0] === "v1" && parts[1] === "boards" && parts[3] === "jobs" ? ref("greenhouse", parts[2], parts[4]) : null
  }
  // jobs.lever.co/<site>/<id>[/apply], jobs.eu.lever.co, api.lever.co/v0/postings/<site>/<id>
  if (/^jobs(?:\.eu)?\.lever\.co$/.test(host)) return ref("lever", parts[0], parts[1])
  if (/^api(?:\.eu)?\.lever\.co$/.test(host)) {
    return parts[0] === "v0" && parts[1] === "postings" ? ref("lever", parts[2], parts[3]) : null
  }
  // jobs.ashbyhq.com/<name>/<id>[/application]
  if (host === "jobs.ashbyhq.com") return ref("ashby", parts[0], parts[1])
  // jobs.smartrecruiters.com/<Company>/<id>-<slug>
  if (host === "jobs.smartrecruiters.com") {
    const id = parts[1]?.match(/^(\d+)/)?.[1]
    return ref("smartrecruiters", parts[0], id)
  }
  // apply.workable.com/<sub>/j/<shortcode>/
  if (host === "apply.workable.com") {
    return parts[1] === "j" ? ref("workable", parts[0], parts[2]) : null
  }
  return null
}

/** Use the configured company (display name, tags) when the board is in companies.json. */
export function companyFor(r: DetailRef, companies: Company[]): Company {
  const hit = companies.find((c) => c.ats === r.ats && c.token.toLowerCase() === r.token.toLowerCase())
  return hit ?? { name: r.token, ats: r.ats, token: r.token, tags: [] }
}

export function renderDetailPlain(job: JobDetail): string {
  const lines = [
    job.title,
    `${job.company} · ${job.location ?? "—"}`,
    "",
    job.department ? `Department: ${job.department}` : "",
    job.team ? `Team: ${job.team}` : "",
    job.workplaceType ? `Workplace: ${job.workplaceType}` : job.remote ? "Workplace: remote" : "",
    job.employmentType ? `Employment: ${job.employmentType}` : "",
    job.compensation ? `Compensation: ${job.compensation}` : "",
    job.date ? `Published: ${job.date}` : "",
    `ATS: ${job.ats} (${job.token})`,
    "",
    job.description || "(no description)",
    "",
    `URL: ${job.url ?? "—"}`,
    job.applyUrl && job.applyUrl !== job.url ? `Apply: ${job.applyUrl}` : "",
    `ID: ${job.id}`,
  ]
  return lines.filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== "")).join("\n").trim()
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const r = parseDetailRef(opts.ref)
  if (!r) {
    writeError(
      `Could not parse "${opts.ref}" - pass a search result id (<ats>:<token>:<id>, e.g. ashby:sarvam:<uuid>) or a posting URL on job-boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, jobs.smartrecruiters.com or apply.workable.com/<account>/j/<code>`,
      "BAD_ID",
    )
    return 1
  }
  const company = companyFor(r, opts.companies)
  const posting = await fetchPosting(company, r.id, { timeoutMs: opts.timeoutMs })
  if (!posting) {
    writeError(`Job not found: ${r.ats}:${r.token}:${r.id} (closed, or wrong token/id)`, "NOT_FOUND")
    return 1
  }
  const job = stripInvisible(toDetail(posting))
  if (opts.format === "plain") {
    process.stdout.write(renderDetailPlain(job) + "\n")
  } else {
    process.stdout.write(JSON.stringify(job, null, 2) + "\n")
  }
  return 0
}
