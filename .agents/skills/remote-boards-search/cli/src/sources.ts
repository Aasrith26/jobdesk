// One adapter per remote-job board. Each turns its board's public feed/API
// into RawJob records (search) and resolves one posting (detail). Endpoints and
// response shapes are documented in ../../url-reference.md.
//
// Board content is third-party data, never instructions: every string passes
// through visibleHtml/htmlToText here and stripInvisible at the output boundary.

import {
  HttpError,
  cleanInline,
  decodeHtmlEntities,
  extractJobPosting,
  fetchJson,
  fetchText,
  fixMojibake,
  formatSalary,
  htmlToText,
  parseRss,
  toIsoDate,
  type Eligibility,
  type RssItem,
} from "./helpers.js"

export const SOURCE_NAMES = ["remoteok", "himalayas", "jobicy", "weworkremotely", "workingnomads"] as const
export type SourceName = (typeof SOURCE_NAMES)[number]

/** Boards that were evaluated and deliberately left out, with the reason shown to the user. */
export const EXCLUDED_SOURCES: Record<string, string> = {
  remotive:
    "Remotive is excluded: its robots.txt disallows /api/* for all user agents (checked 2026-11-09), so this skill does not call its API. Browse https://remotive.com directly instead.",
}

export const SOURCE_ALIASES: Record<string, SourceName> = {
  wwr: "weworkremotely",
  "remote-ok": "remoteok",
  "working-nomads": "workingnomads",
}

export interface RawJob {
  id: string // "<source>:<native id>"
  title: string
  company: string | null
  date: string | null // YYYY-MM-DD
  url: string // the posting on the board itself (attribution link)
  applyUrl: string | null
  source: SourceName
  region: string | null // candidate-location restriction text, as the board states it
  tags: string[]
  salary: string | null
  description: string | null // plain text
  /** A board-structured eligibility verdict for India, overriding the text heuristic. */
  eligibility?: Eligibility
}

export interface JobDetail extends RawJob {
  employmentType: string | null
  validThrough: string | null
  status: "open" | "closed" | "unknown"
}

export interface SearchParams {
  query?: string
  indiaFriendly: boolean
  timeoutMs: number
}

export interface Source {
  name: SourceName
  label: string
  home: string
  attribution: string
  search(p: SearchParams): Promise<RawJob[]>
  detail(nativeId: string, timeoutMs: number): Promise<JobDetail | null>
  /** Native id from a URL on this board, or null when the URL is not a posting here. */
  idFromUrl(url: URL): string | null
}

const hasOr = (q: string) => /\sOR\s/.test(q)
const firstAlternative = (q: string) => q.split(/\s+OR\s+/)[0].trim()
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function blankDetail(job: RawJob): JobDetail {
  return { ...job, employmentType: null, validThrough: null, status: "unknown" }
}

/** Some JSON-LD descriptions are flat text with inline "•" bullets: give each bullet its own line. */
function bulletBreaks(text: string | null): string | null {
  if (!text || text.includes("\n")) return text
  return text.replace(/\s+•\s+/g, "\n• ")
}

/**
 * Map a schema.org JobPosting (ld+json on a board's own posting page) to a
 * JobDetail. Used for boards whose API has no single-posting endpoint.
 */
