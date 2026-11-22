// LinkedIn assist without scraping (LEAD-8) and referral matching from the user's own
// connections export (OUT-3). No request is ever sent to LinkedIn by this module.

import { readFileSync } from "node:fs"
import { parseCsv } from "./data/csv.ts"

const quote = (t: string) => (/\s/.test(t.trim()) ? `"${t.trim()}"` : t.trim())

export function booleanQuery(skills: string[], opts: { hiringWords?: string[]; exclude?: string[] } = {}): string {
  const hiring = opts.hiringWords ?? ["hiring", "looking for", "we're hiring", "need help", "contract"]
  const parts = [`(${hiring.map(quote).join(" OR ")})`, `(${skills.filter(Boolean).map(quote).join(" OR ")})`]
  let q = parts.join(" AND ")
  for (const x of opts.exclude ?? ["recruitment agency"]) q += ` NOT ${quote(x)}`
  return q
}

/** URLs the user opens in their own browser, logged in as themselves. */
export function searchUrls(skills: string[], location?: string): { label: string; url: string }[] {
  const q = booleanQuery(skills)
  const posts = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(q)}&datePosted=%22past-week%22&sortBy=%22date_posted%22`
  const jobsQ = skills.filter(Boolean).map(quote).join(" OR ")
  const jobs = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(jobsQ)}${location ? `&location=${encodeURIComponent(location)}` : ""}&f_TPR=r604800&sortBy=DD`
  return [
    { label: "Posts from the past week that mention hiring", url: posts },
    { label: "Jobs posted in the past week", url: jobs },
  ]
}

export interface Connection {
  name: string
  company: string
  position: string
  url: string
}

/** Parse LinkedIn's Connections.csv export (it starts with a few "Notes" lines before the header). */
export function parseConnections(file: string): Connection[] {
  const rows = parseCsv(readFileSync(file, "utf8"))
  const hi = rows.findIndex((r) => r.some((c) => /^first name$/i.test(c.trim())))
  if (hi < 0) throw new Error("This doesn't look like LinkedIn's Connections.csv export (no 'First Name' column).")
  const h = rows[hi].map((c) => c.trim().toLowerCase())
  const col = (n: string) => h.indexOf(n)
  return rows.slice(hi + 1).map((r) => ({
    name: `${r[col("first name")] ?? ""} ${r[col("last name")] ?? ""}`.trim(),
    company: (r[col("company")] ?? "").trim(),
    position: (r[col("position")] ?? "").trim(),
    url: (r[col("url")] ?? "").trim(),
  })).filter((c) => c.name && c.company)
}

const norm = (s: string) =>
  s.toLowerCase().replace(/\b(private|pvt|limited|ltd|inc|llc|llp|corp(oration)?|technologies|technology|solutions|software|labs?|india|global)\b/g, "").replace(/[^a-z0-9]+/g, "")

export function matchReferrals(connections: Connection[], companies: string[]): { company: string; people: Connection[] }[] {
  const out: { company: string; people: Connection[] }[] = []
  for (const company of [...new Set(companies)]) {
    const n = norm(company)
    if (n.length < 2) continue
    const people = connections.filter((c) => {
      const m = norm(c.company)
      return m === n || (n.length >= 4 && (m.startsWith(n) || n.startsWith(m) && m.length >= 4))
    })
    if (people.length) out.push({ company, people })
  }
  return out
}
