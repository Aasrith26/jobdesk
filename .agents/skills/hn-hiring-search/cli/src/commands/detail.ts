import {
  FIREBASE_URL,
  buildJobPost,
  extractLinks,
  htmlToText,
  isHiringThreadTitle,
  jsonFetch,
  stripInvisible,
  writeError,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

interface FirebaseItem {
  id: number
  type?: string
  by?: string
  text?: string
  time?: number
  parent?: number
  title?: string
  deleted?: boolean
  dead?: boolean
}

const HN_HOST = /^news\.ycombinator\.com$/i

/**
 * Accept a bare numeric HN item id or a news.ycombinator.com item URL
 * (`https://news.ycombinator.com/item?id=<id>`, with or without scheme). Any
 * other host is rejected - the posting's own apply link must not be mistaken
 * for an HN item. Host and query are read through real URL parsing, so
 * look-alike hosts and userinfo tricks fall on the reject side.
 */
export function normalizeId(input: string): string | null {
  const trimmed = input.trim()
  if (/^\d{1,12}$/.test(trimmed)) return trimmed
  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (!hasScheme && !/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (!HN_HOST.test(parsed.hostname) || parsed.username || parsed.password) return null
  if (parsed.pathname !== "/item") return null
  const id = parsed.searchParams.get("id")
  return id && /^\d{1,12}$/.test(id) ? id : null
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = normalizeId(opts.id)
  if (!id) {
    writeError(`Could not parse an HN item id from "${opts.id}" (pass a number or a news.ycombinator.com/item?id= URL)`, "BAD_ID")
    return 1
  }
  try {
    const item = await jsonFetch<FirebaseItem>(`${FIREBASE_URL}/item/${id}.json`)
    if (!item || item.deleted) {
      writeError(`HN item ${id} not found (or deleted)`, "NOT_FOUND")
      return 1
    }
    if (item.type !== "comment") {
      writeError(`HN item ${id} is a ${item.type ?? "unknown item"}, not a job-post comment`, "NOT_A_COMMENT")
      return 1
    }
    const html = item.text ?? ""

    // Is the parent a "Who is hiring?" thread? (Top-level comments are the job posts.)
    let threadTitle: string | null = null
    let topLevel = false
    if (item.parent) {
      const parent = await jsonFetch<FirebaseItem>(`${FIREBASE_URL}/item/${item.parent}.json`)
      if (parent && parent.type === "story") {
        topLevel = true
        threadTitle = parent.title ?? null
      }
    }

    const post = buildJobPost(String(item.id), html, {
      author: item.by ?? null,
      createdAt: item.time ? new Date(item.time * 1000).toISOString() : null,
      threadId: topLevel && item.parent ? String(item.parent) : null,
      threadTitle,
    })
    const { snippet: _snippet, ...rest } = post
    const job = stripInvisible({
      ...rest,
      top_level: topLevel,
      in_hiring_thread: topLevel && isHiringThreadTitle(threadTitle),
      dead: item.dead === true,
      links: extractLinks(html),
      description: htmlToText(html) || null,
    })

    if (opts.format === "plain") {
      const head = [
        job.header || "(no header)",
        `${job.company ?? "—"} · ${job.title ?? "—"} · ${job.location ?? "—"}`,
        `Posted: ${job.date ?? "—"} by ${job.author ?? "—"}${job.thread_title ? ` in "${job.thread_title}"` : ""}`,
        `Remote: ${job.remote ?? "unknown"} · India-friendly: ${job.india_friendly ? `yes (${job.india_reason})` : "no"}`,
        job.salary ? `Salary: ${job.salary}` : "",
        job.employment_type ? `Employment: ${job.employment_type}` : "",
        job.top_level ? "" : "Note: this is a reply, not a top-level job post.",
        job.dead ? "Note: this comment is flagged dead on HN." : "",
      ].filter(Boolean)
      const foot = [`URL: ${job.url}`, job.apply_url ? `Apply: ${job.apply_url}` : ""].filter(Boolean)
      const out = [head.join("\n"), job.description ?? "(no text)", foot.join("\n")].join("\n\n")
      process.stdout.write(out + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