export function jobFromJsonLd(
  ld: Record<string, unknown>,
  source: SourceName,
  nativeId: string,
  url: string,
): JobDetail {
  const org = ld.hiringOrganization as Record<string, unknown> | undefined
  const reqs = ld.applicantLocationRequirements
  const reqList = (Array.isArray(reqs) ? reqs : reqs ? [reqs] : [])
    .map((r) => (r && typeof r === "object" ? str((r as Record<string, unknown>).name) : str(r)))
    .filter((x): x is string => !!x)
  // Long country lists (We Work Remotely lists ~250 for "Anywhere") read as worldwide.
  const hasIndia = reqList.some((c) => /\bindia\b/i.test(c))
  const region = reqList.length === 0
    ? null
    : reqList.length > 150
      ? "Anywhere in the World"
      : reqList.length > 6
        ? `${reqList.slice(0, 3).join(", ")} +${reqList.length - 3} more countries${hasIndia ? " (incl. India)" : ""}`
        : reqList.join(", ")
  const salary = ld.baseSalary as Record<string, unknown> | undefined
  const value = salary?.value as Record<string, unknown> | undefined
  let rawDesc = str(ld.description) ?? ""
  // Some boards entity-encode the markup inside JSON-LD ("&lt;p&gt;").
  if (!/<[a-z]/i.test(rawDesc) && /&lt;[a-z]/i.test(rawDesc)) rawDesc = decodeHtmlEntities(rawDesc)
  const et = ld.employmentType
  const validThrough = str(ld.validThrough)
  const closed = validThrough ? new Date(validThrough).getTime() < Date.now() : false
  return {
    id: `${source}:${nativeId}`,
    title: cleanInline(str(ld.title)) || "(untitled)",
    company: cleanInline(str(org?.name)) || null,
    date: toIsoDate(str(ld.datePosted)),
    url,
    applyUrl: null,
    source,
    region,
    tags: [],
    salary: value
      ? formatSalary(value.minValue ?? value.value, value.maxValue, str(salary?.currency), str(value.unitText))
      : null,
    description: bulletBreaks(htmlToText(rawDesc)),
    employmentType: Array.isArray(et) ? et.join(", ") : str(et),
    validThrough: toIsoDate(validThrough),
    status: closed ? "closed" : "unknown",
  }
}

async function detailFromPage(pageUrl: string, source: SourceName, nativeId: string, timeoutMs: number) {
  const html = await fetchText(pageUrl, { accept: "text/html,application/xhtml+xml", timeoutMs })
  if (!html) return null
  const ld = extractJobPosting(html)
  return ld ? jobFromJsonLd(ld, source, nativeId, pageUrl) : null
}

// ---------------------------------------------------------------------------
// Remote OK — https://remoteok.com/api
// ---------------------------------------------------------------------------

export function mapRemoteOk(j: Record<string, unknown>): RawJob | null {
  const nativeId = j.id !== undefined && j.id !== null ? String(j.id) : null
  const title = str(j.position)
  if (!nativeId || !title) return null // the first element is the legal notice
  const fx = (v: unknown) => (typeof v === "string" ? fixMojibake(v) : v)
  const url = (str(j.url) ?? `https://remoteok.com/remote-jobs/${nativeId}`).replace(/^https:\/\/remoteOK\.com/i, "https://remoteok.com")
  return {
    id: `remoteok:${nativeId}`,
    title: cleanInline(fx(title) as string),
    company: cleanInline(fx(str(j.company)) as string | null) || null,
    date: toIsoDate(str(j.date) ?? (typeof j.epoch === "number" ? j.epoch : null)),
    url,
    applyUrl: str(j.apply_url)?.replace(/^https:\/\/remoteOK\.com/i, "https://remoteok.com") ?? null,
    source: "remoteok",
    region: cleanInline(fx(str(j.location)) as string | null).replace(/,\s*$/, "") || null,
    tags: Array.isArray(j.tags) ? j.tags.filter((t): t is string => typeof t === "string").map((t) => fixMojibake(t)) : [],
    salary: formatSalary(j.salary_min, j.salary_max, "USD", "year"),
    description: htmlToText(fx(str(j.description)) as string | null),
  }
}

export function remoteOkTag(query: string): string {
  return firstAlternative(query).toLowerCase().trim().replace(/\s+/g, "-")
}

