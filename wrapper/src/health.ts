// What's stopping jobdesk from working, in the user's words, with the command that fixes it.
// Shown at the top of every dashboard page, never hidden behind a button: if PDFs can't be made,
// the user has to know before they try to apply, not after.

import type { Paths } from "./lib/paths.ts"
import type { Config } from "./data/config.ts"
import { doctor, type Check } from "./doctor.ts"
import { budgetLeft } from "./lib/claude.ts"

export interface Issue {
  id: string
  /** "blocking": a main feature can't work. "important": applying is incomplete. "optional": one extra feature. */
  level: "blocking" | "important" | "optional"
  title: string
  /** What doesn't work because of it. */
  impact: string
  /** The command to run, when there is one. */
  fix?: string
  /** Or what to do, when it isn't a command. */
  action?: string
}

/** What each missing piece breaks, by doctor check name. */
const FROM_CHECK: Record<string, Omit<Issue, "id" | "fix">> = {
  Python: { level: "blocking", title: "Python 3.10 or newer is missing", impact: "Searching for jobs and reading PDF resumes don't work." },
  "Claude Code": { level: "blocking", title: "Claude Code isn't installed", impact: "Scoring jobs, the assistant, drafting your profile and writing CVs don't work. Searching and tracking still do." },
  "LaTeX (to make PDFs)": { level: "important", title: "PDFs can't be made", impact: "Your CV and cover letter are written as .tex files, but job sites need PDFs. Install LaTeX before you apply." },
  "pypdf (reads PDF resumes)": { level: "important", title: "PDF resumes can't be read", impact: "Uploading a PDF resume won't work until this is installed. Word and text files still do." },
  "Chrome or Edge (for form filling)": { level: "optional", title: "No Chrome or Edge found", impact: "Filling application forms for you won't work. The kit and one tap still do." },
}

export function issuesFromChecks(checks: Check[]): Issue[] {
  return checks
    .filter((c) => !c.ok && FROM_CHECK[c.name])
    .map((c) => ({ id: `check:${c.name}`, ...FROM_CHECK[c.name], fix: c.fix }))
}

/** Things that can go wrong while running, not at install time. */
export function runtimeIssues(p: Paths, cfg: Config, o: { botError?: string } = {}): Issue[] {
  const out: Issue[] = []
  if (cfg.monthly_budget_usd !== null && budgetLeft(p.costs, cfg) <= 0) {
    out.push({ id: "budget", level: "blocking", title: "Your spending limit is reached", impact: `Paid features (scoring, the assistant, writing CVs) are paused until next month. The limit is $${cfg.monthly_budget_usd}.`, action: "Raise it or remove it in Settings > Spending limit." })
  }
  if (o.botError) out.push({ id: "bot", level: "important", title: "The Telegram bot isn't working", impact: o.botError, action: "Paste a new token in Settings > Phone." })
  return out
}

const ORDER = { blocking: 0, important: 1, optional: 2 }

/** Checks what's installed (a few seconds), so callers cache it and refresh now and then. */
export async function installIssues(): Promise<Issue[]> {
  return issuesFromChecks(await doctor())
}

export function sortIssues(list: Issue[]): Issue[] {
  return [...list].sort((a, b) => ORDER[a.level] - ORDER[b.level])
}
