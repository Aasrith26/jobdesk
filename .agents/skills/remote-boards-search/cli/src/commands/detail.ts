import { stripInvisible, writeError } from "../helpers.js"
import { assessIndia } from "./search.js"
import { EXCLUDED_SOURCES, SOURCES, SOURCE_ALIASES, SOURCE_NAMES, type SourceName } from "../sources.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
  timeoutMs: number
}

export type ParsedId =
  | { ok: true; source: SourceName; nativeId: string }
  | { ok: false; error: string; code: string }

/**
 * Accept `<source>:<id>` (as search results carry it) or a posting URL on one
 * of the boards. Hosts are compared through real URL parsing, so look-alike
 * hosts (remoteok.com.evil.io) and userinfo tricks are rejected; a URL on any
 * other host (an employer's apply link) is BAD_ID before any request.
 */
export function parseId(input: string): ParsedId {
  const trimmed = input.trim()
  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (hasScheme || /^(www\.)?[a-z0-9-]+\.[a-z]{2,}\//i.test(trimmed)) {
    let u: URL
    try {
      u = new URL(hasScheme ? trimmed : `https://${trimmed}`)
    } catch {
      return { ok: false, error: `not a valid URL: "${input}"`, code: "BAD_ID" }
    }
    if (/(^|\.)remotive\.com$/i.test(u.hostname)) {
      return { ok: false, error: EXCLUDED_SOURCES.remotive, code: "EXCLUDED_SOURCE" }
    }
    for (const name of SOURCE_NAMES) {
      const nativeId = SOURCES[name].idFromUrl(u)
      if (nativeId) return { ok: true, source: name, nativeId }
    }
    return {
      ok: false,
      error: `"${input}" is not a posting URL on a supported board (${SOURCE_NAMES.join(", ")})`,
      code: "BAD_ID",
    }
  }
  const m = trimmed.match(/^([a-z-]+):(.+)$/i)
  if (!m) {
    return { ok: false, error: `expected <source>:<id> (e.g. remoteok:1137690) or a posting URL, got "${input}"`, code: "BAD_ID" }
  }
  const raw = m[1].toLowerCase()
  if (raw in EXCLUDED_SOURCES) return { ok: false, error: EXCLUDED_SOURCES[raw], code: "EXCLUDED_SOURCE" }
  const source = (SOURCE_ALIASES[raw] ?? raw) as SourceName
  if (!SOURCE_NAMES.includes(source)) {
    return { ok: false, error: `unknown source "${m[1]}" - one of ${SOURCE_NAMES.join(", ")}`, code: "BAD_ID" }
  }
  const nativeId = m[2].trim()
  if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(nativeId) || nativeId.includes("..")) {
    return { ok: false, error: `malformed ${source} id "${nativeId}"`, code: "BAD_ID" }
  }
  return { ok: true, source, nativeId }
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const parsed = parseId(opts.id)
  if (!parsed.ok) {
    writeError(parsed.error, parsed.code)
    return 1
  }
  const src = SOURCES[parsed.source]
  try {
    const job = await src.detail(parsed.nativeId, opts.timeoutMs)
    if (!job) {
      writeError(
        `${src.label} posting "${parsed.nativeId}" not found (the board's feed may no longer carry it, or the id is wrong)`,
        "NOT_FOUND",
      )
      return 1
    }
    const { indiaFriendly, restrictionHint } = assessIndia(job)
    const { eligibility: _drop, ...rest } = job
    const out = stripInvisible({
      ...rest,
      location: job.region ? `Remote (${job.region})` : "Remote",
      indiaFriendly,
      restrictionHint,
      attribution: src.attribution,
    })

    if (opts.format === "plain") {
      const lines = [
        out.title,
        `${out.company ?? "—"} · ${out.region ?? "region unspecified"} · ${out.date ?? "—"}`,
        "",
        out.salary ? `Salary: ${out.salary}` : null,
        out.employmentType ? `Employment: ${out.employmentType}` : null,
        out.tags.length ? `Tags: ${out.tags.join(", ")}` : null,
        `India-friendly: ${out.indiaFriendly ? "yes" : "no"}${restrictionHint ? ` (${restrictionHint})` : ""}`,
        `Status: ${out.status.toUpperCase()}${out.validThrough ? ` (listed until ${out.validThrough})` : ""}`,
        "",
        out.description ?? "(no description)",
        "",
        `URL: ${out.url}`,
        out.applyUrl && out.applyUrl !== out.url ? `Apply: ${out.applyUrl}` : null,
        `Source: ${out.attribution}`,
      ].filter((l): l is string => l !== null)
      process.stdout.write(lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