const remoteok: Source = {
  name: "remoteok",
  label: "Remote OK",
  home: "https://remoteok.com",
  attribution: "Remote OK (https://remoteok.com) - API terms: link back to the job's Remote OK URL and mention Remote OK as the source.",
  async search(p) {
    const url = p.query && !hasOr(p.query)
      ? `https://remoteok.com/api?tag=${encodeURIComponent(remoteOkTag(p.query))}`
      : "https://remoteok.com/api"
    const data = await fetchJson<unknown[]>(url, { timeoutMs: p.timeoutMs })
    if (!Array.isArray(data)) return []
    return data.map((j) => (j && typeof j === "object" ? mapRemoteOk(j as Record<string, unknown>) : null)).filter((x): x is RawJob => !!x)
  },
  async detail(nativeId, timeoutMs) {
    // The API has no single-job endpoint; the unfiltered feed carries the newest
    // postings with full descriptions. Older ones fall back to the posting page's JSON-LD.
    const data = await fetchJson<unknown[]>("https://remoteok.com/api", { timeoutMs })
    const hit = Array.isArray(data)
      ? data.find((j) => j && typeof j === "object" && String((j as Record<string, unknown>).id) === nativeId)
      : undefined
    if (hit) {
      const job = mapRemoteOk(hit as Record<string, unknown>)
      return job ? blankDetail(job) : null
    }
    return detailFromPage(`https://remoteok.com/remote-jobs/${nativeId}`, "remoteok", nativeId, timeoutMs)
  },
  idFromUrl(u) {
    if (!/(^|\.)remoteok\.(com|io)$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/(?:remote-jobs|l)\/(?:[^/]*-)?(\d+)\/?$/)
    return m ? m[1] : null
  },
}

// ---------------------------------------------------------------------------
// Himalayas — https://himalayas.app/jobs/api
// ---------------------------------------------------------------------------

const INDIA_UTC_OFFSET = 5.5

function fmtOffset(o: number): string {
  const sign = o < 0 ? "-" : "+"
  const a = Math.abs(o)
  const h = Math.floor(a)
  const m = Math.round((a - h) * 60)
  return `UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`
}

/** [-10,-9,-8,-7,-6,-5,14] -> "UTC-10..UTC-5, UTC+14": consecutive whole-hour runs collapsed. */
export function tzRuns(tzs: number[]): string {
  const sorted = [...new Set(tzs)].sort((a, b) => a - b)
  const runs: [number, number][] = []
  for (const o of sorted) {
    const last = runs[runs.length - 1]
    if (last && o - last[1] === 1) last[1] = o
    else runs.push([o, o])
  }
  return runs.map(([a, b]) => (a === b ? fmtOffset(a) : `${fmtOffset(a)}..${fmtOffset(b)}`)).join(", ")
}

