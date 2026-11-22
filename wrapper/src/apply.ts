// One application, start to finish, the same from the phone and the dashboard:
//   1. prepare: write the CV and letter (upstream /apply), then build the review   -> "ready"
//   2. the user reads the review and confirms                                       -> "confirmed"
//   3. kit sites: one tap opens the page with everything ready; they tap "I applied" -> "applied"
//      fill sites (L1+): the form is filled in their browser and waits for Send
// Nothing is ever sent at step 1 or 2. The state lives in wrapper-data/applications.json.

import type { Paths } from "./lib/paths.ts"
import type { Config } from "./data/config.ts"
import { readJson, writeJson, nowIso, today } from "./lib/store.ts"
import { readSeen } from "./data/seen.ts"
import { readTracker, findRow, appendRow, updateStatus, canonicalStatus } from "./data/tracker.ts"
import { runClaude, TOOLS, type ClaudeExec } from "./lib/claude.ts"
import { capCheck, buildKit, type Kit } from "./kit.ts"
import { buildReview, readReview, trackerRowFor, type ApplicationReview } from "./review.ts"
import { addItem, resolveItem } from "./data/attention.ts"
import { react } from "./data/recommended.ts"
import { join } from "node:path"

export type Stage = "drafting" | "ready" | "confirmed" | "applied" | "failed" | "stopped"

export interface AppState {
  key: string
  url: string
  company: string
  role: string
  stage: Stage
  started: string
  updated: string
  /** Why it stopped or failed, in plain words (e.g. /apply's own fit verdict). */
  note?: string
  /** /apply's own words when it stopped or failed (its fit verdict, a posting it couldn't read). */
  report?: string
  usd?: number
}

export interface JobRef {
  key: string
  url: string
  company: string
  role: string
}

const file = (p: Paths) => join(p.data, "applications.json")

export function readApps(p: Paths): Record<string, AppState> {
  const raw = readJson<Record<string, AppState>>(file(p), {})
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
}

function setApp(p: Paths, job: JobRef, change: Partial<AppState>): AppState {
  const all = readApps(p)
  const prev = all[job.key]
  const base: AppState = prev ?? { key: job.key, url: job.url, company: job.company, role: job.role, stage: "drafting", started: nowIso(), updated: nowIso() }
  const next: AppState = { ...base, url: job.url || base.url, company: job.company || base.company, role: job.role || base.role, ...change, key: job.key, updated: nowIso() }
  all[job.key] = next
  writeJson(file(p), all)
  return next
}

