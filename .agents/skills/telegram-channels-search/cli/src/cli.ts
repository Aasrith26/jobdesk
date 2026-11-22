#!/usr/bin/env bun
// Self-contained CLI for reading job/lead posts from public Telegram channels
// through their public web preview (https://t.me/s/<channel>). No login, no
// Bot API, no external CLI framework and zero runtime dependencies.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { channelsFromConfig, configPath, normalizeChannel, writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", n: "limit", c: "channels", h: "help" }
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

const HELP = `telegram-channels-cli — read job/lead posts from public Telegram channel previews (t.me/s/<channel>)

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <channel/id|t.me URL> [--format json|plain]

SEARCH FLAGS
  --channels, -c <a,b>    Comma-separated public channel usernames (@name or t.me/name also accepted).
                          Default: "telegram_channels" in wrapper-data/config.json. No built-in list.
  --query, -q <text>      Keywords, client-side: every word must appear in the message (case-insensitive).
  --jobage <days>         Only messages posted within the last N days.
  --remote                Only messages whose title/first lines mention remote work.
  --india-friendly        Only messages naming India/an Indian city/APAC, or worldwide/anywhere.
  --page <n>              1-indexed page over the filtered results. Default 1.
  --limit, -n <n>         Results per page (client-side), 0-1000. Default 25.
  --format <fmt>          json (default) | table | plain.

Each channel preview shows its ~20 most recent messages; one request per channel,
at most one request every 2 s, and only after tools/robots_check.py allows the URL.

EXAMPLES
  bun run src/cli.ts search -c opento_dev -q python --format table
  bun run src/cli.ts search -q "backend remote" --jobage 7
  bun run src/cli.ts detail https://t.me/opento_dev/1338 --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "channels", "jobage", "remote", "india-friendly", "page", "limit", "format", "help"]),
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

/** Validate and de-duplicate channel names; returns the list or an error message. */
export function resolveChannels(raw: string[]): string[] | string {
  const out: string[] = []
  for (const r of raw) {
    if (!r.trim()) continue
    const c = normalizeChannel(r)
    if (!c) return `"${r}" is not a public Telegram channel username (4-32 letters, digits or _, starting with a letter)`
    if (!out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c)
  }
  return out
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
    if ((flags._ as string[]).length > 1) return badArg(`unexpected argument "${(flags._ as string[])[1]}" (use -q for keywords, -c for channels)`)
    for (const name of ["query", "channels"]) {
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
    const page = flags.page !== undefined ? intFlag(flags.page, 1) : 1
    if (page === null) return badArg(`--page must be a whole number of at least 1, got "${flags.page}"`)
    const limit = flags.limit !== undefined ? intFlag(flags.limit, 0, 1000) : 25
    if (limit === null) return badArg(`--limit must be a whole number from 0 to 1000, got "${flags.limit}"`)

    let rawChannels: string[]
    if (typeof flags.channels === "string") {
      rawChannels = flags.channels.split(",")
    } else {
      let fromConfig: string[] | null
      try {
        fromConfig = channelsFromConfig()
      } catch (e) {
        writeError(e instanceof Error ? e.message : String(e), "BAD_CONFIG")
        return 1
      }
      if (!fromConfig || fromConfig.length === 0) {
        writeError(`no channels: pass --channels a,b or set "telegram_channels" (array of channel usernames) in ${configPath()}`, "NO_CHANNELS")
        return 1
      }
      rawChannels = fromConfig
    }
    const channels = resolveChannels(rawChannels)
    if (typeof channels === "string") return badArg(channels)
    if (channels.length === 0) return badArg("--channels lists no channel")
    if (channels.length > 25) return badArg(`at most 25 channels per run (got ${channels.length}); keep volume low`)

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query.trim() : undefined,
      channels,
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
    writeError("detail requires a <channel/id|t.me URL>", "NO_ID")
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