export function mapHimalayas(j: Record<string, unknown>): RawJob | null {
  const guid = str(j.guid)
  const title = str(j.title)
  if (!guid || !title) return null
  const m = guid.match(/\/companies\/([^/]+)\/jobs\/([^/?#]+)/)
  const nativeId = m ? `${m[1]}/${m[2]}` : guid
  const locs = Array.isArray(j.locationRestrictions)
    ? j.locationRestrictions.filter((x): x is string => typeof x === "string")
    : []
  const tzs = Array.isArray(j.timezoneRestrictions)
    ? j.timezoneRestrictions.filter((x): x is number => typeof x === "number")
    : []
  // Per Himalayas' docs: open to a country when locationRestrictions is empty or
  // names it, and timezoneRestrictions includes its standard offset (+5:30 for India).
  const locOk = locs.length === 0 || locs.some((l) => /\bindia\b/i.test(l))
  const tzOk = tzs.length === 0 || tzs.includes(INDIA_UTC_OFFSET)
  // Some postings list 100+ countries; keep the text scannable but say whether India is in it.
  let region = locs.length === 0
    ? "Worldwide"
    : locs.length > 6
      ? `${locs.slice(0, 3).join(", ")} +${locs.length - 3} more countries${locs.some((l) => /\bindia\b/i.test(l)) ? " (incl. India)" : ""}`
      : locs.join(", ")
  if (tzs.length && !tzOk) {
    region += ` (timezones ${tzRuns(tzs)})`
  }
  const cats = [
    ...(Array.isArray(j.parentCategories) ? j.parentCategories : []),
    ...(Array.isArray(j.categories) ? j.categories : []),
  ].filter((x): x is string => typeof x === "string").map((c) => c.replace(/-/g, " "))
  const seniority = Array.isArray(j.seniority) ? j.seniority.filter((x): x is string => typeof x === "string") : []
  return {
    id: `himalayas:${nativeId}`,
    title: cleanInline(title),
    company: cleanInline(str(j.companyName)) || null,
    date: toIsoDate(typeof j.pubDate === "number" ? j.pubDate : str(j.pubDate)),
    url: guid,
    applyUrl: str(j.applicationLink),
    source: "himalayas",
    region,
    tags: [...new Set([...cats, ...seniority, ...(str(j.employmentType) ? [str(j.employmentType) as string] : [])])],
    salary: formatSalary(j.minSalary, j.maxSalary, str(j.currency), str(j.salaryPeriod) ?? "annual"),
    description: htmlToText(str(j.description) ?? str(j.excerpt)),
    eligibility: locOk && tzOk ? "friendly" : "restricted",
  }
}

const himalayas: Source = {
  name: "himalayas",
  label: "Himalayas",
  home: "https://himalayas.app",
  attribution:
    "Himalayas (https://himalayas.app) - API terms: show a visible link to the job on Himalayas, use applicationLink unchanged for applying, do not pass jobs on to other job boards/aggregators.",
  async search(p) {
    // Only the first page of /jobs/api/search is requested: robots.txt disallows
    // `/jobs*&page=` and `/jobs/*?page=`, so search pagination is off-limits.
    const params = new URLSearchParams()
    // An OR query sends only its first alternative: Himalayas reads all words as
    // one query, and "llm rag vllm" live-returned 4 jobs where "llm" fills a page.
    if (p.query) params.set("q", firstAlternative(p.query))
    if (p.indiaFriendly) params.set("country", "IN") // includes worldwide roles open to India
    const url = params.toString()
      ? `https://himalayas.app/jobs/api/search?${params.toString()}`
      : "https://himalayas.app/jobs/api?limit=20"
    const data = await fetchJson<{ jobs?: unknown[] }>(url, { timeoutMs: p.timeoutMs })
    const jobs = Array.isArray(data?.jobs) ? data.jobs : []
    return jobs.map((j) => (j && typeof j === "object" ? mapHimalayas(j as Record<string, unknown>) : null)).filter((x): x is RawJob => !!x)
  },
  async detail(nativeId, timeoutMs) {
    const m = nativeId.match(/^([a-z0-9-]+)\/([a-z0-9-]+)$/i)
    if (!m) return null
    try {
      const data = await fetchJson<{ job?: Record<string, unknown> }>(
        `https://himalayas.app/jobs/api/companies/${m[1]}/jobs/${m[2]}`,
        { timeoutMs },
      )
      if (!data?.job) return null
      const job = mapHimalayas(data.job)
      if (!job) return null
      const expiry = typeof data.job.expiryDate === "number" ? data.job.expiryDate : null
      return {
        ...blankDetail(job),
        employmentType: str(data.job.employmentType),
        validThrough: expiry ? toIsoDate(expiry) : null,
        status: "open", // the endpoint answers 200 only for open jobs
      }
    } catch (e) {
      // 410 Gone = the job has closed (documented by Himalayas).
      if (e instanceof HttpError && e.status === 410) {
        return {
          ...blankDetail({
            id: `himalayas:${nativeId}`,
            title: "(closed posting)",
            company: null,
            date: null,
            url: `https://himalayas.app/companies/${m[1]}/jobs/${m[2]}`,
            applyUrl: null,
            source: "himalayas",
            region: null,
            tags: [],
            salary: null,
            description: null,
          }),
          status: "closed",
        }
      }
      throw e
    }
  },
  idFromUrl(u) {
    if (!/(^|\.)himalayas\.app$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/(?:jobs\/api\/)?companies\/([^/]+)\/jobs\/([^/]+)\/?$/)
    return m ? `${m[1]}/${m[2]}` : null
  },
}

// ---------------------------------------------------------------------------
// Jobicy — https://jobicy.com/api/jobs
// ---------------------------------------------------------------------------

export function mapJobicy(j: Record<string, unknown>): RawJob | null {
  const nativeId = j.id !== undefined && j.id !== null ? String(j.id) : null
  const title = str(j.jobTitle)
  if (!nativeId || !title) return null
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
  const level = str(j.jobLevel)
  return {
    id: `jobicy:${nativeId}`,
    title: cleanInline(title),
    company: cleanInline(str(j.companyName)) || null,
    date: toIsoDate(str(j.pubDate)),
    url: str(j.url) ?? `https://jobicy.com/jobs/${nativeId}`,
    applyUrl: str(j.url),
    source: "jobicy",
    region: cleanInline(str(j.jobGeo)).replace(/\s*,\s*/g, ", ") || null,
    tags: [...arr(j.jobIndustry), ...arr(j.jobType), ...(level && level !== "Any" ? [level] : [])].map((t) => cleanInline(t)),
    salary: formatSalary(j.salaryMin ?? j.annualSalaryMin, j.salaryMax ?? j.annualSalaryMax, str(j.salaryCurrency), str(j.salaryPeriod)),
    description: htmlToText(str(j.jobDescription) ?? str(j.jobExcerpt)),
  }
}

const jobicy: Source = {
  name: "jobicy",
  label: "Jobicy",
  home: "https://jobicy.com",
  attribution: "Jobicy (https://jobicy.com) - API notice: clearly credit Jobicy with a direct link to the source; apply buttons must go to the job URL from the feed.",
  async search(p) {
    // `tag` matches job titles only; an OR query drops it and filters client-side.
    const useTag = !!p.query && !hasOr(p.query)
    const params = new URLSearchParams({ count: useTag ? "50" : "100" })
    if (useTag) params.set("tag", p.query as string)
    const data = await fetchJson<{ jobs?: unknown[] }>(`https://jobicy.com/api/jobs?${params.toString()}`, {
      timeoutMs: p.timeoutMs,
    })
    const jobs = Array.isArray(data?.jobs) ? data.jobs : []
    return jobs.map((j) => (j && typeof j === "object" ? mapJobicy(j as Record<string, unknown>) : null)).filter((x): x is RawJob => !!x)
  },
  async detail(nativeId, timeoutMs) {
    // No single-job JSON endpoint in the public API; the posting page (allowed by
    // robots.txt) carries a schema.org JobPosting with the full description.
    const id = nativeId.match(/^(\d+)/)?.[1]
    if (!id) return null
    return detailFromPage(`https://jobicy.com/jobs/${id}`, "jobicy", id, timeoutMs)
  },
  idFromUrl(u) {
    if (!/(^|\.)jobicy\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/jobs\/(\d+)(?:-[^/]*)?\/?$/)
    return m ? m[1] : null
  },
}

// ---------------------------------------------------------------------------
// We Work Remotely — https://weworkremotely.com/remote-jobs.rss
// ---------------------------------------------------------------------------

export function mapWwr(item: RssItem): RawJob | null {
  const link = item.link ?? item.guid
  if (!link || !item.title) return null
  const slug = link.match(/\/remote-jobs\/([^/?#]+)/)?.[1]
  if (!slug) return null
  const rawTitle = cleanInline(item.title)
  const sep = rawTitle.indexOf(": ")
  const company = sep > 0 ? rawTitle.slice(0, sep).trim() : null
  const title = sep > 0 ? rawTitle.slice(sep + 2).trim() : rawTitle
  const tags = [item.fields.category, item.fields.type, item.fields.skills]
    .filter((x): x is string => !!x)
    .flatMap((x) => cleanInline(decodeHtmlEntities(x)).split(/\s*,\s*/))
    .map((t) => t.replace(/^and\s+/i, "").trim())
    .filter(Boolean)
  // <region> is coarse ("Anywhere in the World" is the default); when the
  // all-jobs feed also carries a <country> list, that list is the real
  // restriction (a LATAM-only role can be labelled "Anywhere in the World").
  const countries = item.fields.country
    ? cleanInline(decodeHtmlEntities(item.fields.country))
        .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
        .split(/\s*,\s*(?:and\s+)?|\s+and\s+/)
        .map((c) => c.trim())
        .filter(Boolean)
    : []
  const coarse = item.fields.region ? cleanInline(decodeHtmlEntities(item.fields.region)) || null : null
  const region = countries.length === 0
    ? coarse
    : countries.length > 6
      ? `${countries.slice(0, 3).join(", ")} +${countries.length - 3} more countries${countries.some((c) => /\bindia\b/i.test(c)) ? " (incl. India)" : ""}`
      : countries.join(", ")
  return {
    id: `weworkremotely:${slug}`,
    title,
    company,
    date: toIsoDate(item.pubDate),
    url: `https://weworkremotely.com/remote-jobs/${slug}`,
    applyUrl: null,
    source: "weworkremotely",
    region,
    tags: [...new Set(tags)],
    salary: null,
    description: htmlToText(item.description),
  }
}

const weworkremotely: Source = {
  name: "weworkremotely",
  label: "We Work Remotely",
  home: "https://weworkremotely.com",
  attribution: "We Work Remotely (https://weworkremotely.com) - public RSS feed: attribute the links back to We Work Remotely.",
  async search(p) {
    const xml = await fetchText("https://weworkremotely.com/remote-jobs.rss", {
      accept: "application/rss+xml,application/xml,text/xml",
      timeoutMs: p.timeoutMs,
    })
    return parseRss(xml).map(mapWwr).filter((x): x is RawJob => !!x)
  },
  async detail(nativeId, timeoutMs) {
    if (!/^[a-z0-9-]+$/i.test(nativeId)) return null
    return detailFromPage(`https://weworkremotely.com/remote-jobs/${nativeId}`, "weworkremotely", nativeId, timeoutMs)
  },
  idFromUrl(u) {
    if (!/(^|\.)weworkremotely\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/remote-jobs\/([a-z0-9-]+)\/?$/i)
    return m ? m[1] : null
  },
}

// ---------------------------------------------------------------------------
// Working Nomads — https://www.workingnomads.com/api/exposed_jobs/
// ---------------------------------------------------------------------------

export function mapWorkingNomads(j: Record<string, unknown>): RawJob | null {
  const url = str(j.url)
  const title = str(j.title)
  if (!url || !title) return null
  const nativeId = url.match(/\/job\/go\/(\d+)/)?.[1] ?? url.match(/\/jobs\/([^/?#]+)/)?.[1]
  if (!nativeId) return null
  const tags = [
    ...(str(j.category_name) ? [str(j.category_name) as string] : []),
    ...(str(j.tags)?.split(/\s*,\s*/) ?? []),
  ].map((t) => cleanInline(t)).filter(Boolean)
  return {
    id: `workingnomads:${nativeId}`,
    title: cleanInline(title),
    company: cleanInline(str(j.company_name)) || null,
    date: toIsoDate(str(j.pub_date)),
    url,
    applyUrl: url,
    source: "workingnomads",
    region: cleanInline(str(j.location)) || null,
    tags: [...new Set(tags)],
    salary: null,
    description: htmlToText(str(j.description)),
  }
}

async function workingNomadsFeed(timeoutMs: number): Promise<RawJob[]> {
  const data = await fetchJson<unknown[]>("https://www.workingnomads.com/api/exposed_jobs/", { timeoutMs })
  if (!Array.isArray(data)) return []
  return data
    .map((j) => (j && typeof j === "object" ? mapWorkingNomads(j as Record<string, unknown>) : null))
    .filter((x): x is RawJob => !!x)
}

const workingnomads: Source = {
  name: "workingnomads",
  label: "Working Nomads",
  home: "https://www.workingnomads.com",
  attribution: "Working Nomads (https://www.workingnomads.com) - public API: credit Working Nomads and link to the job URL it provides.",
  search: (p) => workingNomadsFeed(p.timeoutMs),
  async detail(nativeId, timeoutMs) {
    // The exposed feed is the only data source: its job URLs redirect to the
    // employer, so there is no board page to read. Older jobs are not found.
    const hit = (await workingNomadsFeed(timeoutMs)).find((j) => j.id === `workingnomads:${nativeId}`)
    return hit ? blankDetail(hit) : null
  },
  idFromUrl(u) {
    if (!/(^|\.)workingnomads\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/job\/go\/(\d+)\/?$/)
    return m ? m[1] : null
  },
}

export const SOURCES: Record<SourceName, Source> = { remoteok, himalayas, jobicy, weworkremotely, workingnomads }
