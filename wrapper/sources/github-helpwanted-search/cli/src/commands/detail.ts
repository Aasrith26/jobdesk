import {
  API_URL,
  CliError,
  extractLinks,
  getRepo,
  ghFetch,
  htmlToText,
  isoDate,
  markdownToText,
  readRepoCache,
  redact,
  stripInvisible,
  writeError,
  writeRepoCache,
  type RawRepo,
} from "../helpers.js"

export interface DetailOpts {
  url: string
  format: "json" | "plain"
}

export type Target = { kind: "issue"; owner: string; repo: string; number: number } | { kind: "repo"; owner: string; repo: string }

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/

/**
 * Accept `https://github.com/<owner>/<repo>/issues/<n>` (an issue) or
 * `https://github.com/<owner>/<repo>` (a repo, for --mode repos results), with
 * or without the scheme, or the short `owner/repo#n`. Any other host is
 * rejected; host and path are read through real URL parsing so look-alike
 * hosts and userinfo tricks fall on the reject side.
 */
export function parseTarget(input: string): Target | null {
  const s = input.trim()
  const short = /^([^/\s#]+)\/([^/\s#]+)#(\d{1,9})$/.exec(s)
  if (short) {
    return OWNER.test(short[1]) && REPO.test(short[2]) ? { kind: "issue", owner: short[1], repo: short[2], number: Number(short[3]) } : null
  }
  const hasScheme = /^https?:\/\//i.test(s)
  if (!hasScheme && !/^(?:www\.)?github\.com\//i.test(s)) return null
  let u: URL
  try {
    u = new URL(hasScheme ? s : `https://${s}`)
  } catch {
    return null
  }
  if (!/^(?:www\.)?github\.com$/i.test(u.hostname) || u.username || u.password) return null
  const parts = u.pathname.split("/").filter(Boolean)
  if (parts.length < 2 || !OWNER.test(parts[0]) || !REPO.test(parts[1].replace(/\.git$/, ""))) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, "")
  if (parts.length === 2) return { kind: "repo", owner, repo }
  if (parts.length === 4 && parts[2] === "issues" && /^\d{1,9}$/.test(parts[3])) {
    return { kind: "issue", owner, repo, number: Number(parts[3]) }
  }
  return null
}

interface FullIssue {
  html_url: string
  number: number
  title: string
  state?: string
  body?: string | null
  body_html?: string | null
  labels?: Array<{ name?: string } | string>
  user?: { login?: string } | null
  comments?: number
  created_at?: string
  updated_at?: string
  closed_at?: string | null
  pull_request?: unknown
  assignees?: Array<{ login?: string }>
}

const MAX_TEXT = 20000

export async function runDetail(opts: DetailOpts): Promise<number> {
  const target = parseTarget(opts.url)
  if (!target) {
    writeError(
      `Could not parse a GitHub issue or repo from "${opts.url}" (pass https://github.com/<owner>/<repo>/issues/<n>, owner/repo#n, or https://github.com/<owner>/<repo>)`,
      "BAD_URL",
    )
    return 1
  }
  try {
    const full = `${target.owner}/${target.repo}`
    const cache = readRepoCache()
    let record: Record<string, unknown>
    if (target.kind === "issue") {
      // full+json returns body (markdown) and body_html (GitHub's sanitized render, comments already gone).
      const res = await ghFetch<FullIssue>(`${API_URL}/repos/${full}/issues/${target.number}`, {
        resource: "core",
        accept: "application/vnd.github.full+json",
      })
      if (!res) {
        writeError(`GitHub issue ${full}#${target.number} not found`, "NOT_FOUND")
        return 1
      }
      const it = res.data
      if (it.pull_request) {
        writeError(`${full}#${target.number} is a pull request, not an issue`, "NOT_AN_ISSUE")
        return 1
      }
      const repoInfo = await getRepo(full, cache)
      writeRepoCache(cache)
      const description = it.body_html ? htmlToText(it.body_html) : markdownToText(it.body ?? "")
      const labels = (it.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean)
      record = {
        id: `${full}#${it.number}`,
        kind: "lead",
        lead_type: "github_issue",
        title: it.title,
        company: target.owner,
        url: it.html_url,
        state: it.state ?? null,
        labels: labels.slice(0, 10),
        author: it.user?.login ?? null,
        assignees: (it.assignees ?? []).map((a) => a.login).filter(Boolean),
        comments: it.comments ?? null,
        posted_date: isoDate(it.created_at),
        updated_date: isoDate(it.updated_at),
        closed_date: isoDate(it.closed_at ?? null),
        repo: full,
        repo_stars: repoInfo?.stars ?? null,
        repo_description: repoInfo?.description ?? null,
        repo_archived: repoInfo?.archived ?? null,
        links: it.body_html ? extractLinks(it.body_html) : [],
        description: description ? description.slice(0, MAX_TEXT) : null,
        truncated: description.length > MAX_TEXT,
      }
    } else {
      const res = await ghFetch<RawRepo>(`${API_URL}/repos/${full}`, { resource: "core" })
      if (!res) {
        writeError(`GitHub repo ${full} not found`, "NOT_FOUND")
        return 1
      }
      const r = res.data
      const readme = await ghFetch<string>(`${API_URL}/repos/${full}/readme`, {
        resource: "core",
        accept: "application/vnd.github.html+json",
        raw: true,
      })
      const text = readme ? htmlToText(readme.data) : ""
      // The paragraphs that actually talk about hiring, so a reader need not scan the whole README.
      const hiring = text
        .split(/\n{2,}/)
        .filter((p) => /\b(?:hiring|careers?|join (?:us|our team)|open (?:roles|positions)|jobs?)\b/i.test(p))
        .slice(0, 6)
      record = {
        id: r.full_name,
        kind: "lead",
        lead_type: "github_repo_hiring",
        title: `${r.owner?.login ?? target.owner} is hiring (README of ${r.full_name})`,
        company: r.owner?.login ?? target.owner,
        url: r.html_url ?? `https://github.com/${full}`,
        repo: r.full_name,
        repo_stars: r.stargazers_count ?? null,
        repo_description: r.description ?? null,
        owner_type: r.owner?.type ?? null,
        homepage: r.homepage || null,
        topics: r.topics ?? [],
        language: r.language ?? null,
        pushed_date: isoDate(r.pushed_at ?? null),
        archived: r.archived === true,
        hiring_excerpt: hiring,
        links: readme ? extractLinks(readme.data).slice(0, 40) : [],
        description: text ? text.slice(0, MAX_TEXT) : null,
        truncated: text.length > MAX_TEXT,
      }
    }
    const out = stripInvisible(record)

    if (opts.format === "plain") {
      const lines = [
        String(out.title),
        `${out.repo} · ★${out.repo_stars ?? "?"}${out.labels ? ` · ${(out.labels as string[]).join(", ") || "no labels"}` : ""}`,
        out.repo_description ? `Repo: ${out.repo_description}` : "",
        out.posted_date ? `Opened ${out.posted_date} by ${out.author ?? "?"} · updated ${out.updated_date ?? "?"} · ${out.state}` : "",
        Array.isArray(out.hiring_excerpt) && out.hiring_excerpt.length ? `Hiring mentions:\n${(out.hiring_excerpt as string[]).map((p) => `  ${p}`).join("\n")}` : "",
      ].filter(Boolean)
      process.stdout.write([lines.join("\n"), String(out.description ?? "(no text)"), `URL: ${out.url}`].join("\n\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    const code = e instanceof CliError && e.code !== "HTTP_ERROR" ? e.code : "DETAIL_FAILED"
    writeError(redact(e instanceof Error ? e.message : String(e)), code)
    return 1
  }
}
