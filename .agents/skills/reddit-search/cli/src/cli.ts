#!/usr/bin/env bun
// Self-contained CLI for reading job posts from public subreddit RSS/Atom feeds
// (https://www.reddit.com/r/<sub>/new/.rss). No OAuth, no JSON API, no login,
// no external CLI framework and zero runtime dependencies. Every URL passes the
// repo's robots.txt gate (tools/robots_check.py) before it is fetched.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { DEFAULT_SUBREDDITS, normalizeSubreddit, writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", n: "limit", s: "subreddits", h: "help" }
/** Flags that never take a value: the next argv token stays a positional / next flag. */
const BOOLEAN_FLAGS = new Set(["remote", "india-friendly", "include-for-hire", "help"])

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

const HELP = `reddit-cli — read job posts from public subreddit RSS feeds

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <post id|reddit URL> [--format json|plain]

SEARCH FLAGS
  --subreddits, -s <a,b>  Comma-separated subreddits (r/ prefix optional).
                          Default: ${DEFAULT_SUBREDDITS.join(",")}
  --query, -q <text>      Keywords, client-side: every word must appear in title + body (case-insensitive).
  --include-for-hire      In r/forhire, also keep [For Hire] and untagged posts (default: [Hiring] only).
  --per-sub <n>           Newest posts to read per subreddit feed, 1-100. Default 25.
  --jobage <days>         Only posts made within the last N days.
  --remote                Only posts whose title/tags mention remote work.
  --india-friendly        Only posts naming India/an Indian city/APAC, or worldwide/anywhere.
  --page <n>              1-indexed page over the filtered results. Default 1.
  --limit, -n <n>         Results per page (client-side), 0-1000. Default 25.
  --format <fmt>          json (default) | table | plain.

One request per subreddit, at most one request every 2 s, and only after
tools/robots_check.py allows the URL (reddit.com's robots.txt currently
disallows all paths for all agents, so this CLI fetches nothing - see SKILL.md).

EXAMPLES
  bun run src/cli.ts search -q python --format table
  bun run src/cli.ts search -s forhire,remotejs -q "react" --jobage 7
  bun run src/cli.ts detail https://www.reddit.com/r/forhire/comments/abc123/hiring_example/ --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "subreddits", "include-for-hire", "per-sub", "jobage", "remote", "india-friendly", "page", "limit", "format", "help"]),
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
    if ((flags._ as string[]).length > 1) return badArg(`unexpected argument "${(flags._ as string[])[1]}" (use -q for keywords, -s for subreddits)`)
    for (const name of ["query", "subreddits"]) {
      if (flags[name] !== undefined && (typeof flags[name] !== "string" || !(flags[name] as string).trim())) {
        return badArg(`--${name} requires a non-empty value`)
      }
    }
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return badArg(`--format must be one of json|table|plain, got "${fmt}"`)

    let jobage: number | undefined
    if (flags.jobage !== undefined) {
      const v = intFlag(flags.jobage, 1)
      if (v === null) return badArg(`--jobage must be a whole number of at least 1, got "${flags.jobage}"`)
      jobage = v
    }
    const perSub = flags["per-sub"] !== undefined ? intFlag(flags["per-sub"], 1, 100) : 25
    if (perSub === null) return badArg(`--per-sub must be a whole number from 1 to 100, got "${flags["per-sub"]}"`)
    const page = flags.page !== undefined ? intFlag(flags.page, 1) : 1
    if (page === null) return badArg(`--page must be a whole number of at least 1, got "${flags.page}"`)
    const limit = flags.limit !== undefined ? intFlag(flags.limit, 0, 1000) : 25
    if (limit === null) return badArg(`--limit must be a whole number from 0 to 1000, got "${flags.limit}"`)

    const raw = typeof flags.subreddits === "string" ? flags.subreddits.split(",") : DEFAULT_SUBREDDITS
    const subreddits: string[] = []
    for (const r of raw) {
      if (!r.trim()) continue
      const s = normalizeSubreddit(r)
      if (!s) return badArg(`"${r}" is not a subreddit name (2-21 letters, digits or _)`)
      if (!subreddits.some((x) => x.toLowerCase() === s.toLowerCase())) subreddits.push(s)
    }
    if (subreddits.length === 0) return badArg("--subreddits lists no subreddit")
    if (subreddits.length > 15) return badArg(`at most 15 subreddits per run (got ${subreddits.length}); keep volume low`)

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query.trim() : undefined,
      subreddits,
      includeForHire: flags["include-for-hire"] === true,
      perSub,
      jobage,
      remote: flags.remote === true,
      indiaFriendly: flags["india-friendly"] === true,
      page,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  // detail
  if ((flags._ as string[]).length > 2) return badArg(`unexpected argument "${(flags._ as string[])[2]}"`)
  const id = (flags._ as string[])[1]
  if (!id) {
    writeError("detail requires a <post id|reddit URL>", "NO_ID")
    return 1
  }
  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "plain"].includes(fmt)) return badArg(`--format must be one of json|plain, got "${fmt}"`)
  const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
  return runDetail(opts)
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
      process.exit(1)
    })
}
