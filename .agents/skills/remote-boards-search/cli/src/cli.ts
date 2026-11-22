#!/usr/bin/env bun
// Self-contained CLI aggregating public remote-job feeds/APIs: Remote OK,
// Himalayas, Jobicy, We Work Remotely (RSS) and Working Nomads. No external CLI
// framework and zero runtime dependencies, so it runs anywhere `bun` is
// available with nothing installed beyond the repo clone.
//
// Every board asks for attribution (link back / credit) and gentle use; keep
// volume low. Remotive is deliberately excluded (robots.txt disallows /api/*).

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { EXCLUDED_SOURCES, SOURCE_ALIASES, SOURCE_NAMES, type SourceName } from "./sources.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", n: "limit", s: "source" }
// Flags that never take a value, so `--india-friendly -q x` and
// `--india-friendly search` both parse as intended.
const BOOLEAN_FLAGS = new Set(["india-friendly", "title-only", "help", "h"])

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("-") || a === "-") {
      ;(flags._ as string[]).push(a)
      continue
    }
    let name = a.replace(/^-+/, "")
    let inline: string | undefined
    const eq = name.indexOf("=")
    if (eq !== -1) {
      inline = name.slice(eq + 1)
      name = name.slice(0, eq)
    }
    const key = ALIAS[name] ?? name
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = inline === undefined ? true : inline
      continue
    }
    if (inline !== undefined) {
      flags[key] = inline
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("-")) {
      flags[key] = next
      i++
    } else {
      flags[key] = true // a value flag with no value: validation rejects it
    }
  }
  return flags
}

