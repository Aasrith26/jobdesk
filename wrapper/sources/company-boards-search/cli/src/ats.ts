// One adapter per ATS: board URL, list fetch, single-posting fetch, and the
// normalizer that maps the ATS's JSON onto the shared Job shape. Every field
// the contract names is present on every Job (null when the ATS lacks it).

import {
  cleanText,
  countryName,
  decodeHtmlEntities,
  htmlToText,
  jsonFetch,
  toDate,
  type Ats,
  type Company,
  type FetchOpts,
} from "./helpers.js"

export type WorkplaceType = "remote" | "hybrid" | "onsite"

export interface Job {
  id: string // "<ats>:<token>:<posting id>" - pass as-is to `detail`
  title: string
  company: string
  location: string | null
  date: string | null // first published (YYYY-MM-DD); falls back to updated
  url: string | null
  ats: Ats
  token: string
  department: string | null
  team: string | null
  remote: boolean | null // true/false when the ATS says so; null = unknown
  workplaceType: WorkplaceType | null
  employmentType: string | null
  updated: string | null
  compensation: string | null
  tags: string[]
}

export interface JobDetail extends Job {
  applyUrl: string | null
  description: string | null
}

/** A normalized job plus the raw material the filters need. */
export interface Posting {
  job: Job
  /** Every place string the posting names (primary + secondary + offices). */
  locations: string[]
  /** Extra location text used only for matching (country names, region codes). */
  locationExtra: string[]
  /** Description HTML, or null when the list endpoint carries none (SmartRecruiters). */
  descriptionHtml: string | null
  applyUrl: string | null
}

type Raw = Record<string, any>

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function uniq(values: Array<string | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    const t = cleanText(v)
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase())
      out.push(t)
    }
  }
  return out
}

function joinLocations(locs: string[]): string | null {
  return locs.length ? locs.join("; ") : null
}

function workplaceFrom(text: string | null | undefined): WorkplaceType | null {
  if (!text) return null
  if (/remote/i.test(text)) return "remote"
  if (/hybrid/i.test(text)) return "hybrid"
  if (/on.?site|in.?office|office/i.test(text)) return "onsite"
  return null
}

function remoteFrom(wt: WorkplaceType | null, locations: string[]): boolean | null {
  if (wt) return wt === "remote"
  return locations.some((l) => /\bremote\b/i.test(l)) ? true : null
}

function baseJob(c: Company, id: string, title: string): Job {
  return {
    id: `${c.ats}:${c.token}:${id}`,
    title,
    company: c.name,
    location: null,
    date: null,
    url: null,
    ats: c.ats,
    token: c.token,
    department: null,
    team: null,
    remote: null,
    workplaceType: null,
    employmentType: null,
    updated: null,
    compensation: null,
    tags: c.tags,
  }
}

// ---------------------------------------------------------------------------
// Greenhouse - https://developers.greenhouse.io/job-board.html
// ---------------------------------------------------------------------------

const GH_API = "https://boards-api.greenhouse.io/v1/boards"

export function normalizeGreenhouse(c: Company, j: Raw): Posting | null {
  const title = cleanText(j.title)
  if (j.id === undefined || j.id === null || !title) return null
  const job = baseJob(c, String(j.id), title)
  const offices: Raw[] = Array.isArray(j.offices) ? j.offices : []
  const locations = uniq([j.location?.name])
  const officeLocs = uniq(offices.map((o) => o?.location || o?.name))
  const meta: Raw[] = Array.isArray(j.metadata) ? j.metadata : []
  const wtMeta = meta.find((m) => /location type|workplace|work type|remote/i.test(String(m?.name ?? "")))
  const wt = workplaceFrom(typeof wtMeta?.value === "string" ? wtMeta.value : null) ?? (locations.some((l) => /\bremote\b/i.test(l)) ? "remote" : null)
  job.location = joinLocations(locations.length ? locations : officeLocs)
  job.date = toDate(j.first_published) ?? toDate(j.updated_at)
  job.updated = toDate(j.updated_at)
  job.url = str(j.absolute_url)
  job.department = uniq((Array.isArray(j.departments) ? j.departments : []).map((d: Raw) => d?.name)).join(", ") || null
  job.workplaceType = wt
  job.remote = wt ? wt === "remote" : null
  // `content` is entity-encoded HTML ("&lt;p&gt;"): decode once to get markup.
  const html = typeof j.content === "string" ? decodeHtmlEntities(j.content) : null
  return { job, locations: uniq([...locations, ...officeLocs]), locationExtra: [], descriptionHtml: html, applyUrl: job.url }
}

