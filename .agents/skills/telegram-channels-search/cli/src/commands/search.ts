import {
  TME,
  buildLead,
  htmlToText,
  matchesQuery,
  parseMessages,
  robotsAllowed,
  stripInvisible,
  textFetch,
  writeError,
  type Lead,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  channels: string[]
  jobage?: number
  remote: boolean
  indiaFriendly: boolean
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

export interface ChannelReport {
  channel: string
  url: string
  status: "ok" | "robots_disallowed" | "not_found" | "not_public" | "error"
  messages: number
  note?: string
}

/** Client-side filters over the parsed leads. */
export function applyFilters(leads: Lead[], texts: Map<string, string>, opts: Pick<SearchOpts, "query" | "jobage" | "remote" | "indiaFriendly">, now = Date.now()): Lead[] {
  const since = opts.jobage !== undefined ? new Date(now - opts.jobage * 86400000).toISOString().slice(0, 10) : null
  return leads.filter((l) => {
    if (!matchesQuery(`${l.title}\n${texts.get(l.id) ?? ""}`, opts.query)) return false
    if (since && (!l.date || l.date < since)) return false
    if (opts.remote && l.remote !== true) return false
    if (opts.indiaFriendly && !l.india_friendly) return false
    return true
  })
}

function pad(s: string | null | undefined, n: number): string {
  const v = (s ?? "—").replace(/\s+/g, " ")
  return (v.length > n ? v.slice(0, n - 1) + "…" : v).padEnd(n)
}

function renderTable(leads: Lead[]): string {
  if (leads.length === 0) return "No results."
  const header = `${pad("ID", 22)} ${pad("COMPANY", 20)} ${pad("TITLE", 44)} ${pad("LOCATION", 26)} ${"REM".padEnd(3)} DATE`
  const rows = leads.map(
    (l) =>
      `${pad(l.id, 22)} ${pad(l.company, 20)} ${pad(l.title, 44)} ${pad(l.location, 26)} ${(l.remote ? "Y" : l.remote === false ? "N" : "?").padEnd(3)} ${l.date ?? "—"}`,
  )
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(leads: Lead[]): string {
  if (leads.length === 0) return "No results."
  return leads
    .map((l) =>
      [
        l.title,
        `  ${l.company} · ${l.location ?? "—"} · ${l.date ?? "—"}${l.salary ? ` · ${l.salary}` : ""}`,
        `  ${l.url}${l.apply_url ? `\n  link: ${l.apply_url}` : ""}`,
      ].join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const reports: ChannelReport[] = []
    const all: Lead[] = []
    const texts = new Map<string, string>()
    let skippedNoText = 0

    for (const channel of opts.channels) {
      const url = `${TME}/s/${channel}`
      const robots = robotsAllowed(url)
      if (!robots.allowed) {
        reports.push({ channel, url, status: "robots_disallowed", messages: 0, note: robots.message })
        continue
      }
      try {
        const page = await textFetch(url)
        if (page === null) {
          reports.push({ channel, url, status: "not_found", messages: 0 })
          continue
        }
        const msgs = parseMessages(page)
        // t.me/s/<name> for a user, bot, group or a channel with the preview
        // disabled answers 200 with a profile card and no message list.
        if (msgs.length === 0) {
          reports.push({ channel, url, status: "not_public", messages: 0, note: "no public message preview (not a channel, or preview disabled)" })
          continue
        }
        reports.push({ channel, url, status: "ok", messages: msgs.length })
        for (const m of msgs) {
          const lead = buildLead(m)
          if (!lead) {
            skippedNoText++
            continue
          }
          texts.set(lead.id, htmlToText(m.html))
          all.push(lead)
        }
      } catch (e) {
        reports.push({ channel, url, status: "error", messages: 0, note: e instanceof Error ? e.message : String(e) })
      }
    }

    if (!reports.some((r) => r.status === "ok")) {
      const blocked = reports.every((r) => r.status === "robots_disallowed")
      writeError(
        blocked
          ? `robots.txt does not allow fetching any requested channel preview: ${reports.map((r) => `${r.channel} (${r.note})`).join("; ")}`
          : `no channel could be read: ${reports.map((r) => `${r.channel}: ${r.status}${r.note ? ` (${r.note})` : ""}`).join("; ")}`,
        blocked ? "ROBOTS_DISALLOWED" : "SEARCH_FAILED",
      )
      return 1
    }

    // Newest first across channels.
    all.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || Number(b.id.split("/")[1]) - Number(a.id.split("/")[1]))
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
        skipped_no_text: skippedNoText,
        query: opts.query ?? null,
        filters: { jobage: opts.jobage ?? null, remote: opts.remote, india_friendly: opts.indiaFriendly },
        channels: stripInvisible(reports),
      }
      process.stdout.write(JSON.stringify({ meta, results: pageItems }, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
