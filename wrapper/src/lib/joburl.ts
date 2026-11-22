// One job, many links: the search may store https://in.linkedin.com/jobs/view/genai-engineer-at-acme-4448040623
// while /apply records https://www.linkedin.com/jobs/view/4448040623. Compare jobs by identity, never by
// the exact text of the link.

/** A stable identity for a job link: host without www/country prefixes, no query or fragment. */
export function jobUrlKey(url: string): string {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "")
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "")
  const path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, "")
  // LinkedIn: country subdomains (in., uk., …) and the slug before the job number are cosmetic.
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    const id = path.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})$/)?.[1] ?? u.searchParams.get("currentJobId")
    if (id) return `linkedin:${id}`
    return `linkedin.com${path}`
  }
  return `${host}${path}`
}

export function sameJobUrl(a: string, b: string): boolean {
  return !!a && !!b && jobUrlKey(a) === jobUrlKey(b)
}

/** Company + role, loosely: "Acme Inc." / "acme" and "AI Engineer " / "ai engineer" are the same. */
export function companyRoleKey(company: string, role: string): string {
  const n = (s: string) => s.toLowerCase().replace(/\b(inc|llc|ltd|limited|pvt|private|gmbh|corp|co)\b\.?/g, "").replace(/[^a-z0-9]+/g, " ").trim()
  return `${n(company)}|${n(role)}`
}
