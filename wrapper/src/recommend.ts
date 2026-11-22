// What to put in front of the user (the "only new, only what fits" rule). One place decides it, so
// the bot, the digest, the daily search and the dashboard never disagree:
//   - never a job they were already shown (unless they ask for everything)
//   - never one they skipped, applied to, or that has a warning on it
//   - never news items or a job that fails their location or a deal-breaker
//   - only a fit score at or above their minimum; the full /rank score wins over a quick score

import type { Paths } from "./lib/paths.ts"
import type { Config } from "./data/config.ts"
import { readSeen, type SeenJob } from "./data/seen.ts"
import { readLeads } from "./data/leads.ts"
import { readTracker } from "./data/tracker.ts"
import { readScores, type QuickScore } from "./data/scores.ts"
import { readShown, type Shown } from "./data/recommended.ts"

export type ScoreMethod = "full" | "quick" | "keywords"

export interface Pick {
  key: string
  title: string
  company: string
  url: string
  location: string
  portal: string
  first_seen: string
  /** Undefined for a keyword-only match that hasn't been scored yet. */
  score?: number
  verdict?: string
  method: ScoreMethod
  reason?: string
  strengths: string[]
  gaps: string[]
}

import { jobUrlKey, companyRoleKey } from "./lib/joburl.ts"

export function isNewsItem(j: SeenJob, leadType?: string): boolean {
  return j.portal === "funding-news-search" || leadType === "funded_startup"
}

/**
 * Jobs that could ever be recommended: still open, not tracked yet (applied or drafted), not news,
 * no scam or discrimination warning. Shown/skipped is decided by the caller.
 */
export function candidatePool(p: Paths): SeenJob[] {
  const leads = readLeads(p.leads)
  const rows = readTracker(p.tracker).rows
  const tracked = new Set([...rows.filter((r) => r.source).map((r) => jobUrlKey(r.source)), ...rows.map((r) => companyRoleKey(r.company, r.role))])
  return readSeen(p.seen).filter((j) => {
    const l = leads[j.key]
    if (j.status === "skipped" || j.status === "expired") return false
    if (tracked.has(jobUrlKey(j.url)) || tracked.has(companyRoleKey(j.company, j.title))) return false
    if (isNewsItem(j, l?.lead_type)) return false
    if (l && (l.flags.scam.length || l.flags.discrimination.length)) return false
    return true
  })
}

/** The score that counts for one job: the full /rank one, else the quick one, else nothing. */
export function scoreOf(j: SeenJob, quick: QuickScore | undefined): Pick | null {
  const base = { key: j.key, title: j.title, company: j.company, url: j.url, location: j.location ?? "", portal: j.portal ?? "", first_seen: String(j.first_seen ?? "") }
  if (j.status === "ranked" && typeof j.rank_score === "number") {
    if (j.location_verdict === "FAIL" || j.language_gate === "FAIL") return null
    const strengths = (j.strengths ?? []).map(String)
    return { ...base, score: j.rank_score, verdict: j.rank_verdict, method: "full", reason: strengths[0], strengths, gaps: ((j.gaps as string[] | undefined) ?? []).map(String) }
  }
  if (quick) {
    if (quick.location === "FAIL" || quick.dealbreaker) return null
    return { ...base, score: quick.score, verdict: quick.verdict, method: "quick", reason: quick.reason, strengths: quick.strengths, gaps: quick.gaps }
  }
  return { ...base, method: "keywords", strengths: [], gaps: [] }
}

export interface PickQuery {
  n?: number
  /** Include jobs already shown (still never skipped ones). */
  includeShown?: boolean
  /** Only these keys (e.g. what today's search added). */
  only?: Set<string>
  /** Free-text filter on title, company and location. */
  filter?: RegExp
  /** Leave these out (e.g. what this search's model check flagged). */
  exclude?: Set<string>
}

export interface PickResult {
  picks: Pick[]
  /** In the pool, not shown yet, no score, and not a strong keyword match (so not listed). */
  unscored: number
  /** Scored, not shown yet, but below the minimum fit. */
  below: number
  /** How many fitting jobs were left out because they were already shown. */
  alreadyShown: number
}

export function freshPicks(p: Paths, cfg: Config, q: PickQuery = {}): PickResult {
  const quick = readScores(p.scores)
  const shown: Record<string, Shown> = readShown(p.recommended)
  let unscored = 0
  let below = 0
  let alreadyShown = 0
  const scored: Pick[] = []
  const keywordOnly: Pick[] = []
  for (const j of candidatePool(p)) {
    if (q.only && !q.only.has(j.key)) continue
    if (q.exclude?.has(j.key)) continue
    const s = shown[j.key]
    if (s?.reaction) continue
    if (q.filter && !q.filter.test(`${j.title} ${j.company} ${j.location ?? ""} ${j.remote === true ? "remote" : ""}`)) continue
    const pick = scoreOf(j, quick[j.key])
    if (!pick) continue
    // A keyword match is only a stand-in for a score when scoring is switched off (no AI budget).
    // With scoring on, an unscored job waits for its score: keywords alone let "Principal" and
    // "Staff" roles through for someone with one year of experience.
    const fits = pick.score !== undefined ? pick.score >= cfg.min_fit : !cfg.auto_rank && j.fit === "high"
    if (s && !q.includeShown) {
      if (fits) alreadyShown++
      continue
    }
    if (pick.score === undefined) {
      if (fits) keywordOnly.push(pick)
      else unscored++
      continue
    }
    if (!fits) {
      below++
      continue
    }
    scored.push(pick)
  }
  scored.sort((a, b) => b.score! - a.score! || b.first_seen.localeCompare(a.first_seen))
  keywordOnly.sort((a, b) => b.first_seen.localeCompare(a.first_seen))
  const all = [...scored, ...keywordOnly]
  return { picks: q.n ? all.slice(0, q.n) : all, unscored, below, alreadyShown }
}

/** One short line per pick, for chat. */
export function pickLine(j: Pick, i: number): string {
  const fit = j.score !== undefined ? `fit ${j.score}` : "strong keyword match, not scored yet"
  return `${i + 1}. ${j.title} at ${j.company}${j.location ? `, ${j.location}` : ""} (${fit})${j.reason ? `\n   ${j.reason}` : ""}\n   ${j.url}`
}
