#!/usr/bin/env bun
// Self-contained CLI over the community-maintained YC companies API
// (yc-oss.github.io/api): Y Combinator companies the YC directory marks as
// hiring, filtered by keyword, batch, location and remote. No external CLI
// framework and zero runtime dependencies.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { normalizeBatch, writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", l: "location", n: "limit", h: "help" }
const BOOLEAN_FLAGS = new Set(["remote", "refresh", "help"])

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

const HELP = `yc-hiring-cli — Y Combinator companies that are hiring (community yc-oss API)

USAGE
  bun run src/cli.ts search [-q <keywords>] [flags]
  bun run src/cli.ts detail <slug|YC company url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Every word must start a word in the name, one-liner, tags or industries.
  --batch <b[,b2]>        YC batch: W24, S24, F24, X25 (Spring), "Winter 2024", or a year (2025).
  --location, -l <text>   Case-insensitive substring of the locations/regions (comma = any of).
  --remote                Only companies listing Remote / Fully Remote / Partly Remote.
  --refresh               Re-download instead of using the 24 h cache.
  --page <n>              1-indexed page over the filtered results. Default 1.
  --limit, -n <n>         Results per page, 0-500. Default 25.
  --format <fmt>          json (default) | table | plain.

EXAMPLES
  bun run src/cli.ts search -q "AI" --batch S25 --format table
  bun run src/cli.ts search -q fintech -l "India" --format table
  bun run src/cli.ts search -q "developer tools" --remote --limit 10
  bun run src/cli.ts detail https://www.ycombinator.com/companies/circuithub --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "batch", "location", "remote", "refresh", "page", "limit", "format", "help"]),
  detail: new Set(["format", "refresh", "help"]),
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
    for (const name of ["query", "location", "batch"]) {
      if (flags[name] !== undefined && (typeof flags[name] !== "string" || !(flags[name] as string).trim())) {
        return badArg(`--${name} requires a non-empty value`)
      }
    }
    let batches: SearchOpts["batches"]
    if (typeof flags.batch === "string") {
      batches = []
      for (const part of flags.batch.split(",").map((s) => s.trim()).filter(Boolean)) {
        const b = normalizeBatch(part)
        if (!b) return badArg(`--batch "${part}" is not a YC batch (use W24, S24, F24, X25, "Winter 2024" or a year)`)
        batches.push(b)
      }
    }
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return badArg(`--format must be one of json|table|plain, got "${fmt}"`)
    const page = flags.page !== undefined ? intFlag(flags.page, 1) : 1
    if (page === null) return badArg(`--page must be a whole number of at least 1, got "${flags.page}"`)
    const limit = flags.limit !== undefined ? intFlag(flags.limit, 0, 500) : 25
    if (limit === null) return badArg(`--limit must be a whole number from 0 to 500, got "${flags.limit}"`)
    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query.trim() : undefined,
      batches,
      location: typeof flags.location === "string" ? flags.location.trim() : undefined,
      remote: flags.remote === true,
      refresh: flags.refresh === true,
      page,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  const id = (flags._ as string[])[1]
  if (!id) {
    writeError("detail requires a <slug|YC company url>", "NO_ID")
    return 1
  }
  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "plain"].includes(fmt)) return badArg(`--format must be one of json|plain, got "${fmt}"`)
  const opts: DetailOpts = { id, format: fmt as DetailOpts["format"], refresh: flags.refresh === true }
  return runDetail(opts)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
    process.exit(1)
  })
