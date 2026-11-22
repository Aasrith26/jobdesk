// Locates the host ai-job-search checkout and the wrapper's own data directory.
// The wrapper never assumes it lives inside the host repo: JOBDESK_ROOT overrides
// discovery, so the same code works after being lifted into its own repo (D4).

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

function isHostRoot(dir: string): boolean {
  return existsSync(join(dir, "tools", "scrape_state.py")) && existsSync(join(dir, ".claude"))
}

export function findRoot(start: string = process.cwd()): string {
  const env = process.env.JOBDESK_ROOT
  if (env) {
    const r = resolve(env)
    if (!isHostRoot(r)) throw new Error(`JOBDESK_ROOT=${r} is not an ai-job-search checkout (no tools/scrape_state.py)`)
    return r
  }
  let dir = resolve(start)
  for (;;) {
    if (isHostRoot(dir)) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  // Fall back to the checkout this file sits in (wrapper/src/lib -> repo root).
  const here = resolve(import.meta.dir, "..", "..", "..")
  if (isHostRoot(here)) return here
  throw new Error("Could not find the ai-job-search folder. Run jobdesk from inside it, or set JOBDESK_ROOT.")
}

export interface Paths {
  root: string
  tracker: string
  seen: string
  applications: string
  profile: string
  skills: string
  tools: string
  data: string
  leads: string
  attention: string
  answers: string
  config: string
  costs: string
  kits: string
  reviews: string
  evidence: string
  inbox: string
  runs: string
  /** Quick fit scores jobdesk made itself (upstream /rank scores stay in seen_jobs.json). */
  scores: string
  /** Every job the user has been shown, and what they did with it. */
  recommended: string
  /** Held by the one running `jobdesk start` (or `bridge`), so two copies never fight over the bot. */
  lock: string
  profileBackups: string
}

export function paths(root: string = findRoot()): Paths {
  const data = process.env.JOBDESK_DATA ? resolve(process.env.JOBDESK_DATA) : join(root, "wrapper-data")
  return {
    root,
    tracker: join(root, "job_search_tracker.csv"),
    seen: join(root, "job_scraper", "seen_jobs.json"),
    applications: join(root, "documents", "applications"),
    profile: join(root, ".claude", "skills", "job-application-assistant", "01-candidate-profile.md"),
    skills: join(root, ".agents", "skills"),
    tools: join(root, "tools"),
    data,
    leads: join(data, "leads.json"),
    attention: join(data, "attention.json"),
    answers: join(data, "answer_bank.json"),
    config: join(data, "config.json"),
    costs: join(data, "costs.jsonl"),
    kits: join(data, "kits"),
    reviews: join(data, "reviews"),
    evidence: join(data, "evidence"),
    inbox: join(data, "inbox"),
    runs: join(data, "runs"),
    scores: join(data, "scores.json"),
    recommended: join(data, "recommended.json"),
    lock: join(data, "jobdesk.lock"),
    profileBackups: join(data, "profile-backups"),
  }
}

/** Create wrapper-data/ with a self-ignoring .gitignore so the host .gitignore is never edited (C-1). */
export function ensureDataDir(p: Paths): void {
  for (const d of [p.data, p.kits, p.reviews, p.evidence, p.inbox, p.runs]) mkdirSync(d, { recursive: true })
  const gi = join(p.data, ".gitignore")
  if (!existsSync(gi)) writeFileSync(gi, "# Personal data written by jobdesk - never commit.\n*\n")
}
