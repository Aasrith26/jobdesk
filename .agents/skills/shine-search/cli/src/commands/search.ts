import {
  buildSearchUrl,
  cardAgeDays,
  decodeFlight,
  htmlFetch,
  parseJobCards,
  parsePostedAtMap,
  parseSearchMeta,
  stripInvisible,
  writeError,
  type JobCard,
  type SortOrder,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  sort: SortOrder
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

function renderTable(cards: JobCard[]): string {
  if (cards.length === 0) return "No results."
  const rows = cards.map((c) => {
    const title = (c.title || "").slice(0, 40).padEnd(40)
    const company = (c.company || "-").slice(0, 26).padEnd(26)
    const loc = (c.location || "-").slice(0, 22).padEnd(22)
    const exp = (c.experience || "-").slice(0, 11).padEnd(11)
    const date = c.date || c.posted || "-"
    return `${c.id.padEnd(9)} ${title} ${company} ${loc} ${exp} ${date}`
  })
  const header =
    "ID".padEnd(9) +
    " " +
    "TITLE".padEnd(40) +
    " " +
    "COMPANY".padEnd(26) +
    " " +
    "LOCATION".padEnd(22) +
    " " +
    "EXPERIENCE".padEnd(11) +
    " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(cards: JobCard[]): string {
  if (cards.length === 0) return "No results."
  return cards
    .map((c) =>
      [
        c.title,
        `  ${c.company || "-"} · ${c.location || "-"} · ${c.date || c.posted || "-"}`,
        `  experience: ${c.experience || "-"} · salary: ${c.salary || "-"}`,
        c.skills.length ? `  skills: ${c.skills.join(", ")}` : "",
        `  id: ${c.id}`,
        `  ${c.url}`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const url = buildSearchUrl(opts)
    const html = await htmlFetch(url)
    const flight = html ? decodeFlight(html) : ""
    const meta = html
      ? parseSearchMeta(html, flight)
      : { total: 0, pageCount: null, hasNextPage: false, pageTitle: null, renderedAt: null }
    let cards = parseJobCards(html, parsePostedAtMap(flight))

    // Shine has no posting-age URL parameter, so --jobage filters this page
    // client-side (combine with --sort date to put fresh postings first).
    if (opts.jobage !== undefined) {
      const max = opts.jobage
      cards = cards.filter((c) => {
        const age = cardAgeDays(c, new Date(), meta.renderedAt)
        return age !== null && age <= max
      })
    }
    if (opts.limit !== undefined) cards = cards.slice(0, opts.limit)
    cards = stripInvisible(cards)

    if (opts.format === "table") {
      process.stdout.write(renderTable(cards) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(cards) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify(
          stripInvisible({
            meta: {
              count: cards.length,
              page: opts.page,
              total: meta.total,
              pageCount: meta.pageCount,
              hasNextPage: meta.hasNextPage,
              sort: opts.sort,
              jobage: opts.jobage ?? null,
              query: opts.query ?? null,
              location: opts.location ?? null,
              pageTitle: meta.pageTitle,
              renderedAt: meta.renderedAt,
              url,
            },
            results: cards,
          }),
          null,
          2,
        ) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
