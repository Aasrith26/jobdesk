// What the agent's requests do when they come from the dashboard. Free ones run at once; the rest
// are described as a question and run only after the user clicks Yes (the same rule as on Telegram).

import type { Paths } from "../lib/paths.ts"
import { readConfig, writeConfig, type Config } from "../data/config.ts"
import { readTracker, findRow, updateStatus, canonicalStatus, isFinal, followUpsSent, bucketOf } from "../data/tracker.ts"
import { openItems } from "../data/attention.ts"
import { react } from "../data/recommended.ts"
import { budgetText, ESTIMATE_USD, type ClaudeExec } from "../lib/claude.ts"
import { modelFor } from "../data/config.ts"
import { findJob, prepare, markApplied, isPreparing } from "../apply.ts"
import { quickRank, unscored, rankEstimate } from "../rank.ts"
import { scan } from "../scan.ts"
import { modelCheckLeads } from "../safety/check.ts"
import { composeDigest } from "../digest.ts"
import { buildKit } from "../kit.ts"
import { draftFollowUp, draftDm } from "../outreach.ts"
import { applyDaily, describeDaily, parseOutcome } from "../bridge/bot.ts"
import { ACT_CONFIRM, ACT_FREE } from "./tools.ts"
import { today } from "../lib/store.ts"
import { relative } from "node:path"
import { startTask } from "../tasks.ts"

