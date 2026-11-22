#!/usr/bin/env bun
// Self-contained CLI that reads public startup-funding news RSS feeds
// (India-focused plus global) and turns funding announcements into leads:
// a startup that just raised money is likely to be hiring. No external CLI
// framework and zero runtime dependencies.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { DEFAULT_FEEDS, writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", n: "limit", h: "help" }
const BOOLEAN_FLAGS = new Set(["keep-unparsed", "help"])

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("-") || a === "-") {
      ;(flags._ as string[]).push(a)
      continue
    }
    const name = a.replace(/^-+/, "")
    const key = ALIAS[name] ?? name
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || (next.startsWith("-") && !/^-\d/.test(next))) {
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return flags
}

const HELP = `funding-news-cli — startup funding announcements from public RSS feeds, as leads

USAGE
  bun run src/cli.ts search [-q <keywords>] [flags]
  bun run src/cli.ts detail <article url> [--format json|plain] [--max-chars N]

SEARCH FLAGS
  --query, -q <text>      Client-side filter: every word must appear in the headline,
                          summary, categories or source (case-insensitive).
  --feeds <url1,url2>     Read these RSS/Atom feeds instead of the defaults.
  --days <n>              Only items published in the last N days (1-365).
  --keep-unparsed         Keep funding items whose startup name could not be extracted
                          (company: null). Default: drop them.
  --page <n>              1-indexed page over the filtered results. Default 1.
  --limit, -n <n>         Results per page, 0-500. Default 25.
  --format <fmt>          json (default) | table | plain.

DEFAULT FEEDS
${DEFAULT_FEEDS.map((f) => `  ${f.name.padEnd(20)} ${f.url}`).join("\n")}

EXAMPLES
  bun run src/cli.ts search --format table
  bun run src/cli.ts search -q "AI" --days 7 --format table
  bun run src/cli.ts search --feeds https://entrackr.com/rss -q fintech
  bun run src/cli.ts detail https://entrackr.com/news/... --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "feeds", "days", "keep-unparsed", "page", "limit", "format", "help"]),
  detail: new Set(["format", "max-chars", "help"]),
}

function badArg(msg: string): number {
  writeError(msg, "BAD_ARG")
  return 1
}

function intFlag(raw: string | boolean | string[], min: number, max?: number): number | null {
  const v = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(v) || v < min || (max !== undefined && v > max)) return null
  return v
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  const known = KNOWN_FLAGS[cmd]
  if (!known) {
    writeError(`Unknown command "${cmd}" (expected search or detail)`, "BAD_CMD")
    return 1
  }
  for (const key of Object.keys(flags)) {
    if (key === "_" || known.has(key)) continue
    writeError(
      `unknown flag --${key} for '${cmd}' - flags are never silently ignored, because a discarded filter changes what the search returns; see --help for the supported flags`,
      "UNKNOWN_FLAG",
    )
    return 1
  }

  if (cmd === "search") {
    if ((flags._ as string[]).length > 1) return badArg(`unexpected argument "${(flags._ as string[])[1]}" (use -q for keywords)`)
    for (const name of ["query", "feeds"]) {
      if (flags[name] !== undefined && (typeof flags[name] !== "string" || !(flags[name] as string).trim())) {
        return badArg(`--${name} requires a non-empty value`)
      }
    }
    let feeds: string[] | undefined
    if (typeof flags.feeds === "string") {
      feeds = flags.feeds.split(",").map((s) => s.trim()).filter(Boolean)
      if (feeds.length === 0 || feeds.length > 20) return badArg("--feeds takes 1-20 comma-separated feed URLs")
      for (const f of feeds) {
        let u: URL | null = null
        try {
          u = new URL(f)
        } catch {
          u = null
        }
        if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password) return badArg(`--feeds entry is not an http(s) URL: "${f}"`)
      }
    }
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return badArg(`--format must be one of json|table|plain, got "${fmt}"`)
    let days: number | undefined
    if (flags.days !== undefined) {
      const v = intFlag(flags.days, 1, 365)
      if (v === null) return badArg(`--days must be a whole number from 1 to 365, got "${flags.days}"`)
      days = v
    }
    const page = flags.page !== undefined ? intFlag(flags.page, 1) : 1
    if (page === null) return badArg(`--page must be a whole number of at least 1, got "${flags.page}"`)
    const limit = flags.limit !== undefined ? intFlag(flags.limit, 0, 500) : 25
    if (limit === null) return badArg(`--limit must be a whole number from 0 to 500, got "${flags.limit}"`)
    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query.trim() : undefined,
      feeds,
      days,
      keepUnparsed: flags["keep-unparsed"] === true,
      page,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  const url = (flags._ as string[])[1]
  if (!url) {
    writeError("detail requires an <article url>", "NO_ID")
    return 1
  }
  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "plain"].includes(fmt)) return badArg(`--format must be one of json|plain, got "${fmt}"`)
  const maxChars = flags["max-chars"] !== undefined ? intFlag(flags["max-chars"], 200, 100000) : 12000
  if (maxChars === null) return badArg(`--max-chars must be a whole number from 200 to 100000, got "${flags["max-chars"]}"`)
  const opts: DetailOpts = { url, format: fmt as DetailOpts["format"], maxChars }
  return runDetail(opts)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
    process.exit(1)
  })
