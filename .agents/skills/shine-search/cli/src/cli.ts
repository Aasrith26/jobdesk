#!/usr/bin/env bun
// Self-contained CLI for searching jobs on Shine.com (India) via its public,
// server-rendered job-search and job-description pages. No external CLI
// framework and zero runtime dependencies: it runs anywhere `bun` is available.
//
// Personal use only: keep volume low. robots.txt disallows /api/* and a few
// other paths; this CLI only requests the allowed /job-search/ and /jobs/
// pages, with an honest User-Agent.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { writeError } from "./helpers.js"

type FlagValue = string | true
interface Flags {
  _: string[]
  opts: Record<string, FlagValue>
  unknown: string[]
}

const ALIASES: Record<string, string> = { q: "query", l: "location", h: "help" }

// Long-form flags each command accepts. Every flag except help takes a value.
const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "location", "jobage", "sort", "page", "limit", "format", "help"]),
  detail: new Set(["format", "help"]),
}
const SWITCHES = new Set(["help"])

function parseFlags(argv: string[], known: Set<string> | undefined): Flags {
  const flags: Flags = { _: [], opts: {}, unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") {
      flags._.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith("-") && a !== "-") {
      const isLong = a.startsWith("--")
      const body = a.slice(isLong ? 2 : 1)
      const eq = body.indexOf("=")
      const rawName = eq === -1 ? body : body.slice(0, eq)
      // Short flags only via their declared aliases; anything else is unknown.
      const name = isLong ? rawName : ALIASES[rawName]
      if (!name || !known || !known.has(name)) {
        flags.unknown.push(a.split("=")[0])
        continue
      }
      if (eq !== -1) {
        flags.opts[name] = body.slice(eq + 1)
      } else if (SWITCHES.has(name)) {
        flags.opts[name] = true
      } else {
        const next = argv[i + 1]
        if (next === undefined || (next.startsWith("-") && next !== "-")) {
          flags.opts[name] = true // value missing; validated below
        } else {
          flags.opts[name] = next
          i++
        }
      }
    } else {
      flags._.push(a)
    }
  }
  return flags
}

const HELP = `shine-cli - search jobs on Shine.com (India)

USAGE
  bun run src/cli.ts search -q "<keywords>" [-l "<city>"] [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Job title / skill keywords, e.g. "machine learning engineer".
  --location, -l <city>   City, e.g. Hyderabad, Bangalore, Pune, "New Delhi".
                          At least one of --query / --location is required.
  --jobage <days>         Only postings at most N days old (Shine has no age
                          parameter, so the fetched page is filtered client-side).
  --sort <order>          relevance (default) | date (most recent first; Shine's
                          date sort matches keywords loosely).
  --page <n>              1-indexed page (20 results/page). Default 1.
  --limit <n>             Cap results emitted (client-side).
  --format <fmt>          json (default) | table | plain.

EXAMPLES
  bun run src/cli.ts search -q "machine learning engineer" -l Hyderabad --format table
  bun run src/cli.ts search -q "generative ai" -l Bangalore --jobage 7 --format table
  bun run src/cli.ts search -q "data scientist" --sort date --page 2
  bun run src/cli.ts detail 19932727 --format plain

Personal use only - reads Shine.com's public pages; keep volume low.
`

function fail(error: string, code: string): number {
  writeError(error, code)
  return 1
}

/** Whole number >= 1 (Number(), not parseInt: "1.5" must fail, not truncate). */
function positiveInt(name: string, raw: FlagValue | undefined): number | null | undefined {
  if (raw === undefined) return undefined
  const val = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (typeof raw !== "string" || raw.trim() === "" || !Number.isInteger(val) || val < 1) {
    writeError(`--${name} must be a whole number of at least 1, got ${raw === true ? "no value" : `"${raw}"`}`, "BAD_ARG")
    return null
  }
  return val
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined

  if (!cmd) {
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(HELP)
      return 0
    }
    process.stdout.write(HELP)
    return 1
  }

  const known = KNOWN_FLAGS[cmd]
  if (!known) return fail(`Unknown command "${cmd}" - use search or detail`, "BAD_CMD")

  const flags = parseFlags(argv.slice(1), known)
  // Reject unknown flags instead of silently discarding them: a discarded
  // filter changes what the search returns with no error.
  if (flags.unknown.length) {
    return fail(
      `unknown flag ${flags.unknown[0]} for '${cmd}' - flags are never silently ignored, because a discarded filter changes what the search returns; see --help for the supported flags`,
      "UNKNOWN_FLAG",
    )
  }
  if (flags.opts.help) {
    process.stdout.write(HELP)
    return 0
  }
  for (const [name, value] of Object.entries(flags.opts)) {
    if (value === true && !SWITCHES.has(name)) return fail(`option --${name} requires a value`, "BAD_ARG")
  }
  const o = flags.opts as Record<string, string | undefined>

  if (cmd === "search") {
    if (flags._.length) return fail(`unexpected argument "${flags._[0]}" - pass keywords with -q`, "BAD_ARG")
    const query = o.query?.trim() || undefined
    const location = o.location?.trim() || undefined
    if (o.query !== undefined && !query) return fail("--query requires a non-empty value", "BAD_ARG")
    if (o.location !== undefined && !location) return fail("--location requires a non-empty value", "BAD_ARG")
    if (!query && !location) {
      return fail('search needs --query/-q and/or --location/-l (e.g. -q "machine learning engineer" -l Hyderabad)', "MISSING_REQUIRED")
    }
    if (query && !/[a-z0-9]/i.test(query)) return fail("--query must contain letters or digits", "BAD_ARG")
    if (location && !/[a-z0-9]/i.test(location)) return fail("--location must contain letters or digits", "BAD_ARG")

    const fmt = o.format ?? "json"
    if (!["json", "table", "plain"].includes(fmt)) return fail(`--format must be one of json|table|plain, got "${fmt}"`, "BAD_ARG")
    if (o.sort !== undefined && !["relevance", "date"].includes(o.sort)) {
      return fail(`--sort must be one of relevance|date, got "${o.sort}"`, "BAD_ARG")
    }

    const jobage = positiveInt("jobage", flags.opts.jobage)
    const page = positiveInt("page", flags.opts.page)
    const limit = positiveInt("limit", flags.opts.limit)
    if (jobage === null || page === null || limit === null) return 1

    const opts: SearchOpts = {
      query,
      location,
      jobage,
      sort: (o.sort as SearchOpts["sort"] | undefined) ?? "relevance",
      page: page ?? 1,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  // detail
  const id = flags._[0]
  if (!id) return fail("detail requires an <id|url>", "NO_ID")
  if (flags._.length > 1) return fail(`unexpected argument "${flags._[1]}"`, "BAD_ARG")
  const fmt = o.format ?? "json"
  if (!["json", "plain"].includes(fmt)) return fail(`--format must be one of json|plain, got "${fmt}"`, "BAD_ARG")
  const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
  return runDetail(opts)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
    process.exit(1)
  })
