import { CliError, cleanText, loadJson, stripInvisible, writeError, type YcCompany } from "../helpers.js"
import { toLead } from "./search.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
  refresh: boolean
}

/**
 * Accept a bare slug ("circuithub") or a YC company URL
 * (`https://www.ycombinator.com/companies/<slug>[/jobs|/...]`, scheme optional).
 * Any other host is rejected; parsed with real URL parsing so look-alike hosts
 * and userinfo fall on the reject side.
 */
export function parseSlug(input: string): string | null {
  const s = input.trim()
  if (/^[a-z0-9][a-z0-9-]{0,99}$/i.test(s)) return s.toLowerCase()
  const hasScheme = /^https?:\/\//i.test(s)
  if (!hasScheme && !/^(?:www\.)?ycombinator\.com\//i.test(s)) return null
  let u: URL
  try {
    u = new URL(hasScheme ? s : `https://${s}`)
  } catch {
    return null
  }
  if (!/^(?:www\.)?ycombinator\.com$/i.test(u.hostname) || u.username || u.password) return null
  const m = /^\/companies\/([a-z0-9][a-z0-9-]{0,99})(?:\/.*)?$/i.exec(u.pathname)
  return m ? m[1].toLowerCase() : null
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const slug = parseSlug(opts.id)
  if (!slug) {
    writeError(`Could not parse a YC company slug from "${opts.id}" (pass a slug or https://www.ycombinator.com/companies/<slug>)`, "BAD_ID")
    return 1
  }
  try {
    const hiring = await loadJson<YcCompany[]>("companies/hiring.json", { refresh: opts.refresh })
    let company = hiring.data.find((c) => c.slug?.toLowerCase() === slug)
    let source = "companies/hiring.json"
    if (!company) {
      // Not in the hiring list: look it up among all launched companies (~11 MB, cached 24 h).
      const all = await loadJson<YcCompany[]>("companies/all.json", { refresh: opts.refresh })
      company = all.data.find((c) => c.slug?.toLowerCase() === slug)
      source = "companies/all.json"
    }
    if (!company) {
      writeError(`No YC company with slug "${slug}" in the yc-oss directory`, "NOT_FOUND")
      return 1
    }
    const lead = toLead(company)
    const record = stripInvisible({
      ...lead,
      is_hiring: company.isHiring === true,
      former_names: company.former_names ?? [],
      industry: company.industry ?? null,
      subindustry: company.subindustry ?? null,
      launched_date: typeof company.launched_at === "number" ? new Date(company.launched_at * 1000).toISOString().slice(0, 10) : null,
      nonprofit: company.nonprofit === true,
      description: cleanText(company.long_description),
      source: `https://yc-oss.github.io/api/${source}`,
    })
    const { snippet: _snippet, ...rest } = record

    if (opts.format === "plain") {
      const lines = [
        rest.header,
        `${rest.is_hiring ? "Hiring (per YC directory)" : "NOT marked as hiring in the YC directory"} · ${rest.status ?? "?"} · ${rest.stage ?? "?"} stage · team ${rest.team_size ?? "?"}`,
        `Batch: ${rest.batch ?? "—"} · Launched: ${rest.launched_date ?? "—"}`,
        `Location: ${rest.location ?? "—"} · Regions: ${rest.regions.join(", ") || "—"}`,
        `Industries: ${rest.industries.join(", ") || "—"}`,
        rest.tags.length ? `Tags: ${rest.tags.join(", ")}` : "",
      ].filter(Boolean)
      const foot = [`YC page: ${rest.url}`, rest.apply_url ? `Jobs: ${rest.apply_url}` : "", rest.website ? `Website: ${rest.website}` : ""].filter(Boolean)
      process.stdout.write([lines.join("\n"), rest.description ?? rest.one_liner ?? "(no description)", foot.join("\n")].join("\n\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(rest, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), e instanceof CliError && e.code !== "HTTP_ERROR" ? e.code : "DETAIL_FAILED")
    return 1
  }
}