export const verbOf = (a: string) => a.trim().split(/\s+/)[0]?.toLowerCase().replace(/^\//, "") ?? ""
const argOf = (a: string) => a.trim().split(/\s+/).slice(1).join(" ").slice(0, 120)

export function needsConfirm(action: string): boolean {
  return ACT_CONFIRM.includes(verbOf(action))
}

export function isKnown(action: string): boolean {
  const v = verbOf(action)
  return ACT_CONFIRM.includes(v) || ACT_FREE.includes(v) || v === "jobs"
}

/** The Yes/No question for an action that needs a click. Null when it can't be done at all. */
export function describeAction(p: Paths, cfg: Config, action: string): string | null {
  const v = verbOf(action)
  const arg = argOf(action)
  const cost = `$${(ESTIMATE_USD[modelFor(cfg.tier, "draft")]?.draft ?? 0.6).toFixed(2)}`
  if (v === "apply" || v === "applied" || v === "dm" || v === "skip") {
    const j = findJob(p, arg)
    if (!j) return null
    const name = `${j.role || "that job"}${j.company ? ` at ${j.company}` : ""}`
    return v === "apply" ? `Write a CV and letter for ${name}? About ${cost}. You'll see exactly what changed before anything is sent.`
      : v === "applied" ? `Mark ${name} as applied?`
      : v === "skip" ? `Skip ${name}? It won't be shown again.`
      : `Draft a short message to whoever posted ${name}?`
  }
  if (v === "update") {
    const o = parseOutcome(arg)
    return o ? `Mark ${o.rest} as "${o.label}"?` : null
  }
  if (v === "followup") {
    const row = findRow(readTracker(p.tracker), { company: arg })
    return row ? `Write a follow-up note for ${row.company}?` : null
  }
  if (v === "daily") {
    const next = applyDaily(cfg, arg)
    return next ? `Change this?\n${describeDaily(next)}` : null
  }
  if (v === "score") {
    const n = unscored(p).length
    return n ? `Score ${Math.min(n, 60)} job${n === 1 ? "" : "s"} against your profile? About $${rankEstimate(Math.min(n, 60)).toFixed(2)}.` : null
  }
  return null
}

export interface ActionResult {
  text: string
  /** A link to open (the kit page, the application page). */
  link?: { label: string; href: string }
}

/** Run one action. Callers make sure confirm-type actions were confirmed first. */
export async function runAction(p: Paths, action: string, o: { exec?: ClaudeExec; log?: (s: string) => void } = {}): Promise<ActionResult> {
  const cfg = readConfig(p.config)
  const v = verbOf(action)
  const arg = argOf(action)
  switch (v) {
    case "apply": {
      const j = findJob(p, arg)
      if (!j) return { text: `I couldn't tell which job "${arg}" is.` }
      if (!isPreparing(j.key)) void prepare(p, cfg, j, { exec: o.exec }).catch((e) => o.log?.(`apply failed: ${(e as Error).message}`))
      return { text: `Writing the CV and letter for ${j.role || "the job"} at ${j.company}. It takes 5 to 15 minutes. The review will appear under Applications, and nothing is sent until you confirm it.` }
    }
    case "applied": {
      const r = markApplied(p, arg)
      return { text: r.already ? `${r.company} is already marked "${r.already}".` : r.added ? `Added ${r.company} to your tracker as applied today.` : `Marked ${r.company} as applied today.` }
    }
    case "update": {
      const out = parseOutcome(arg)
      if (!out) return { text: "I couldn't tell what happened." }
      const row = findRow(readTracker(p.tracker), { company: out.rest })
      if (!row) return { text: `"${out.rest}" isn't in your applications.` }
      updateStatus(p.tracker, { company: row.company, role: row.role, url: row.source }, out.status, `${out.label} - marked in jobdesk`, today())
      return { text: `Updated: ${row.company} is now "${out.label}".` }
    }
    case "followup": {
      const row = findRow(readTracker(p.tracker), { company: arg })
      if (!row) return { text: `I can't find "${arg}" among your applications.` }
      const st = canonicalStatus(row.status)
      if (st === "drafted" || !st) return { text: `You haven't applied to ${row.company} yet.` }
      if (isFinal(row.status)) return { text: `${row.company} is closed ("${st}").` }
      const sent = followUpsSent(row.notes)
      if (sent >= 2) return { text: `You've followed up with ${row.company} twice already. I'd let it go.` }
      const d = await draftFollowUp(p, cfg, row, sent, o.exec)
      return { text: `Follow-up for ${row.company}. Edit it, then send it yourself:\n\nSubject: ${d.subject}\n\n${d.text}${d.note ? `\n\n(${d.note})` : ""}` }
    }
    case "dm": {
      const j = findJob(p, arg)
      if (!j) return { text: `I couldn't tell which job "${arg}" is.` }
      const r = await draftDm(p, cfg, j.key, o.exec)
      return { text: r.ok ? `A short message (copy it, edit it, send it yourself):\n\n${r.text}` : r.error ?? "Couldn't write it." }
    }
    case "daily": {
      const next = applyDaily(cfg, arg)
      if (!next) return { text: "I didn't follow that schedule change." }
      writeConfig(p.config, next)
      return { text: `Done.\n${describeDaily(next)}` }
    }
    case "score": {
      const n = unscored(p).length
      const t = startTask(p, "score", "Scoring jobs", async (h) => {
        const r = await quickRank(p, cfg, { limit: 1000, exec: o.exec, progress: h.progress, shouldStop: h.shouldStop })
        if (r.skipped && !r.scored) return { message: `Couldn't score: ${r.skipped}`, failed: true }
        return { message: `Scored ${r.scored} job${r.scored === 1 ? "" : "s"} ($${r.usd.toFixed(2)}).${r.remaining ? ` ${r.remaining} left.` : ""}` }
      })
      return { text: t.started ? `Scoring ${n} job${n === 1 ? "" : "s"} now. You'll see the progress at the top of every page.` : "Scoring is already running." }
    }
    case "skip": {
      const j = findJob(p, arg)
      if (!j) return { text: `I couldn't tell which job "${arg}" is.` }
      react(p.recommended, j.key, "skipped")
      return { text: `Skipped ${j.company}. It won't come back.` }
    }
    case "scan": {
      const t = startTask(p, "scan", "Searching job boards", async (h) => {
        h.progress(0, 3)
        const s = await scan(p, cfg, { log: () => {} })
        h.progress(1, 3)
        if (s.added.length && cfg.model_checks) await modelCheckLeads(p, cfg, s.added, o.exec)
        h.progress(2, 3)
        const r = s.added.length && cfg.auto_rank ? await quickRank(p, cfg, { keys: s.added, exec: o.exec }) : null
        h.progress(3, 3)
        const failed = s.portals.filter((x) => x.status === "failed").map((x) => x.name.replace(/-search$/, ""))
        return { message: `${s.added.length} new job${s.added.length === 1 ? "" : "s"} found${r ? `, ${r.scored} scored` : ""}.${failed.length ? ` Didn't answer: ${failed.join(", ")}.` : ""}` }
      })
      return { text: t.started ? "Searching the job boards now. It takes a few minutes; new fits will appear in Jobs." : "A search is already running." }
    }
    case "digest":
      return { text: composeDigest(p, cfg).text }
    case "status": {
      const rows = readTracker(p.tracker).rows
      const n = (b: string) => rows.filter((r) => bucketOf(r.status).bucket === b).length
      return { text: `Drafted ${n("Drafted")}, sent and waiting ${n("Active")}, interviews ${n("Interview")}, offers ${n("Offer") + n("Hired")}, closed ${n("Rejected/Closed")}.` }
    }
    case "attention": {
      const items = openItems(p.attention)
      return { text: items.length ? items.slice(0, 8).map((i) => `- ${i.title}`).join("\n") : "Nothing needs you right now." }
    }
    case "budget":
      return { text: budgetText(p.costs, cfg) }
    case "kit": {
      const j = findJob(p, arg)
      if (!j) return { text: `I couldn't tell which job "${arg}" is.` }
      const k = buildKit(p, j.key)
      return { text: k.text, link: { label: "Open the kit", href: `/file?path=${encodeURIComponent(relative(p.root, k.html_path))}` } }
    }
    case "resume":
      return { text: "Your CVs are in the Applications page, next to each application." }
    case "jobs":
      return { text: "" }
  }
  return { text: `"${v}" isn't something I can do.` }
}