/** A job by key, link or company, from the jobs found or the tracker. */
export function findJob(p: Paths, ref: string): JobRef | null {
  const r = ref.trim()
  if (!r) return null
  const seen = readSeen(p.seen)
  const j = seen.find((s) => s.key === r || s.url === r) ?? seen.find((s) => s.company.toLowerCase() === r.toLowerCase())
  if (j) return { key: j.key, url: j.url, company: j.company, role: j.title }
  const t = readTracker(p.tracker)
  const row = t.rows.find((x) => x.source === r) ?? findRow(t, { company: r })
  if (row) return { key: row.source || row.company, url: row.source, company: row.company, role: row.role }
  if (/^https?:\/\//.test(r)) return { key: r, url: r, company: "", role: "" }
  return null
}

export const DRAFT_PROMPT = (url: string) =>
  `/apply ${url}\n\nThis run was started from jobdesk (the dashboard or the phone), which can't answer questions mid-run. The candidate approved drafting in advance and will review the CV and letter before anything is sent. If the posting guard flags anything, or the fit is weak, stop after the evaluation and report instead of drafting.`

/** Work in progress in this process, so a double tap (or the phone and the dashboard at once) runs it once. */
const inFlight = new Map<string, Promise<PrepareResult>>()

export interface PrepareResult {
  ok: boolean
  state: AppState
  review?: ApplicationReview
  /** /apply's own report, when it stopped without drafting (weak fit, flagged posting). */
  report?: string
  error?: string
}

export function isPreparing(key: string): boolean {
  return inFlight.has(key)
}

/**
 * Write the CV and letter (unless they exist) and build the review. Takes 5 to 15 minutes when it
 * drafts. Safe to call twice: the second call waits for the first.
 */
export function prepare(p: Paths, cfg: Config, job: JobRef, o: { exec?: ClaudeExec; log?: (s: string) => void } = {}): Promise<PrepareResult> {
  const running = inFlight.get(job.key)
  if (running) return running
  const work = (async (): Promise<PrepareResult> => {
    let row = trackerRowFor(p, job.url)
    if (!row?.cv_file) {
      const cap = capCheck(p, cfg)
      if (!cap.ok) return { ok: false, state: setApp(p, job, { stage: "stopped", note: cap.message }), error: cap.message }
      setApp(p, job, { stage: "drafting", note: undefined, report: undefined, started: nowIso() })
      const r = await runClaude({ root: p.root, ledger: p.costs, cfg, task: "draft", prompt: DRAFT_PROMPT(job.url), allowedTools: TOOLS.apply, exec: o.exec })
      if (r.skipped) return { ok: false, state: setApp(p, job, { stage: "failed", note: r.error, usd: r.usd }), error: r.error }
      row = trackerRowFor(p, job.url)
      if (!row?.cv_file) {
        const report = (r.text.trim() || r.error || "").slice(0, 6000)
        const state = setApp(p, job, { stage: r.ok ? "stopped" : "failed", note: r.ok ? "It stopped before writing a CV. Open the report to see why." : r.error ?? "The drafting run didn't finish.", report, usd: r.usd })
        return { ok: false, state, report, error: state.note }
      }
      setApp(p, job, { usd: r.usd })
    }
    const ref: JobRef = { ...job, company: row.company || job.company, role: row.role || job.role }
    const review = await buildReview(p, cfg, ref, { exec: o.exec })
    react(p.recommended, job.key, "drafted")
    addItem(p.attention, { id: `review:${job.key}`, kind: "review_ready", title: `Review your application: ${ref.role} at ${ref.company}`, why: "The CV and letter are written. Nothing has been sent.", action: "Read what changed, then confirm or leave it.", ref: job.key, data: { key: job.key, company: ref.company } })
    return { ok: true, state: setApp(p, ref, { stage: "ready", note: undefined }), review }
  })()
    .catch((e) => ({ ok: false, state: setApp(p, job, { stage: "failed", note: (e as Error).message }), error: (e as Error).message }))
    .finally(() => inFlight.delete(job.key))
  inFlight.set(job.key, work)
  return work
}

export interface Confirmed {
  how: "fill" | "kit"
  review: ApplicationReview
  kit: Kit
}

/** The user read the review and said go. Returns what happens next; the caller runs the fill if "fill". */
export function confirm(p: Paths, key: string): Confirmed {
  const review = readReview(p, key)
  if (!review) throw new Error("There's no review for that job yet. Start with Apply.")
  const kit = buildKit(p, review.url || key)
  const job = { key, url: review.url, company: review.company, role: review.role }
  setApp(p, job, { stage: "confirmed" })
  resolveItem(p.attention, `review:${key}`, "confirmed")
  return { how: review.how, review, kit }
}

/** "I applied": the tracker row becomes applied (or is added, for a job applied to by hand). */
export function markApplied(p: Paths, ref: string, day: string = today()): { company: string; already?: string; added?: boolean } {
  const job = findJob(p, ref)
  if (!job) throw new Error(`I can't find "${ref}".`)
  const t = readTracker(p.tracker)
  const row = t.rows.find((r) => r.source === job.url) ?? (job.company ? findRow(t, { company: job.company, role: job.role || undefined }) : undefined)
  if (!row) {
    if (!job.company || !job.role) throw new Error("I don't know that job's company and role yet.")
    const seen = readSeen(p.seen).find((s) => s.key === job.key)
    appendRow(p.tracker, { date: day, company: job.company, role: job.role, channel: seen?.portal && /-search$/.test(seen.portal) ? "portal" : "online", status: "applied", fit_rating: seen?.rank_score !== undefined ? String(seen.rank_score) : "", notes: `marked applied in jobdesk (${day})`, source: job.url })
    react(p.recommended, job.key, "applied")
    setApp(p, job, { stage: "applied" })
    return { company: job.company, added: true }
  } else {
    const was = canonicalStatus(row.status)
    if (was !== "drafted" && was !== "") return { company: row.company, already: was }
    updateStatus(p.tracker, { company: row.company, role: row.role, url: row.source }, "applied", "marked applied in jobdesk", day)
  }
  react(p.recommended, job.key, "applied")
  setApp(p, job, { stage: "applied" })
  resolveItem(p.attention, `review:${job.key}`, "applied")
  return { company: row?.company ?? job.company }
}

/** Leave a prepared application for now: nothing is deleted. */
export function shelve(p: Paths, key: string): void {
  const a = readApps(p)[key]
  if (a) setApp(p, a, { stage: "stopped", note: "Left for later." })
  resolveItem(p.attention, `review:${key}`, "left for later")
}
