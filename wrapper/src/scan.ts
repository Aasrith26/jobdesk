// Zero-model scan (INC-1, LEAD-2..5): every enabled portal/source CLI -> upstream
// scrape_state.py candidates -> detail -> posting_guard -> safety flags -> scrape_state.py store.
// No Claude calls, so it costs nothing and works without a Claude login.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Paths } from "./lib/paths.ts"
import { bunRun, portalCli, python } from "./lib/exec.ts"
import { guard } from "./lib/guard.ts"
import { detectScam } from "./safety/scam.ts"
import { detectDiscrimination } from "./safety/discrimination.ts"
import { publishedContactRoutes, upsertLead } from "./data/leads.ts"
import { addItem } from "./data/attention.ts"
import type { Config } from "./data/config.ts"
import { today } from "./lib/store.ts"

export interface Portal {
  name: string
  cli: string
  enabled: boolean
}

/**
 * Upstream portal skills (.agents/skills) plus jobdesk-only lead sources (wrapper/sources).
 * Lead sources that aren't job boards live in wrapper/sources so upstream /apply never
 * treats their hosts (e.g. github.com) as installed job boards.
 */
export function discoverPortals(root: string): Portal[] {
  const dirs = [join(root, ".agents", "skills"), join(root, "wrapper", "sources")].filter(existsSync)
  return dirs.flatMap((dir) => readdirSync(dir).map((name) => ({ dir, name })))
    .map(({ dir, name }) => {
      const skill = join(dir, name, "SKILL.md")
      const cliPath = join(dir, name, "cli", "src", "cli.ts")
      const cli = existsSync(cliPath) ? cliPath : portalCli(root, name)
      if (!existsSync(skill) || !cli) return null
      const fm = readFileSync(skill, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ""
      const enabled = !/^enabled:\s*false\b/m.test(fm)
      return { name, cli, enabled }
    })
    .filter((p): p is Portal => p !== null)
}

export interface RawJob {
  title: string
  company: string
  url: string
  location?: string
  posted_date?: string | null
  deadline?: string | null
  kind?: string
  lead_type?: string
  [k: string]: unknown
}

export function parseResults(stdout: string): RawJob[] {
  const t = stdout.trim()
  if (!t) return []
  let data: unknown
  try {
    data = JSON.parse(t)
  } catch {
    const s = t.indexOf("[")
    const e = t.lastIndexOf("]")
    if (s < 0 || e <= s) return []
    try {
      data = JSON.parse(t.slice(s, e + 1))
    } catch {
      return []
    }
  }
  const arr = Array.isArray(data) ? data : (data as { results?: unknown[]; jobs?: unknown[] })?.results ?? (data as { jobs?: unknown[] })?.jobs ?? []
  return (arr as RawJob[]).filter((j) => j && typeof j.title === "string" && typeof j.company === "string" && typeof j.url === "string" && /^https?:\/\//.test(j.url))
}

/** Funding-news and similar items are leads to approach, not job postings. */
export function isNews(j: { lead_type?: unknown; portal?: unknown }): boolean {
  return j.lead_type === "funded_startup" || j.portal === "funding-news-search"
}

/**
 * Keyword fit without a model: overlap between the posting and the candidate's own terms.
 * A posting whose title contains one of the user's searched roles counts three extra hits.
 */
export function heuristicFit(text: string, terms: string[], title = "", queries: string[] = []): "high" | "medium" | "low" {
  const lower = text.toLowerCase()
  const titleHit = queries.some((q) => q.trim().length > 2 && title.toLowerCase().includes(q.trim().toLowerCase()))
  // Whole-word match, so "C" or "Go" don't hit inside other words.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const hits = new Set(
    terms
      .map((t) => t.toLowerCase().trim())
      .filter((t) => t.length > 1 && new RegExp(`(^|[^a-z0-9+#])${esc(t)}($|[^a-z0-9+#])`).test(lower)),
  )
  const score = hits.size + (titleHit ? 3 : 0)
  return score >= 6 ? "high" : score >= 3 ? "medium" : "low"
}

export function profileTerms(profilePath: string, cfg: Config): string[] {
  const terms = new Set<string>()
  for (const q of cfg.queries) for (const w of q.split(/[,/]/)) if (w.trim()) terms.add(w.trim())
  if (existsSync(profilePath)) {
    const text = readFileSync(profilePath, "utf8")
    const skills = text.match(/\n##\s*(Technical )?Skills[\s\S]*?(?=\n##\s|$)/i)?.[0] ?? ""
    // "Skills: a, b, c" lines anywhere (e.g. an imported resume) count too.
    const skillLines = text.split(/\r?\n/).filter((l) => /\bskills?\b[^:]{0,20}:/i.test(l)).map((l) => "- " + l.replace(/^.*?:\s*/, ""))
    for (const line of [...skills.split(/\r?\n/), ...skillLines]) {
      if (!/^\s*-/.test(line)) continue
      const body = line.replace(/^\s*-\s*/, "").replace(/\*\*[^*]+:\*\*/, "").replace(/\*\*/g, "")
      for (const part of body.split(/[,;()/]|\band\b/)) {
        const t = part.trim().replace(/\.$/, "")
        if (t.length >= 2 && t.length <= 30 && /[A-Za-z]/.test(t)) terms.add(t)
      }
    }
  }
  return [...terms].filter((t) => !/\[YOUR/i.test(t))
}

const isoDate = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

export interface ScanOpts {
  portals?: string[]
  queries?: string[]
  perPortal?: number
  log?: (s: string) => void
}

export interface ScanSummary {
  portals: { name: string; status: "ok" | "failed" | "skipped"; found: number; added: number; error?: string }[]
  added: string[]
  flagged: string[]
}

export async function scan(p: Paths, cfg: Config, o: ScanOpts = {}): Promise<ScanSummary> {
  const log = o.log ?? (() => {})
  const queries = o.queries?.length ? o.queries : cfg.queries
  if (!queries.length) throw new Error("No search terms yet. Run: jobdesk config queries \"AI Engineer, LLM Engineer\"")
  const all = discoverPortals(p.root)
  const chosen = all.filter((x) => (o.portals?.length ? o.portals.includes(x.name) : x.enabled))
  const terms = profileTerms(p.profile, cfg)
  const summary: ScanSummary = { portals: [], added: [], flagged: [] }
  const tmp = mkdtempSync(join(tmpdir(), "jobdesk-scan-"))
  try {
    for (const portal of all.filter((x) => !chosen.includes(x))) summary.portals.push({ name: portal.name, status: "skipped", found: 0, added: 0 })
    // One failing source never stops the others (reliability NFR).
    for (const portal of chosen) {
      try {
        const found: RawJob[] = []
        // Sources that take a location (LinkedIn requires one) get each saved location, up to two.
        const src = readFileSync(portal.cli, "utf8")
        const takesLocation = /["'-]-location\b|location:\s*["']/.test(src) || /\blocation\b/.test(src.match(/KNOWN_FLAGS[\s\S]{0,400}/)?.[0] ?? "")
        const locs = takesLocation && cfg.locations.length ? cfg.locations.filter((l) => !/^remote$/i.test(l)).slice(0, 2) : []
        const variants: string[][] = locs.length ? locs.map((l) => ["-l", l]) : [[]]
        for (const q of queries) {
          for (const extra of variants) {
            const r = await bunRun(p.root, portal.cli, ["search", "-q", q, ...extra, "--format", "json"], 90_000)
            if (r.code !== 0) {
              const msg = (r.stderr.match(/"(?:message|error)"\s*:\s*"([^"]+)"/)?.[1] ?? r.stderr.trim()).slice(0, 200)
              throw new Error(msg || `exit ${r.code}`)
            }
            found.push(...parseResults(r.stdout))
          }
        }
        log(`${portal.name}: ${found.length} results`)
        const resFile = join(tmp, `${portal.name}-raw.json`)
        writeFileSync(resFile, JSON.stringify(found), "utf8")
        const cand = await python(p.root, "scrape_state.py", ["candidates", "--results", resFile])
        if (cand.code !== 0) throw new Error(cand.stderr.trim())
        const selected = (JSON.parse(cand.stdout).selected as RawJob[]).slice(0, o.perPortal ?? 10)
        const enriched: (RawJob & Record<string, unknown>)[] = []
        const meta: { job: RawJob; text: string; verdict: string; findings: unknown; scam: ReturnType<typeof detectScam>; disc: ReturnType<typeof detectDiscrimination> }[] = []
        for (const job of selected) {
          const d = await bunRun(p.root, portal.cli, ["detail", job.url, "--format", "plain"], 90_000)
          const raw = d.code === 0 ? d.stdout : `${job.title}\n${job.company}\n${job.location ?? ""}`
          const g = await guard(p.root, raw, "text")
          const scam = detectScam(g.text)
          const disc = detectDiscrimination(g.text)
          enriched.push({
            ...job,
            first_seen: today(),
            posted_date: isoDate(job.posted_date),
            deadline: isoDate(job.deadline),
            fit: heuristicFit(`${job.title}\n${g.text}`, terms, job.title, queries),
            status: "new",
            portal: portal.name,
            source: "cli",
          })
          meta.push({ job, text: g.text, verdict: g.verdict, findings: g.findings, scam, disc })
        }
        let added: string[] = []
        if (enriched.length) {
          const f = join(tmp, `${portal.name}-store.json`)
          writeFileSync(f, JSON.stringify(enriched), "utf8")
          const st = await python(p.root, "scrape_state.py", ["store", "--results", f])
          if (st.code !== 0) throw new Error(st.stderr.trim())
          added = JSON.parse(st.stdout).added as string[]
        }
        // store keeps input order for the jobs it selected; map keys back to metadata by recomputing keys.
        for (const m of meta) {
          const k = await python(p.root, "job_key.py", ["--company", m.job.company, "--title", m.job.title, "--url", m.job.url])
          const key = k.stdout.trim().split(/\r?\n/).at(-1) ?? ""
          if (!key || !added.includes(key)) continue
          upsertLead(p.leads, {
            key,
            url: m.job.url,
            title: m.job.title,
            company: m.job.company,
            portal: portal.name,
            kind: m.job.kind === "lead" ? "lead" : "job",
            lead_type: m.job.lead_type,
            fetch_method: `${portal.name} cli`,
            guard_verdict: m.verdict,
            guard_findings: m.findings,
            // News articles (funding announcements) aren't job postings: job-scam rules don't apply.
            flags: isNews(m.job) ? { scam: [], discrimination: [] } : { scam: m.scam.flags.map((f) => f.reason), discrimination: m.disc.flags.map((f) => f.reason) },
            contact_routes: m.job.kind === "lead" ? publishedContactRoutes(m.text) : [],
            text_excerpt: m.text.slice(0, 1200),
          })
          if (!isNews(m.job) && (m.scam.flagged || m.disc.flagged || m.verdict.includes("⚠"))) {
            summary.flagged.push(key)
            addItem(p.attention, {
              id: `flag:${key}`,
              kind: "flagged_posting",
              title: `${m.job.company}: ${m.job.title}`,
              why: [...m.scam.flags.map((f) => f.reason), ...m.disc.flags.map((f) => f.reason), m.verdict.includes("⚠") ? m.verdict : ""].filter(Boolean).join(" "),
              action: "Read the warning before spending time on this posting.",
              ref: key,
              data: { url: m.job.url },
            })
          }
        }
        summary.added.push(...added)
        summary.portals.push({ name: portal.name, status: "ok", found: found.length, added: added.length })
      } catch (e) {
        const msg = (e as Error).message
        if (/NO_CHANNELS|not configured|no channels/i.test(msg)) {
          summary.portals.push({ name: portal.name, status: "skipped", found: 0, added: 0, error: "not set up yet" })
          continue
        }
        summary.portals.push({ name: portal.name, status: "failed", found: 0, added: 0, error: msg })
        log(`${portal.name}: failed - ${(e as Error).message}`)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return summary
}
