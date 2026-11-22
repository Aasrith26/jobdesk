#!/usr/bin/env bun
// Self-contained CLI for finding contribution / paid-work leads on GitHub:
// open "help wanted" / hiring / paid / bounty / contract issues, and repos
// whose README says "we're hiring", through the official GitHub REST API.
// No external CLI framework and zero runtime dependencies.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", n: "limit", h: "help" }
/** Flags that never take a value: the next argv token stays a positional / next flag. */
const BOOLEAN_FLAGS = new Set(["no-stars", "help"])

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

const HELP = `github-helpwanted-cli — find help-wanted / paid / hiring leads on GitHub

USAGE
  bun run src/cli.ts search -q <skill> [flags]
  bun run src/cli.ts detail <issue url|owner/repo#n|repo url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords (a skill, language or topic), passed to GitHub search.
  --mode issues|repos     issues (default): open issues labelled "help wanted" or mentioning
                          hiring/paid/bounty/contract. repos: repos whose README says "we're hiring".
  --days <n>              Only issues updated (repos pushed) in the last N days, 1-365. Default 30.
  --language <lang>       GitHub language: qualifier (e.g. python, typescript).
  --min-stars <n>         Only repos with at least N stars (issues mode: drops repos whose
                          stars could not be looked up).
  --no-stars              Issues mode: skip the per-repo star lookups (saves core API quota).
  --page <n>              1-indexed page over the filtered results. Default 1.
  --limit, -n <n>         Results per page, 0-100. Default 25.
  --format <fmt>          json (default) | table | plain.

ENV
  GITHUB_TOKEN            Optional. Raises the search limit from 10 to 30 requests/min. Never printed.

EXAMPLES
  bun run src/cli.ts search -q python --format table
  bun run src/cli.ts search -q "llm" --language python --min-stars 50 --days 14
  bun run src/cli.ts search -q "machine learning" --mode repos --format table
  bun run src/cli.ts detail https://github.com/owner/repo/issues/123 --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "mode", "days", "language", "min-stars", "no-stars", "page", "limit", "format", "help"]),
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
    for (const name of ["query", "language"]) {
      if (flags[name] !== undefined && (typeof flags[name] !== "string" || !(flags[name] as string).trim())) {
        return badArg(`--${name} requires a non-empty value`)
      }
    }
    if (typeof flags.query === "string" && flags.query.length > 200) return badArg("--query is too long (max 200 characters)")
    if (typeof flags.language === "string" && !/^[A-Za-z0-9+#.\- ]{1,40}$/.test(flags.language.trim())) {
      return badArg(`--language must be a language name such as python or c++, got "${flags.language}"`)
    }
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return badArg(`--format must be one of json|table|plain, got "${fmt}"`)
    const mode = flags.mode !== undefined ? String(flags.mode) : "issues"
    if (!["issues", "repos"].includes(mode)) return badArg(`--mode must be issues or repos, got "${mode}"`)

    const days = flags.days !== undefined ? intFlag(flags.days, 1, 365) : 30
    if (days === null) return badArg(`--days must be a whole number from 1 to 365, got "${flags.days}"`)
    let minStars: number | undefined
    if (flags["min-stars"] !== undefined) {
      const v = intFlag(flags["min-stars"], 0)
      if (v === null) return badArg(`--min-stars must be a whole number of at least 0, got "${flags["min-stars"]}"`)
      minStars = v
    }
    if (flags["no-stars"] === true && mode === "repos") return badArg("--no-stars applies to --mode issues only (repo search always carries stars)")
    if (flags["no-stars"] === true && minStars !== undefined) return badArg("--no-stars and --min-stars conflict: the star filter needs the lookups")
    const page = flags.page !== undefined ? intFlag(flags.page, 1) : 1
    if (page === null) return badArg(`--page must be a whole number of at least 1, got "${flags.page}"`)
    const limit = flags.limit !== undefined ? intFlag(flags.limit, 0, 100) : 25
    if (limit === null) return badArg(`--limit must be a whole number from 0 to 100, got "${flags.limit}"`)

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query.trim() : undefined,
      mode: mode as SearchOpts["mode"],
      days,
      language: typeof flags.language === "string" ? flags.language.trim() : undefined,
      minStars,
      noStars: flags["no-stars"] === true,
      page,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  // detail
  const target = (flags._ as string[])[1]
  if (!target) {
    writeError("detail requires an <issue url|owner/repo#n|repo url>", "NO_ID")
    return 1
  }
  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "plain"].includes(fmt)) return badArg(`--format must be one of json|plain, got "${fmt}"`)
  const opts: DetailOpts = { url: target, format: fmt as DetailOpts["format"] }
  return runDetail(opts)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
    process.exit(1)
  })
