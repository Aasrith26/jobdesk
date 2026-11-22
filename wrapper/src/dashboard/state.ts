// Everything the dashboard shows, computed from the files on disk (DSH-1, DSH-4).

import type { Paths } from "../lib/paths.ts"
import { readTracker, bucketOf, canonicalStatus, followUpsSent, type Bucket } from "../data/tracker.ts"
import { readSeen } from "../data/seen.ts"
import { readArchives } from "../data/outcomes.ts"
import { readLeads } from "../data/leads.ts"
import { openItems } from "../data/attention.ts"
import { budgetLeft, monthSpend } from "../lib/claude.ts"
import { readConfig } from "../data/config.ts"
import { existsSync } from "node:fs"
import { readScores } from "../data/scores.ts"
import { readShown } from "../data/recommended.ts"
import { freshPicks, scoreOf } from "../recommend.ts"
import { unscored, rankEstimate } from "../rank.ts"
import { join } from "node:path"
import { readApps, isPreparing } from "../apply.ts"
import { readReview } from "../review.ts"
import { visibleTasks } from "../tasks.ts"
import { jobUrlKey } from "../lib/joburl.ts"

const BUCKETS: Bucket[] = ["Drafted", "Active", "Interview", "Offer", "Hired", "Rejected/Closed"]
const REPLIED = new Set(["interview", "offer", "hired", "rejected", "offer_declined"])

export function computeState(p: Paths) {
  const cfg = readConfig(p.config)
  const tracker = readTracker(p.tracker)
  const seen = readSeen(p.seen)
  const leads = readLeads(p.leads)
  const archives = readArchives(p.applications)
  const byUrl = new Map(seen.map((s) => [jobUrlKey(s.url), s]))
  const unknown = new Set<string>()
  const applications = tracker.rows.map((r) => {
    const b = bucketOf(r.status)
    if (b.unknown && r.status.trim()) unknown.add(r.status)
    const s = byUrl.get(jobUrlKey(r.source))
    const pdf = (tex: string) => (tex ? tex.replace(/\.tex$/i, ".pdf") : "")
    return {
      date: r.date, company: r.company, role: r.role, sector: r.sector, channel: r.channel, status: canonicalStatus(r.status),
      bucket: b.bucket, fit: r.fit_rating, notes: r.notes, source: r.source, deadline: r.deadline, contact: r.contact_person,
      followups: followUpsSent(r.notes), portal: s?.portal ?? (r.channel || "unknown"),
      cv: pdf(r.cv_file), cv_exists: !!r.cv_file && existsSync(join(p.root, pdf(r.cv_file))),
      cover: pdf(r.cover_letter_file), cover_exists: !!r.cover_letter_file && existsSync(join(p.root, pdf(r.cover_letter_file))),
      cv_variant: r.cv_file,
    }
  })
  const submitted = applications.filter((a) => a.bucket !== "Drafted")
  const group = (key: (a: (typeof applications)[number]) => string) => {
    const m = new Map<string, { n: number; replied: number }>()
    for (const a of submitted) {
      const k = key(a) || "unknown"
      const g = m.get(k) ?? { n: 0, replied: 0 }
      g.n++
      if (REPLIED.has(a.status)) g.replied++
      m.set(k, g)
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, applications: v.n, replies: v.replied, rate: v.n ? v.replied / v.n : 0, enough: v.n >= 5 }))
  }
  const bucketCounts = Object.fromEntries(BUCKETS.map((b) => [b, applications.filter((a) => a.bucket === b).length]))
  const seenByStatus: Record<string, number> = {}
  const seenByPortal: Record<string, number> = {}
  for (const s of seen) {
    seenByStatus[s.status ?? "unknown"] = (seenByStatus[s.status ?? "unknown"] ?? 0) + 1
    seenByPortal[s.portal ?? "unknown"] = (seenByPortal[s.portal ?? "unknown"] ?? 0) + 1
  }
  const quick = readScores(p.scores)
  const shown = readShown(p.recommended)
  const fresh = new Set(freshPicks(p, cfg).picks.map((j) => j.key))
  const jobs = seen
    .map((s) => {
      const l = leads[s.key]
      const q = quick[s.key]
      const sc = scoreOf(s, q)
      const sh = shown[s.key]
      return {
        key: s.key, title: s.title, company: s.company, url: s.url, location: s.location ?? "", portal: s.portal ?? "", status: s.status ?? "",
        fit: s.fit ?? "", score: sc?.score ?? (q ? q.score : null), method: sc?.method ?? (q ? "quick" : "keywords"), verdict: sc?.verdict ?? q?.verdict ?? "",
        reason: sc?.reason ?? q?.reason ?? "", ruled_out: q?.dealbreaker ? `Deal-breaker: ${q.dealbreaker}` : q?.location === "FAIL" || s.location_verdict === "FAIL" ? "Outside your places" : "",
        first_seen: s.first_seen ?? "", fresh: fresh.has(s.key), shown: sh?.first_shown?.slice(0, 10) ?? "", reaction: sh?.reaction ?? "",
        kind: l?.kind ?? "job", flags: l ? [...l.flags.scam, ...l.flags.discrimination] : [], guard: l?.guard_verdict ?? "",
        strengths: sc?.strengths ?? s.strengths ?? [], gaps: sc?.gaps ?? (s.gaps as string[] | undefined) ?? [],
      }
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.first_seen.localeCompare(a.first_seen))
  return {
    generated: new Date().toISOString(),
    applications,
    buckets: bucketCounts,
    unknownStatuses: [...unknown],
    totals: { applications: submitted.length, drafted: bucketCounts.Drafted, scraped: seen.length },
    replyRateBySource: group((a) => a.portal),
    replyRateByChannel: group((a) => a.channel),
    replyRateByCv: group((a) => a.cv_variant),
    seenByStatus,
    seenByPortal,
    jobs,
    attention: openItems(p.attention),
    archives: archives.map((a) => ({ folder: a.folder, status: a.status ?? "", stages: a.stages })),
    cost: { spent: monthSpend(p.costs), left: budgetLeft(p.costs, cfg), budget: cfg.monthly_budget_usd, tier: cfg.tier },
    config: { approval_level: cfg.approval_level, daily_application_cap: cfg.daily_application_cap, min_fit: cfg.min_fit },
    scoring: (() => {
      const n = unscored(p).length
      return { unscored: n, estimate: rankEstimate(n) }
    })(),
    /** Applications jobdesk is preparing or has prepared, newest first, with whether a review is ready. */
    /** Background work (scoring, searching, profile drafts): running, or finished in the last 15 minutes. */
    tasks: visibleTasks(p),
    preparing: Object.values(readApps(p))
      .map((a) => ({ ...a, running: isPreparing(a.key), review: !!readReview(p, a.key) }))
      .sort((a, b) => b.updated.localeCompare(a.updated)),
  }
}

export type DashboardState = ReturnType<typeof computeState>