// ---------------------------------------------------------------------------
// Lever - https://github.com/lever/postings-api
// ---------------------------------------------------------------------------

const LEVER_API = "https://api.lever.co/v0/postings"

function leverDescriptionHtml(j: Raw): string | null {
  const parts: string[] = []
  const intro = str(j.description) ?? [str(j.opening), str(j.descriptionBody)].filter(Boolean).join("\n")
  if (intro) parts.push(intro)
  for (const l of Array.isArray(j.lists) ? j.lists : []) {
    const heading = str(l?.text)
    const content = str(l?.content)
    if (heading) parts.push(`<h3>${heading}</h3>`)
    if (content) parts.push(`<ul>${content}</ul>`)
  }
  const additional = str(j.additional)
  if (additional) parts.push(additional)
  return parts.length ? parts.join("\n") : null
}

function leverSalary(s: Raw | undefined): string | null {
  if (!s || (s.min == null && s.max == null)) return null
  const range = s.min != null && s.max != null && s.min !== s.max ? `${s.min}–${s.max}` : String(s.min ?? s.max)
  const interval = typeof s.interval === "string" ? `/${s.interval.replace(/^per-/, "")}` : ""
  return `${s.currency ? `${s.currency} ` : ""}${range}${interval}`
}

export function normalizeLever(c: Company, j: Raw): Posting | null {
  const title = cleanText(j.text)
  if (!str(j.id) || !title) return null
  const job = baseJob(c, j.id, title)
  const cat: Raw = j.categories ?? {}
  const locations = uniq([cat.location, ...(Array.isArray(cat.allLocations) ? cat.allLocations : [])])
  const rawWt = typeof j.workplaceType === "string" ? j.workplaceType.toLowerCase() : ""
  const wt: WorkplaceType | null = rawWt === "remote" || rawWt === "hybrid" || rawWt === "onsite" ? rawWt : workplaceFrom(locations.join(" ").match(/remote/i)?.[0])
  job.location = joinLocations(locations)
  job.date = toDate(j.createdAt)
  job.updated = toDate(j.updatedAt) ?? job.date
  job.url = str(j.hostedUrl)
  job.department = cleanText(cat.department)
  job.team = cleanText(cat.team)
  job.employmentType = cleanText(cat.commitment)
  job.workplaceType = wt
  job.remote = remoteFrom(wt, locations)
  job.compensation = leverSalary(j.salaryRange)
  return {
    job,
    locations,
    locationExtra: uniq([countryName(j.country)]),
    descriptionHtml: leverDescriptionHtml(j),
    applyUrl: str(j.applyUrl),
  }
}

// ---------------------------------------------------------------------------
// Ashby - https://developers.ashbyhq.com/docs/public-job-posting-api
// ---------------------------------------------------------------------------

const ASHBY_API = "https://api.ashbyhq.com/posting-api/job-board"

function ashbyAddress(a: Raw | undefined): string[] {
  const p: Raw = a?.postalAddress ?? {}
  return [p.addressLocality, p.addressRegion, p.addressCountry].filter((v): v is string => typeof v === "string")
}

export function normalizeAshby(c: Company, j: Raw): Posting | null {
  const title = cleanText(j.title)
  if (!str(j.id) || !title || j.isListed === false) return null
  const job = baseJob(c, j.id, title)
  const secondary: Raw[] = Array.isArray(j.secondaryLocations) ? j.secondaryLocations : []
  const locations = uniq([j.location, ...secondary.map((s) => s?.location)])
  const raw = typeof j.workplaceType === "string" ? j.workplaceType.toLowerCase() : ""
  // Prefer workplaceType: Ashby sets isRemote on hybrid roles too.
  const wt: WorkplaceType | null = raw === "remote" ? "remote" : raw === "hybrid" ? "hybrid" : raw === "onsite" ? "onsite" : j.isRemote === true ? "remote" : null
  job.location = joinLocations(locations)
  job.date = toDate(j.publishedAt)
  job.updated = job.date
  job.url = str(j.jobUrl)
  job.department = cleanText(j.department)
  job.team = cleanText(j.team)
  job.employmentType = cleanText(j.employmentType)
  job.workplaceType = wt
  job.remote = wt ? wt === "remote" : typeof j.isRemote === "boolean" ? j.isRemote : remoteFrom(null, locations)
  const comp: Raw = j.compensation ?? {}
  job.compensation = cleanText(comp.compensationTierSummary) ?? cleanText(comp.scrapeableCompensationSalarySummary)
  return {
    job,
    locations,
    locationExtra: uniq([...ashbyAddress(j.address), ...secondary.flatMap((s) => ashbyAddress(s?.address))]),
    descriptionHtml: str(j.descriptionHtml),
    applyUrl: str(j.applyUrl),
  }
}

