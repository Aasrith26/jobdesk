import {
  buildPost,
  feedUrl,
  isHiringTitle,
  matchesQuery,
  parseFeed,
  postText,
  robotsAllowed,
  stripInvisible,
  textFetch,
  writeError,
  type RedditPost,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  subreddits: string[]
  includeForHire: boolean
  perSub: number
  jobage?: number
  remote: boolean
  indiaFriendly: boolean
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

export interface SubredditReport {
  subreddit: string
  url: string
  status: "ok" | "robots_disallowed" | "not_found" | "error"
  entries: number
  note?: string
}

/** Subreddits where only `[Hiring]` posts are kept unless --include-for-hire. */
const HIRING_TAG_SUBS = new Set(["forhire"])

/** Client-side filters over the parsed posts. */
export function applyFilters(
  posts: RedditPost[],
  texts: Map<string, string>,
  opts: Pick<SearchOpts, "query" | "jobage" | "remote" | "indiaFriendly">,
  now = Date.now(),
): RedditPost[] {
  const since = opts.jobage !== undefined ? new Date(now - opts.jobage * 86400000).toISOString().slice(0, 10) : null
  return posts.filter((p) => {
    if (!matchesQuery(`${p.header.split("\n")[0]}\n${texts.get(p.id) ?? ""}`, opts.query)) return false
    if (since && (!p.date || p.date < since)) return false
    if (opts.remote && p.remote !== true) return false
    if (opts.indiaFriendly && !p.india_friendly) return false
    return true
  })
}

function pad(s: string | null | undefined, n: number): string {
  const v = (s ?? "—").replace(/\s+/g, " ")
  return (v.length > n ? v.slice(0, n - 1) + "…" : v).padEnd(n)
}

function renderTable(posts: RedditPost[]): string {
  if (posts.length === 0) return "No results."
  const header = `${pad("ID", 9)} ${pad("SUB", 16)} ${pad("COMPANY", 20)} ${pad("TITLE", 46)} ${pad("LOCATION", 18)} ${"KIND".padEnd(4)} DATE`
  const rows = posts.map(
    (p) =>
      `${pad(p.id, 9)} ${pad(p.subreddit, 16)} ${pad(p.company, 20)} ${pad(p.title, 46)} ${pad(p.location, 18)} ${p.kind.padEnd(4)} ${p.date ?? "—"}`,
  )
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(posts: RedditPost[]): string {
  if (posts.length === 0) return "No results."
  return posts
    .map((p) =>
      [
        p.header.split("\n")[0],
        `  ${p.company} (${p.kind}) · ${p.location ?? "—"} · ${p.date ?? "—"}${p.salary ? ` · ${p.salary}` : ""}`,
        `  ${p.url}${p.apply_url ? `\n  link: ${p.apply_url}` : ""}`,
      ].join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const reports: SubredditReport[] = []
    const all: RedditPost[] = []
    const texts = new Map<string, string>()
    const seen = new Set<string>()
    let skippedForHire = 0

    for (const sub of opts.subreddits) {
      const url = feedUrl(sub, opts.perSub)
      const robots = robotsAllowed(url)
      if (!robots.allowed) {
        reports.push({ subreddit: sub, url, status: "robots_disallowed", entries: 0, note: robots.message })
        continue
      }
      try {
        const xml = await textFetch(url)
        if (xml === null) {
          reports.push({ subreddit: sub, url, status: "not_found", entries: 0 })
          continue
        }
        const entries = parseFeed(xml)
        reports.push({ subreddit: sub, url, status: "ok", entries: entries.length })
        const hiringOnly = HIRING_TAG_SUBS.has(sub.toLowerCase()) && !opts.includeForHire
        for (const entry of entries) {
          const post = buildPost(entry, sub)
          if (!post || seen.has(post.id)) continue
          if (hiringOnly && !isHiringTitle(post.header.split("\n")[0])) {
            skippedForHire++
            continue
          }
          seen.add(post.id)
          texts.set(post.id, postText(entry))
          all.push(post)
        }
      } catch (e) {
        reports.push({ subreddit: sub, url, status: "error", entries: 0, note: e instanceof Error ? e.message : String(e) })
      }
    }

    if (!reports.some((r) => r.status === "ok")) {
      const blocked = reports.every((r) => r.status === "robots_disallowed")
      writeError(
        blocked
          ? `robots.txt does not allow fetching any requested subreddit feed (${reports.map((r) => `r/${r.subreddit}: ${r.note}`).join("; ")}); nothing was fetched`
          : `no subreddit feed could be read: ${reports.map((r) => `r/${r.subreddit}: ${r.status}${r.note ? ` (${r.note})` : ""}`).join("; ")}`,
        blocked ? "ROBOTS_DISALLOWED" : "SEARCH_FAILED",
      )
      return 1
    }

    all.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    const filtered = stripInvisible(applyFilters(all, texts, opts))
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
        skipped_not_hiring: skippedForHire,
        query: opts.query ?? null,
        filters: {
          jobage: opts.jobage ?? null,
          remote: opts.remote,
          india_friendly: opts.indiaFriendly,
          include_for_hire: opts.includeForHire,
          per_sub: opts.perSub,
        },
        subreddits: stripInvisible(reports),
      }
      process.stdout.write(JSON.stringify({ meta, results: pageItems }, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
