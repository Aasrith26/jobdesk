// Runs Claude Code headless under the user's own login (D2), with a restricted tool
// allowlist, a per-run budget, the tier's model, and every run's cost written to the
// cost ledger (INC-3). When the monthly budget is used up, model calls stop and the
// caller falls back to the zero-model tier.

import { appendJsonl, readJsonl, nowIso } from "./store.ts"
import { run, claudeBin, pathWithPython } from "./exec.ts"
import { modelFor, type Config } from "../data/config.ts"

export interface CostEntry {
  at: string
  task: string
  model: string
  usd: number
  ok: boolean
  note?: string
}

export function monthSpend(ledger: string, now: Date = new Date()): number {
  const ym = now.toISOString().slice(0, 7)
  return readJsonl<CostEntry>(ledger)
    .filter((e) => e.at.startsWith(ym))
    .reduce((s, e) => s + (Number.isFinite(e.usd) ? e.usd : 0), 0)
}

/** What's left of the user's monthly cap. No cap (null) means Infinity. */
export function budgetLeft(ledger: string, cfg: Config): number {
  if (cfg.monthly_budget_usd === null) return Infinity
  return Math.max(0, cfg.monthly_budget_usd - monthSpend(ledger))
}

/** One line for people: "$4.20 of $10 left this month" or "No spending limit. $4.20 spent this month." */
export function budgetText(ledger: string, cfg: Config): string {
  const spent = monthSpend(ledger)
  return cfg.monthly_budget_usd === null
    ? `No spending limit. $${spent.toFixed(2)} spent this month.`
    : `$${budgetLeft(ledger, cfg).toFixed(2)} of $${cfg.monthly_budget_usd} left this month.`
}

/** Rough per-task estimate shown before a run (INC-3); actuals come from Claude's own report. */
export const ESTIMATE_USD: Record<string, Record<string, number>> = {
  haiku: { rank: 0.02, evaluate: 0.05, draft: 0.15, chat: 0.01 },
  sonnet: { rank: 0.08, evaluate: 0.2, draft: 0.6, chat: 0.03 },
  opus: { rank: 0.3, evaluate: 0.8, draft: 2.5, chat: 0.1 },
}

export interface ClaudeRun {
  ok: boolean
  text: string
  usd: number
  model: string
  error?: string
  skipped?: "budget" | "no_claude"
}

export type ClaudeExec = (args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

/**
 * The prompt goes to Claude on stdin, not as an argument: Windows caps a command line at ~32k
 * characters, and a batch of postings is longer than that (ENAMETOOLONG, found on the live bot).
 * Callers and tests still see it as `-p <prompt>` in args; it's moved to stdin here.
 */
const defaultExec: ClaudeExec = (args, cwd, timeoutMs) => {
  const i = args.indexOf("-p")
  const prompt = i >= 0 ? args[i + 1] : ""
  const rest = i >= 0 ? [...args.slice(0, i), "-p", ...args.slice(i + 2)] : args
  return run(claudeBin(), rest, { cwd, timeoutMs, input: prompt, env: { PATH: pathWithPython() } })
}

export interface ClaudeOpts {
  root: string
  ledger: string
  cfg: Config
  task: "rank" | "draft" | "evaluate" | "chat"
  prompt: string
  allowedTools: string[]
  maxUsd?: number
  timeoutMs?: number
  exec?: ClaudeExec
  /** Extra flags placed before the tool list (e.g. --mcp-config for the agent's tools). */
  extraArgs?: string[]
}

export async function runClaude(o: ClaudeOpts): Promise<ClaudeRun> {
  const model = modelFor(o.cfg.tier, o.task)
  const left = budgetLeft(o.ledger, o.cfg)
  const est = ESTIMATE_USD[model]?.[o.task] ?? 0.5
  if (left <= 0 || left < est * 0.5) {
    return { ok: false, text: "", usd: 0, model, skipped: "budget", error: `Monthly budget reached ($${o.cfg.monthly_budget_usd}). Running free features only.` }
  }
  // Claude Code's own context (system prompt, tool definitions) has a fixed cost per run, so a cap
  // below ~$0.30 can stop even a one-line answer. The monthly budget still bounds it.
  const cap = Math.min(Math.max(o.maxUsd ?? est * 4, 0.3), left)
  const args = [
    "-p", o.prompt,
    "--output-format", "json",
    "--model", model,
    "--max-budget-usd", cap.toFixed(2),
    "--permission-mode", "default",
    "--no-session-persistence",
    ...(o.extraArgs ?? []),
    ...(o.allowedTools.length ? ["--allowedTools", ...o.allowedTools] : ["--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "Agent", "NotebookEdit"]),
  ]
  const exec = o.exec ?? defaultExec
  const r = await exec(args, o.root, o.timeoutMs ?? 20 * 60_000)
  if (r.code === 127) return { ok: false, text: "", usd: 0, model, skipped: "no_claude", error: "Claude Code is not installed or not on PATH." }
  let usd = 0
  let text = r.stdout
  let ok = r.code === 0
  try {
    const j = JSON.parse(r.stdout)
    usd = Number(j.total_cost_usd ?? j.cost_usd ?? 0) || 0
    text = String(j.result ?? "")
    ok = ok && !j.is_error
  } catch {
    /* non-JSON output: keep raw text */
  }
  appendJsonl(o.ledger, { at: nowIso(), task: o.task, model, usd, ok } satisfies CostEntry)
  return { ok, text, usd, model, error: ok ? undefined : (r.stderr.trim() || text).slice(0, 500) }
}

/** Tool allowlists per bridge task (MSG-3): no free shell, ever. */
export const TOOLS = {
  readOnly: ["Read", "Glob", "Grep"],
  evaluate: [
    "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent",
    "Bash(bun run .agents/skills/*/cli/src/cli.ts:*)",
    "Bash(python tools/posting_guard.py:*)", "Bash(python3 tools/posting_guard.py:*)",
    "Bash(python tools/fetch_page.py:*)", "Bash(python3 tools/fetch_page.py:*)",
    "Bash(python tools/robots_check.py:*)", "Bash(python3 tools/robots_check.py:*)",
    "Bash(python salary_lookup.py:*)",
  ],
  apply: [
    "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Skill",
    "Write(cv/**)", "Edit(cv/**)", "Write(cover_letters/**)", "Edit(cover_letters/**)",
    "Write(documents/applications/**)", "Edit(documents/applications/**)",
    "Write(company_research/**)", "Edit(company_research/**)",
    "Edit(job_search_tracker.csv)", "Write(job_search_tracker.csv)",
    "Bash(bun run .agents/skills/*/cli/src/cli.ts:*)",
    "Bash(python tools/*:*)", "Bash(python3 tools/*:*)",
    "Bash(lualatex:*)", "Bash(xelatex:*)", "Bash(pdflatex:*)", "Bash(tectonic:*)",
    "Bash(python salary_lookup.py:*)",
  ],
}
