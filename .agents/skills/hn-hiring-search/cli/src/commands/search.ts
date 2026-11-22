import {
  ALGOLIA_URL,
  FIREBASE_URL,
  buildJobPost,
  htmlToText,
  isHiringThreadTitle,
  isNonJobPost,
  jsonFetch,
  stripInvisible,
  writeError,
  type AlgoliaHit,
  type JobPost,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  months: number
  thread?: string
  location?: string
  remote: boolean
  indiaFriendly: boolean
  jobage?: number
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

export interface Thread {
  id: string
  title: string
  date: string | null
}

interface AlgoliaSearch<T> {
  hits: T[]
  nbHits?: number
  nbPages?: number
  page?: number
}

interface StoryHit {
  objectID: string
  title?: string | null
  created_at?: string | null
}

interface FirebaseItem {
  id: number
  type?: string
  title?: string
  time?: number
  deleted?: boolean
  dead?: boolean
}

/** Hits per Algolia page. A month's thread has ~200-400 top-level posts, so one page usually covers it. */
const HITS_PER_PAGE = 1000
/** Hard cap on Algolia pages per thread, to keep request volume low. */
const MAX_PAGES_PER_THREAD = 3
const COMMENT_ATTRS = "comment_text,author,created_at,created_at_i,parent_id,story_id"

/** The most recent `months` monthly "Who is hiring?" threads, newest first. */
export async function findThreads(months: number): Promise<Thread[]> {
  const params = new URLSearchParams({
    tags: "story,author_whoishiring",
    query: "who is hiring",
    // whoishiring posts up to three threads a month (hiring / wants to be hired / freelancer).
    hitsPerPage: String(Math.min(100, months * 3 + 6)),
    attributesToRetrieve: "title,created_at",
    attributesToHighlight: "[]",
  })
  const res = await jsonFetch<AlgoliaSearch<StoryHit>>(`${ALGOLIA_URL}/search_by_date?${params}`)
  const threads = (res?.hits ?? [])
    .filter((h) => isHiringThreadTitle(h.title))
    .map((h) => ({ id: String(h.objectID), title: String(h.title), date: h.created_at ? h.created_at.slice(0, 10) : null }))
  return threads.slice(0, months)
}

/** Resolve an explicit --thread id through the Firebase API (one small request). */
export async function resolveThread(id: string): Promise<Thread | null> {
  const item = await jsonFetch<FirebaseItem>(`${FIREBASE_URL}/item/${id}.json`)
  if (!item || item.deleted || item.type !== "story") return null
  return {
    id: String(item.id),
    title: item.title ?? `HN story ${item.id}`,
    date: item.time ? new Date(item.time * 1000).toISOString().slice(0, 10) : null,
  }
}

/** All top-level comments (= job posts) of one thread that match the Algolia query. */
export async function fetchThreadPosts(thread: Thread, query: string | undefined, sinceEpoch: number | null): Promise<AlgoliaHit[]> {
  // Only top-level comments are job posts; replies are questions/discussion.
  const numeric = [`parent_id=${thread.id}`]
  if (sinceEpoch !== null) numeric.push(`created_at_i>${sinceEpoch}`)
  const endpoint = query ? "search" : "search_by_date"
  const hits: AlgoliaHit[] = []
  for (let page = 0; page < MAX_PAGES_PER_THREAD; page++) {
    const params = new URLSearchParams({
      tags: `comment,story_${thread.id}`,
      numericFilters: numeric.join(","),
      hitsPerPage: String(HITS_PER_PAGE),
      page: String(page),
      attributesToRetrieve: COMMENT_ATTRS,
      attributesToHighlight: "[]",
    })
    if (query) params.set("query", query)
    const res = await jsonFetch<AlgoliaSearch<AlgoliaHit>>(`${ALGOLIA_URL}/${endpoint}?${params}`)
    if (!res) break
    hits.push(...res.hits)
    if (page + 1 >= (res.nbPages ?? 1)) break
  }
  // Belt and braces: drop anything the numeric filter let through.
  return hits.filter((h) => String(h.parent_id) === thread.id)
}

/** Client-side filters over the parsed posts. */
export function applyFilters(posts: JobPost[], opts: Pick<SearchOpts, "location" | "remote" | "indiaFriendly">): JobPost[] {
  const loc = opts.location?.toLowerCase()
  return posts.filter((p) => {
    if (loc && !p.header.toLowerCase().includes(loc)) return false
    if (opts.remote && p.remote !== true) return false
    if (opts.indiaFriendly && !p.india_friendly) return false
    return true
  })
}

function pad(s: string | null | undefined, n: number): string {
  const v = (s ?? "—").replace(/\s+/g, " ")
  return (v.length > n ? v.slice(0, n - 1) + "…" : v).padEnd(n)
}

function renderTable(posts: JobPost[]): string {
  if (posts.length === 0) return "No results."
  const header = `${"ID".padEnd(9)} ${pad("COMPANY", 22)} ${pad("TITLE", 38)} ${pad("LOCATION", 30)} ${"REM".padEnd(3)} ${"IN".padEnd(3)} DATE`
  const rows = posts.map(
    (p) =>
      `${p.id.padEnd(9)} ${pad(p.company, 22)} ${pad(p.title, 38)} ${pad(p.location, 30)} ${(p.remote ? "Y" : p.remote === false ? "N" : "?").padEnd(3)} ${(p.india_friendly ? "Y" : "").padEnd(3)} ${p.date ?? "—"}`,
  )
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(posts: JobPost[]): string {
  if (posts.length === 0) return "No results."
  return posts
    .map((p) =>
      [
        p.header,
        `  ${p.company ?? "—"} · ${p.title ?? "—"} · ${p.location ?? "—"} · ${p.date ?? "—"}`,
        `  remote: ${p.remote ?? "unknown"} · india-friendly: ${p.india_friendly ? `yes (${p.india_reason})` : "no"}`,
        `  id: ${p.id}`,
        `  ${p.url}${p.apply_url ? `\n  apply: ${p.apply_url}` : ""}`,
      ].join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    let threads: Thread[]
    if (opts.thread) {
      const t = await resolveThread(opts.thread)
      if (!t) {
        writeError(`HN item ${opts.thread} is not an existing story (pass a "Who is hiring?" thread id)`, "BAD_THREAD")
        return 1
      }
      threads = [t]
    } else {
      threads = await findThreads(opts.months)
      if (threads.length === 0) {
        writeError('No "Ask HN: Who is hiring?" threads found', "NO_THREADS")
        return 1
      }
    }

    const sinceEpoch = opts.jobage !== undefined ? Math.floor(Date.now() / 1000) - opts.jobage * 86400 : null
    const all: JobPost[] = []
    let skipped = 0
    for (const thread of threads) {
      const hits = await fetchThreadPosts(thread, opts.query, sinceEpoch)
      for (const h of hits) {
        const html = h.comment_text ?? ""
        if (sinceEpoch !== null && (h.created_at_i ?? 0) <= sinceEpoch) continue
        if (isNonJobPost(htmlToText(html))) {
          skipped++
          continue
        }
        all.push(
          buildJobPost(String(h.objectID), html, {
            author: h.author ?? null,
            createdAt: h.created_at ?? null,
            threadId: thread.id,
            threadTitle: thread.title,
          }),
        )
      }
    }

    const filtered = stripInvisible(applyFilters(all, opts))
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
        scanned: all.length,
        skipped_non_job: skipped,
        query: opts.query ?? null,
        filters: {
          location: opts.location ?? null,
          remote: opts.remote,
          india_friendly: opts.indiaFriendly,
          jobage: opts.jobage ?? null,
        },
        threads: stripInvisible(threads),
      }
      process.stdout.write(JSON.stringify({ meta, results: pageItems }, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