// ---------------------------------------------------------------------------
// SmartRecruiters - https://developers.smartrecruiters.com/docs/posting-api
// ---------------------------------------------------------------------------

const SR_API = "https://api.smartrecruiters.com/v1/companies"
const SR_PAGE = 100
export const SR_MAX_PAGES = 10

function srLocation(l: Raw | undefined): string | null {
  if (!l) return null
  const full = typeof l.fullLocation === "string" ? l.fullLocation : [l.city, l.region, countryName(l.country)].filter(Boolean).join(", ")
  return cleanText(full.split(",").map((s: string) => s.trim()).filter(Boolean).join(", "))
}

function srSections(j: Raw): string | null {
  const sections: Raw = j.jobAd?.sections ?? {}
  const parts: string[] = []
  for (const key of ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]) {
    const s = sections[key]
    const text = str(s?.text)
    if (!text) continue
    if (str(s?.title)) parts.push(`<h3>${s.title}</h3>`)
    parts.push(text)
  }
  return parts.length ? parts.join("\n") : null
}

export function normalizeSmartRecruiters(c: Company, j: Raw): Posting | null {
  const title = cleanText(j.name)
  if (!str(j.id) || !title) return null
  const job = baseJob(c, j.id, title)
  const l: Raw = j.location ?? {}
  const locations = uniq([srLocation(l)])
  const wt: WorkplaceType | null = l.remote === true ? "remote" : l.hybrid === true ? "hybrid" : l.remote === false ? "onsite" : null
  job.location = joinLocations(locations)
  job.date = toDate(j.releasedDate)
  job.updated = job.date
  job.url = str(j.postingUrl) ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(c.token)}/${encodeURIComponent(j.id)}`
  job.department = cleanText(j.department?.label) ?? cleanText(j.function?.label)
  job.employmentType = cleanText(j.typeOfEmployment?.label)
  job.workplaceType = wt
  job.remote = wt ? wt === "remote" : null
  return {
    job,
    locations,
    locationExtra: uniq([countryName(l.country), l.region, l.city]),
    descriptionHtml: srSections(j),
    applyUrl: str(j.applyUrl),
  }
}

// ---------------------------------------------------------------------------
// Workable - public widget API (apply.workable.com/api/v1/widget/accounts/<sub>)
// ---------------------------------------------------------------------------

const WORKABLE_API = "https://apply.workable.com/api/v1/widget/accounts"

export function normalizeWorkable(c: Company, j: Raw): Posting | null {
  const title = cleanText(j.title)
  const code = str(j.shortcode)
  if (!code || !title) return null
  const job = baseJob(c, code, title)
  const locs: Raw[] = Array.isArray(j.locations) ? j.locations.filter((l: Raw) => l && l.hidden !== true) : []
  const locations = uniq(
    locs.length
      ? locs.map((l) => [l.city, l.region, l.country].filter(Boolean).join(", "))
      : [[j.city, j.state, j.country].filter(Boolean).join(", ")],
  )
  const wt: WorkplaceType | null = j.telecommuting === true ? "remote" : null
  job.location = joinLocations(locations)
  job.date = toDate(j.published_on) ?? toDate(j.created_at)
  job.updated = job.date
  job.url = `https://apply.workable.com/${encodeURIComponent(c.token)}/j/${encodeURIComponent(code)}/`
  job.department = cleanText(j.department)
  job.employmentType = cleanText(j.employment_type)
  job.workplaceType = wt
  job.remote = j.telecommuting === true ? true : j.telecommuting === false ? false : null
  return {
    job,
    locations,
    locationExtra: uniq(locs.map((l) => l.countryCode).map(countryName)),
    descriptionHtml: str(j.description),
    applyUrl: str(j.application_url),
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export class BoardNotFoundError extends Error {}

/** The public board URL a human would open for a company. */
export function boardUrl(c: Pick<Company, "ats" | "token">): string {
  switch (c.ats) {
    case "greenhouse": return `https://job-boards.greenhouse.io/${c.token}`
    case "lever": return `https://jobs.lever.co/${c.token}`
    case "ashby": return `https://jobs.ashbyhq.com/${c.token}`
    case "smartrecruiters": return `https://jobs.smartrecruiters.com/${c.token}`
    case "workable": return `https://apply.workable.com/${c.token}/`
  }
}

function notFound(c: Company): never {
  throw new BoardNotFoundError(`board not found (404) - check the ${c.ats} token "${c.token}" in companies.json`)
}

function keep(list: Array<Posting | null>): Posting[] {
  return list.filter((p): p is Posting => p !== null)
}

/** Fetch and normalize one company's whole board. Throws on failure (the fan-out records it). */
export async function fetchBoard(c: Company, opts: FetchOpts = {}): Promise<{ postings: Posting[]; truncated: boolean }> {
  const t = encodeURIComponent(c.token)
  switch (c.ats) {
    case "greenhouse": {
      const data = await jsonFetch<Raw>(`${GH_API}/${t}/jobs?content=true`, opts)
      if (!data) notFound(c)
      if (!Array.isArray(data.jobs)) throw new Error("unexpected Greenhouse response (no jobs array)")
      return { postings: keep(data.jobs.map((j: Raw) => normalizeGreenhouse(c, j))), truncated: false }
    }
    case "lever": {
      const data = await jsonFetch<Raw[]>(`${LEVER_API}/${t}?mode=json`, opts)
      if (!data) notFound(c)
      if (!Array.isArray(data)) throw new Error("unexpected Lever response (not an array)")
      return { postings: keep(data.map((j) => normalizeLever(c, j))), truncated: false }
    }
    case "ashby": {
      const data = await jsonFetch<Raw>(`${ASHBY_API}/${t}?includeCompensation=true`, opts)
      if (!data) notFound(c)
      if (!Array.isArray(data.jobs)) throw new Error("unexpected Ashby response (no jobs array)")
      return { postings: keep(data.jobs.map((j: Raw) => normalizeAshby(c, j))), truncated: false }
    }
    case "smartrecruiters": {
      const postings: Posting[] = []
      let total = 0
      for (let page = 0; page < SR_MAX_PAGES; page++) {
        const data = await jsonFetch<Raw>(`${SR_API}/${t}/postings?limit=${SR_PAGE}&offset=${page * SR_PAGE}`, opts)
        if (!data) notFound(c)
        const content: Raw[] = Array.isArray(data.content) ? data.content : []
        total = typeof data.totalFound === "number" ? data.totalFound : 0
        postings.push(...keep(content.map((j) => normalizeSmartRecruiters(c, j))))
        if (content.length < SR_PAGE || (page + 1) * SR_PAGE >= total) {
          return { postings, truncated: false }
        }
      }
      return { postings, truncated: total > SR_MAX_PAGES * SR_PAGE }
    }
    case "workable": {
      const data = await jsonFetch<Raw>(`${WORKABLE_API}/${t}?details=true`, opts)
      if (!data) notFound(c)
      if (!Array.isArray(data.jobs)) throw new Error("unexpected Workable response (no jobs array)")
      return { postings: keep(data.jobs.map((j: Raw) => normalizeWorkable(c, j))), truncated: false }
    }
  }
}

/** Fetch one posting. Returns null when the ATS says it does not exist. */
export async function fetchPosting(c: Company, id: string, opts: FetchOpts = {}): Promise<Posting | null> {
  const t = encodeURIComponent(c.token)
  const i = encodeURIComponent(id)
  switch (c.ats) {
    case "greenhouse": {
      const data = await jsonFetch<Raw>(`${GH_API}/${t}/jobs/${i}`, opts)
      return data ? normalizeGreenhouse(c, data) : null
    }
    case "lever": {
      const data = await jsonFetch<Raw>(`${LEVER_API}/${t}/${i}?mode=json`, opts)
      return data && !Array.isArray(data) ? normalizeLever(c, data) : null
    }
    case "smartrecruiters": {
      const data = await jsonFetch<Raw>(`${SR_API}/${t}/postings/${i}`, opts)
      return data ? normalizeSmartRecruiters(c, data) : null
    }
    // Ashby and Workable have no public single-posting endpoint: read the
    // board (which already carries full descriptions) and pick the posting.
    case "ashby":
    case "workable": {
      const { postings } = await fetchBoard(c, opts).catch((e) => {
        if (e instanceof BoardNotFoundError) return { postings: [] as Posting[] }
        throw e
      })
      const want = `${c.ats}:${c.token}:${id}`.toLowerCase()
      return postings.find((p) => p.job.id.toLowerCase() === want) ?? null
    }
  }
}

/** Posting -> the detail shape (job fields + apply link + readable description). */
export function toDetail(p: Posting): JobDetail {
  return { ...p.job, applyUrl: p.applyUrl, description: htmlToText(p.descriptionHtml) }
}
