#!/usr/bin/env bun
// Self-contained CLI that searches a curated list of companies' career boards
// through the official public job-board APIs of Greenhouse, Lever, Ashby,
// SmartRecruiters and Workable. No authentication, no API key, zero runtime
// dependencies - it runs anywhere `bun` is available.
//
// The company list lives in ../../companies.json (user-editable). Each search
// reads every selected board once (bounded concurrency), then filters
// client-side; one board failing never fails the run.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail } from "./commands/detail.js"
import { runCompanies } from "./commands/companies.js"
import {
  ATS_NAMES,
  ConfigError,
  DEFAULT_TIMEOUT_MS,
  loadCompanies,
  selectCompanies,
  splitList,
  writeError,
  type Company,
} from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", l: "location", n: "limit", h: "help" }

/** Flags that never take a value: a following word is a positional, not their value. */
const BOOLEAN_FLAGS = new Set(["remote", "in-description", "with-description", "check", "help"])

class UsageError extends Error {}
class NoCompaniesError extends Error {}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("-") || a === "-") {
      ;(flags._ as string[]).push(a)
      continue
    }
    const eq = a.indexOf("=")
    const rawName = (eq === -1 ? a : a.slice(0, eq)).replace(/^-+/, "")
    const key = ALIAS[rawName] ?? rawName
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) throw new UsageError(`--${key} takes no value`)
      flags[key] = true
      continue
    }
    if (eq !== -1) {
      flags[key] = a.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || (next.startsWith("-") && next !== "-")) {
      // Value missing: keep `true` so validation can name the flag.
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return flags
}