const HELP = `remote-boards-cli — search public remote-job boards in one go
(Remote OK, Himalayas, Jobicy, We Work Remotely, Working Nomads)

USAGE
  bun run src/cli.ts search [-q "<keywords>"] [flags]
  bun run src/cli.ts detail <source:id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Phrase matched (whole words, plural ok, spaces/hyphens
                          interchangeable) against title, tags and description.
                          Uppercase OR separates alternatives: -q "llm OR rag".
  --title-only            Match -q against title + tags only (skips postings that
                          merely mention the phrase in company boilerplate).
  --source, -s <list>     Comma-separated boards. Default: all of
                          ${SOURCE_NAMES.join(", ")} (alias: wwr).
  --region <text>         Keep roles whose location restriction contains <text>
                          (comma = OR). "worldwide" also matches Anywhere/Global.
  --india-friendly        Keep roles open to candidates in India: Worldwide /
                          Anywhere / APAC / Asia / India or unspecified; drops
                          US-only, EU-only etc. (conservative, see SKILL.md).
  --jobage <days>         Posted within N days (client-side; undated postings dropped).
  --page <n>              1-indexed page over the merged results. Default 1.
  --limit, -n <n>         Results per page. Default 25.
  --timeout <seconds>     Per-request timeout per board. Default 15.
  --format <fmt>          json (default) | table | plain.

DETAIL
  <source:id>             An id from search, e.g. remoteok:1137690,
                          himalayas:linear/senior-product-engineer, jobicy:160069,
                          weworkremotely:<slug>, workingnomads:2007977.
  <url>                   A posting URL on one of those boards.

EXAMPLES
  bun run src/cli.ts search -q "machine learning" --india-friendly --limit 10 --format table
  bun run src/cli.ts search -q "llm OR rag" --india-friendly --jobage 14 --format table
  bun run src/cli.ts search -q "python" --source himalayas,jobicy --region APAC --format table
  bun run src/cli.ts detail himalayas:linear/senior-product-engineer --format plain

Credit the boards: every result links back to its source board; keep volume low.
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "query", "source", "region", "india-friendly", "title-only", "jobage", "page", "limit", "timeout", "format", "help", "h",
  ]),
  detail: new Set(["format", "timeout", "help", "h"]),
}

function fail(error: string, code = "BAD_ARG"): number {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
  return 1
}

/** Whole number >= 1 (Number(), not parseInt(), so "1.5" and "3x" are rejected, not truncated). */
function positiveInt(name: string, raw: string | boolean | string[]): number | string {
  const val = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(val) || val < 1) return `--${name} must be a whole number of at least 1, got ${typeof raw === "string" ? `"${raw}"` : "no value"}`
  return val
}

function stringFlag(flags: Flags, name: string): string | undefined | Error {
  const v = flags[name]
  if (v === undefined) return undefined
  if (typeof v !== "string" || !v.trim()) return new Error(`--${name} requires a non-empty value`)
  return v
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  // Unknown flags are rejected, never silently ignored: a discarded filter
  // changes what the search returns with no error.
  const known = KNOWN_FLAGS[cmd]
  if (!known) return fail(`Unknown command "${cmd}"`, "BAD_CMD")
  for (const key of Object.keys(flags)) {
    if (key === "_" || known.has(key)) continue
    return fail(
      `unknown flag --${key} for '${cmd}' - flags are never silently ignored, because a discarded filter changes what the search returns; see --help for the supported flags`,
      "UNKNOWN_FLAG",
    )
  }

  let timeoutMs = 15000
  if (flags.timeout !== undefined) {
    const t = positiveInt("timeout", flags.timeout)
    if (typeof t === "string") return fail(t)
    timeoutMs = Math.min(t, 120) * 1000
  }

  if (cmd === "search") {
    if ((flags._ as string[]).length > 1) {
      return fail(`unexpected argument "${(flags._ as string[])[1]}" - put keywords in -q "<keywords>"`)
    }
    const query = stringFlag(flags, "query")
    if (query instanceof Error) return fail(query.message)
    const region = stringFlag(flags, "region")
    if (region instanceof Error) return fail(region.message)
    const sourceRaw = stringFlag(flags, "source")
    if (sourceRaw instanceof Error) return fail(sourceRaw.message)

    let sources: SourceName[] = [...SOURCE_NAMES]
    if (sourceRaw) {
      const picked: SourceName[] = []
      for (const item of sourceRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        if (item in EXCLUDED_SOURCES) return fail(EXCLUDED_SOURCES[item], "EXCLUDED_SOURCE")
        if (item === "all") {
          picked.push(...SOURCE_NAMES)
          continue
        }
        const name = (SOURCE_ALIASES[item] ?? item) as SourceName
        if (!SOURCE_NAMES.includes(name)) {
          return fail(`--source: unknown board "${item}" - one of ${SOURCE_NAMES.join(", ")}`)
        }
        picked.push(name)
      }
      if (picked.length === 0) return fail("--source requires at least one board")
      sources = [...new Set(picked)]
    }

    for (const b of ["india-friendly", "title-only"]) {
      if (flags[b] !== undefined && flags[b] !== true) return fail(`--${b} takes no value, got "${flags[b]}"`)
    }
    const india = flags["india-friendly"]
    if (flags["title-only"] === true && !query) return fail("--title-only needs a -q query to apply to")

    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) {
      return fail(`--format must be one of json|table|plain, got "${flags.format === true ? "" : fmt}"`)
    }

    const nums: Record<string, number | undefined> = {}
    for (const name of ["jobage", "page", "limit"]) {
      if (flags[name] === undefined) continue
      const v = positiveInt(name, flags[name])
      if (typeof v === "string") return fail(v)
      nums[name] = v
    }

    const opts: SearchOpts = {
      query,
      sources,
      regions: region ? region.split(",").map((r) => r.trim()).filter(Boolean) : [],
      indiaFriendly: india === true,
      titleOnly: flags["title-only"] === true,
      jobage: nums.jobage,
      page: nums.page ?? 1,
      limit: nums.limit ?? 25,
      format: fmt as SearchOpts["format"],
      timeoutMs,
    }
    return runSearch(opts)
  }

  // detail
  const positional = flags._ as string[]
  const id = positional[1]
  if (!id) return fail("detail requires a <source:id|url>", "NO_ID")
  if (positional.length > 2) return fail(`detail takes one <source:id|url>, got ${positional.length - 1}`)
  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "plain"].includes(fmt)) {
    return fail(`--format must be one of json|plain, got "${flags.format === true ? "" : fmt}"`)
  }
  const opts: DetailOpts = { id, format: fmt as DetailOpts["format"], timeoutMs }
  return runDetail(opts)
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(
        JSON.stringify({ error: e instanceof Error ? e.message : String(e), code: "INTERNAL_ERROR" }) + "\n",
      )
      process.exit(1)
    })
}
