// Read-only view of job_scraper/seen_jobs.json. Writes go through tools/scrape_state.py
// (and tools/rank_state.py for ranking) - the wrapper never edits this file itself.

import { readJson } from "../lib/store.ts"

export interface SeenJob {
  key: string
  title: string
  company: string
  url: string
  location?: string
  first_seen?: string
  posted_date?: string | null
  deadline?: string | null
  fit?: string
  status?: string
  portal?: string
  source?: string
  rank_score?: number
  rank_verdict?: string
  rank_date?: string
  strengths?: string[]
  gaps?: string[]
  [k: string]: unknown
}

export function readSeen(file: string): SeenJob[] {
  const doc = readJson<{ seen?: Record<string, Omit<SeenJob, "key">> }>(file, { seen: {} })
  const seen = doc && typeof doc === "object" && doc.seen && typeof doc.seen === "object" ? doc.seen : {}
  return Object.entries(seen)
    .filter(([, v]) => v && typeof v === "object")
    .map(([key, v]) => ({ ...(v as Omit<SeenJob, "key">), key }) as SeenJob)
}

/** Ranked jobs worth showing first: highest rank_score, then newest. */
export function shortlist(jobs: SeenJob[], n = 5): SeenJob[] {
  return jobs
    .filter((j) => j.status === "ranked" && typeof j.rank_score === "number")
    .sort((a, b) => (b.rank_score! - a.rank_score!) || String(b.first_seen ?? "").localeCompare(String(a.first_seen ?? "")))
    .slice(0, n)
}