const HELP = `company-boards-cli — search target companies' career boards via official ATS APIs
(Greenhouse, Lever, Ashby, SmartRecruiters, Workable). Company list: companies.json.

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <ats:token:id|url> [--format json|plain]
  bun run src/cli.ts companies [--tag t] [--ats a] [--company c] [--check] [--format json|table|plain]

SEARCH FLAGS
  --query, -q <text>       Title keywords. Words are ANDed, each matched case-insensitively at
                           a word start; alternatives separated by " OR " or "|"; "quoted phrase".
  --in-description         Also match --query against the posting description.
  --location, -l <text>    Location substring(s), comma-separated = OR. "India" also matches
                           Indian cities (Bengaluru, Hyderabad, ...); "Bangalore" = "Bengaluru".
  --remote                 Include remote roles. Alone: remote roles only. With -l: the
                           location's roles plus remote roles open anywhere.
  --company <names>        Only these companies (comma-separated; name substring or exact token).
  --tag <tags>             Only companies with any of these tags (e.g. india,voice,llm-infra).
  --ats <names>            Only these ATSes (${ATS_NAMES.join(", ")}).
  --jobage <days>          Published within N days (undated postings are excluded).
  --page <n>               1-indexed page. Default 1.
  --limit, -n <n>          Results per page. Default 50.
  --with-description       Include each result's plain-text description (json only).
  --timeout <seconds>      Per-request timeout. Default ${DEFAULT_TIMEOUT_MS / 1000}.
  --format <fmt>           json (default) | table | plain.

EXAMPLES
  bun run src/cli.ts search -q "engineer" -l India --format table
  bun run src/cli.ts search -q "voice OR speech OR audio" --remote --format table
  bun run src/cli.ts search -q "ai engineer OR ml engineer OR llm" -l "Hyderabad,Bengaluru" --remote --jobage 30 --format table
  bun run src/cli.ts search -q "inference" --tag llm-infra --in-description --format table
  bun run src/cli.ts detail ashby:sarvam:<uuid> --format plain
  bun run src/cli.ts companies --check --tag voice
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "query", "in-description", "location", "remote", "company", "tag", "ats", "jobage", "page", "limit",
    "with-description", "timeout", "format", "help",
  ]),
  detail: new Set(["format", "timeout", "help"]),
  companies: new Set(["company", "tag", "ats", "check", "format", "timeout", "help"]),
}

function fail(error: string, code = "BAD_ARG"): number {
  writeError(error, code)
  return 1
}

/** A string flag's value, or an error when it is present without one. */
function stringFlag(flags: Flags, name: string): string | undefined {
  const v = flags[name]
  if (v === undefined) return undefined
  if (typeof v !== "string" || !v.trim()) throw new UsageError(`--${name} requires a non-empty value`)
  return v.trim()
}

/** Whole number >= min (Number(), not parseInt(): "0.5" or "7d" must not truncate silently). */
function intFlag(flags: Flags, name: string, min = 1): number | undefined {
  const v = flags[name]
  if (v === undefined) return undefined
  const n = typeof v === "string" ? Number(v.trim()) : NaN
  if (!Number.isInteger(n) || n < min) {
    throw new UsageError(`--${name} must be a whole number of at least ${min}, got ${typeof v === "string" ? `"${v}"` : "no value"}`)
  }
  return n
}

function formatFlag(flags: Flags, allowed: string[], fallback: string): string {
  const fmt = flags.format === undefined ? fallback : flags.format
  if (typeof fmt !== "string" || !allowed.includes(fmt)) {
    throw new UsageError(`--format must be one of ${allowed.join("|")}, got ${typeof fmt === "string" ? `"${fmt}"` : "no value"}`)
  }
  return fmt
}

function selectFromFlags(flags: Flags): Company[] {
  const companies = loadCompanies()
  const company = stringFlag(flags, "company")
  const tag = stringFlag(flags, "tag")
  const ats = stringFlag(flags, "ats")
  const atsList = ats ? splitList(ats) : undefined
  for (const a of atsList ?? []) {
    if (!(ATS_NAMES as readonly string[]).includes(a)) throw new UsageError(`--ats must list values from ${ATS_NAMES.join("|")}, got "${a}"`)
  }
  const selected = selectCompanies(companies, {
    company: company ? splitList(company) : undefined,
    tag: tag ? splitList(tag) : undefined,
    ats: atsList,
  })
  if (selected.length === 0) {
    throw new NoCompaniesError(
      `no configured company matches${company ? ` --company "${company}"` : ""}${tag ? ` --tag "${tag}"` : ""}${ats ? ` --ats "${ats}"` : ""}; run the 'companies' command to see the list`,
    )
  }
  return selected
}

async function main(): Promise<number> {
  let flags: Flags
  try {
    flags = parseFlags(process.argv.slice(2))
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  const positional = flags._ as string[]
  const cmd = positional[0]

  if (!cmd || flags.help) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  // Reject unknown flags instead of silently discarding them: a discarded
  // filter changes what the search returns with no error. add-portal.md's
  // contract requires a bogus flag to exit 1 with a JSON error on stderr.
  const knownFlags = KNOWN_FLAGS[cmd]
  if (!knownFlags) return fail(`Unknown command "${cmd}" (expected search, detail or companies)`, "BAD_CMD")
  for (const key of Object.keys(flags)) {
    if (key === "_" || knownFlags.has(key)) continue
    return fail(
      `unknown flag --${key} for '${cmd}' - flags are never silently ignored, because a discarded filter changes what the search returns; see --help for the supported flags`,
      "UNKNOWN_FLAG",
    )
  }

  try {
    const timeoutSec = intFlag(flags, "timeout")
    const timeoutMs = timeoutSec !== undefined ? timeoutSec * 1000 : undefined

    if (cmd === "search") {
      if (positional.length > 1) {
        return fail(`unexpected argument "${positional[1]}" - search takes only flags (--remote takes no value; quote multi-word --query/--location values)`)
      }
      const query = stringFlag(flags, "query")
      if (flags["in-description"] && !query) return fail("--in-description needs --query")
      const opts: SearchOpts = {
        companies: selectFromFlags(flags),
        query,
        inDescription: flags["in-description"] === true,
        location: stringFlag(flags, "location"),
        remote: flags.remote === true,
        jobage: intFlag(flags, "jobage"),
        page: intFlag(flags, "page") ?? 1,
        limit: intFlag(flags, "limit") ?? 50,
        format: formatFlag(flags, ["json", "table", "plain"], "json") as SearchOpts["format"],
        withDescription: flags["with-description"] === true,
        timeoutMs,
      }
      if (opts.withDescription && opts.format !== "json") return fail("--with-description only applies to --format json")
      return await runSearch(opts)
    }

    if (cmd === "detail") {
      const ref = positional[1]
      if (!ref) return fail("detail requires an <ats:token:id|url> argument", "NO_ID")
      if (positional.length > 2) return fail(`unexpected argument "${positional[2]}" - detail takes one id or url`)
      const format = formatFlag(flags, ["json", "plain"], "json") as "json" | "plain"
      return await runDetail({ ref, companies: loadCompanies(), format, timeoutMs })
    }

    // companies
    if (positional.length > 1) return fail(`unexpected argument "${positional[1]}" - companies takes only flags`)
    const format = formatFlag(flags, ["json", "table", "plain"], "json") as "json" | "table" | "plain"
    return await runCompanies({ companies: selectFromFlags(flags), check: flags.check === true, format, timeoutMs })
  } catch (e) {
    if (e instanceof UsageError) return fail(e.message)
    if (e instanceof ConfigError) return fail(e.message, "CONFIG_ERROR")
    if (e instanceof NoCompaniesError) return fail(e.message, "NO_COMPANIES")
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "request timed out" : e.message) : String(e)
    return fail(msg, cmd === "detail" ? "DETAIL_FAILED" : "SEARCH_FAILED")
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
      process.exit(1)
    })
}
