#!/usr/bin/env bun
// Self-contained CLI for searching Hacker News' monthly "Ask HN: Who is hiring?"
// threads through the official public Algolia HN Search API and the HN Firebase
// API. No external CLI framework and zero runtime dependencies, so it runs
// anywhere `bun` is available with nothing installed beyond the repo clone.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", l: "location", n: "limit", h: "help" }
/** Flags that never take a value: the next argv token stays a positional / next flag. */
const BOOLEAN_FLAGS = new Set(["remote", "india-friendly", "help"])

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

const HELP = `hn-hiring-cli — search Hacker News "Ask HN: Who is hiring?" job posts

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords, passed to Algolia (all words must match; typo-tolerant).
  --months <n>            How many recent monthly threads to search (1-12). Default 1.
  --thread <id>           Search one specific thread by HN story id (overrides --months).
  --location, -l <text>   Case-insensitive substring match on the post's header line.
  --remote                Only posts whose header mentions REMOTE.
  --india-friendly        Only posts that look open to a candidate in India (see SKILL.md).
  --jobage <days>         Only posts made within the last N days.
  --page <n>              1-indexed page over the filtered results. Default 1.
  --limit, -n <n>         Results per page (client-side). Default 25.
  --format <fmt>          json (default) | table | plain.

EXAMPLES
  bun run src/cli.ts search -q "LLM" --remote --limit 10 --format table
  bun run src/cli.ts search -q "voice" --india-friendly --months 2 --format table
  bun run src/cli.ts search -q "inference" -l "Bangalore" --months 3
  bun run src/cli.ts detail 50425675 --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "months", "thread", "location", "remote", "india-friendly", "jobage", "page", "limit", "format", "help"]),
  detail: new Set(["format", "help"]),
}

function badArg(msg: string): number {
  writeError(msg, "BAD_ARG")
  return 1
}

/** Whole number >= min (and <= max when given), or null. Number(), not parseInt(): "0.5" must not become 0. */
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
  // Reject unknown flags instead of silently discarding them: a discarded
  // filter changes what the search returns with no error.
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
    for (const name of ["query", "location"]) {
      if (flags[name] !== undefined && (typeof flags[name] !== "string" || !(flags[name] as string).trim())) {
        return badArg(`--${name} requires a non-empty value`)
      }
    }
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return badArg(`--format must be one of json|table|plain, got "${fmt}"`)

    let months = 1
    if (flags.months !== undefined) {
      const v = intFlag(flags.months, 1, 12)
      if (v === null) return badArg(`--months must be a whole number from 1 to 12, got "${flags.months}"`)
      months = v
    }
    let thread: string | undefined
    if (flags.thread !== undefined) {
      if (typeof flags.thread !== "string" || !/^\d{1,12}$/.test(flags.thread.trim())) {
        return badArg(`--thread must be a numeric HN story id, got "${flags.thread}"`)
      }
      if (flags.months !== undefined) return badArg("--thread and --months both choose threads; pass only one")
      thread = flags.thread.trim()
    }
    let jobage: number | undefined
    if (flags.jobage !== undefined) {
      const v = intFlag(flags.jobage, 1)
      if (v === null) return badArg(`--jobage must be a whole number of at least 1, got "${flags.jobage}"`)
      jobage = v
    }
    const page = flags.page !== undefined ? intFlag(flags.page, 1) : 1
    if (page === null) return badArg(`--page must be a whole number of at least 1, got "${flags.page}"`)
    const limit = flags.limit !== undefined ? intFlag(flags.limit, 0, 1000) : 25
    if (limit === null) return badArg(`--limit must be a whole number from 0 to 1000, got "${flags.limit}"`)

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query.trim() : undefined,
      months,
      thread,
      location: typeof flags.location === "string" ? flags.location.trim() : undefined,
      remote: flags.remote === true,
      indiaFriendly: flags["india-friendly"] === true,
      jobage,
      page,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  // detail
  const id = (flags._ as string[])[1]
  if (!id) {
    writeError("detail requires an <id|url>", "NO_ID")
    return 1
  }
  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "plain"].includes(fmt)) return badArg(`--format must be one of json|plain, got "${fmt}"`)
  const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
  return runDetail(opts)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
    process.exit(1)
  })
