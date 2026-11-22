import {
  TME,
  buildLead,
  extractLinks,
  htmlToText,
  parseMessages,
  robotsAllowed,
  stripInvisible,
  textFetch,
  writeError,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

const CHANNEL = "[A-Za-z][A-Za-z0-9_]{3,31}"

/**
 * Accept `channel/id` (a search result's `id`), or a public post URL:
 * `https://t.me/<channel>/<id>`, `https://t.me/s/<channel>/<id>` (also
 * telegram.me, with or without scheme). Private links (`t.me/c/...`), other
 * hosts and userinfo tricks are rejected. Returns [channel, id] or null.
 */
export function normalizeId(input: string): [string, string] | null {
  const trimmed = input.trim()
  const bare = trimmed.match(new RegExp(`^@?(${CHANNEL})\\/(\\d{1,12})$`))
  if (bare) return [bare[1], bare[2]]
  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (!hasScheme && !/^(?:www\.)?(?:t|telegram)\.me\//i.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (!/^(?:www\.)?(?:t|telegram)\.me$/i.test(parsed.hostname) || parsed.username || parsed.password || parsed.port) return null
  const m = parsed.pathname.match(new RegExp(`^\\/(?:s\\/)?(${CHANNEL})\\/(\\d{1,12})\\/?$`))
  if (!m || m[1].toLowerCase() === "c" || m[1].toLowerCase() === "s") return null
  return [m[1], m[2]]
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const parsed = normalizeId(opts.id)
  if (!parsed) {
    writeError(`Could not parse a public Telegram post from "${opts.id}" (pass channel/id or a https://t.me/<channel>/<id> URL)`, "BAD_ID")
    return 1
  }
  const [channel, id] = parsed
  const url = `${TME}/${channel}/${id}?embed=1`
  const robots = robotsAllowed(url)
  if (!robots.allowed) {
    writeError(`robots.txt check did not allow ${url}: ${robots.message}`, "ROBOTS_DISALLOWED")
    return 1
  }
  try {
    const page = await textFetch(url)
    const msg = page ? parseMessages(page).find((m) => m.channel.toLowerCase() === channel.toLowerCase() && m.id === id) : undefined
    if (!msg) {
      writeError(`Telegram post ${channel}/${id} not found (deleted, private, or not a public channel)`, "NOT_FOUND")
      return 1
    }
    const lead = buildLead(msg)
    const description = htmlToText(msg.html) || null
    const base = lead ?? {
      id: `${channel}/${id}`,
      kind: "lead" as const,
      title: "(no text)",
      company: `@${channel}`,
      url: `${TME}/${channel}/${id}`,
      date: msg.datetime ? msg.datetime.slice(0, 10) : null,
    }
    const { snippet: _snippet, ...rest } = base as typeof base & { snippet?: unknown }
    const job = stripInvisible({ ...rest, links: extractLinks(msg.html), description })

    if (opts.format === "plain") {
      const l = job as typeof job & { location?: string | null; apply_url?: string | null; salary?: string | null }
      const head = [
        job.title,
        `${job.company} · ${l.location ?? "—"} · ${job.date ?? "—"}`,
        l.salary ? `Salary: ${l.salary}` : "",
      ].filter(Boolean)
      const foot = [`URL: ${job.url}`, l.apply_url ? `Link: ${l.apply_url}` : ""].filter(Boolean)
      process.stdout.write([head.join("\n"), job.description ?? "(no text)", foot.join("\n")].join("\n\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
