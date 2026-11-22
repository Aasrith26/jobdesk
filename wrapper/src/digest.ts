// The morning digest (MSG-6) and status summary: short sentences, plain words (INC-5).

import type { Paths } from "./lib/paths.ts"
import { readSeen, shortlist } from "./data/seen.ts"
import { openItems } from "./data/attention.ts"
import { dueFollowUps } from "./followups.ts"
import { readTracker, bucketOf } from "./data/tracker.ts"
import { budgetLeft } from "./lib/claude.ts"
import type { Config } from "./data/config.ts"
import { readLeads } from "./data/leads.ts"
import { freshPicks, type Pick } from "./recommend.ts"
import { unscored } from "./rank.ts"

export interface DigestJob {
  key: string
  title: string
  company: string
  url: string
  score?: number
  flagged: boolean
}

export interface JobsQuery {
  /** Keys the user skipped. */
  skip?: Set<string>
  /** Only jobs found on or after this date (YYYY-MM-DD) - "new" means new. */
  since?: string
  /** Include funding news / company leads (not postings). Default false. */
  includeNews?: boolean
}

export function digestJobs(p: Paths, n = 5, q: JobsQuery = {}): DigestJob[] {
  const leads = readLeads(p.leads)
  // Hide jobs already submitted; drafted ones still need applying, so they stay.
  const applied = new Set(readTracker(p.tracker).rows.filter((r) => r.status.trim() && r.status.trim() !== "drafted").map((r) => r.source.replace(/\/+$/, "")))
  const seen = readSeen(p.seen).filter((j) =>
    !q.skip?.has(j.key) &&
    !applied.has(j.url.replace(/\/+$/, "")) &&
    j.status !== "skipped" && j.status !== "expired" &&
    (q.includeNews || !(j.portal === "funding-news-search" || leads[j.key]?.lead_type === "funded_startup")) &&
    (!q.since || String(j.first_seen ?? "") >= q.since))
  let top = q.since ? [] : shortlist(seen, n)
  if (top.length < n) {
    const fresh = seen
      .filter((j) => (q.since ? true : j.status === "new") && !top.includes(j))
      .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.fit ?? "low"] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.fit ?? "low"] ?? 3) || String(b.first_seen).localeCompare(String(a.first_seen)))
    top = [...top, ...fresh.slice(0, n - top.length)]
  }
  return top.map((j) => {
    const l = leads[j.key]
    return { key: j.key, title: j.title, company: j.company, url: j.url, score: j.rank_score, flagged: !!(l && (l.flags.scam.length || l.flags.discrimination.length)) }
  })
}

/** The morning update: only jobs that fit and that they haven't been shown yet. */
export function composeDigest(p: Paths, cfg: Config): { text: string; jobs: Pick[] } {
  const jobs = freshPicks(p, cfg, { n: 5 }).picks
  const att = openItems(p.attention)
  const fu = dueFollowUps(p.tracker, cfg)
  const rows = readTracker(p.tracker).rows
  const active = rows.filter((r) => ["Active", "Interview", "Offer"].includes(bucketOf(r.status).bucket)).length
  const lines: string[] = ["Good morning. Here is your job update."]
  lines.push("")
  if (jobs.length) {
    lines.push(jobs.length === 1 ? "One new job that fits you:" : `${jobs.length} new jobs that fit you:`)
    jobs.forEach((j, i) => lines.push(`${i + 1}. ${j.title} at ${j.company}${j.score !== undefined ? ` (fit ${j.score})` : ""}${j.reason ? ` - ${j.reason}` : ""}`))
  } else {
    const waiting = unscored(p).length
    lines.push(waiting ? `Nothing new that fits yet. ${waiting} new job${waiting === 1 ? " isn't" : "s aren't"} scored yet.` : "Nothing new that fits you today.")
  }
  lines.push("")
  lines.push(att.length ? `${att.length} thing${att.length === 1 ? "" : "s"} need${att.length === 1 ? "s" : ""} you. Send /attention to see them.` : "Nothing needs you right now.")
  if (fu.length) lines.push(`${fu.length} application${fu.length === 1 ? " has" : "s have"} gone quiet. A short follow-up can help.`)
  lines.push(`Open applications: ${active}.`)
  if (cfg.tier) lines.push(`Budget left this month: $${budgetLeft(p.costs, cfg).toFixed(2)}.`)
  return { text: lines.join("\n"), jobs }
}
