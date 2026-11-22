// Follow-ups (OUT-2) and deadline reminders (INB-3), using the upstream /outcome rules:
// open, not drafted, threshold since the date or last "followed up" marker, fewer than two sent.

import { readTracker, isFinal, canonicalStatus, followUpsSent, lastActivity, type TrackerRow } from "./data/tracker.ts"
import { addItem, readQueue } from "./data/attention.ts"
import { daysBetween, today } from "./lib/store.ts"
import type { Paths } from "./lib/paths.ts"
import type { Config } from "./data/config.ts"

export interface FollowUp {
  row: TrackerRow
  daysQuiet: number
  sent: number
}

export function dueFollowUps(trackerFile: string, cfg: Config, now: string = today()): FollowUp[] {
  return readTracker(trackerFile)
    .rows.filter((r) => !isFinal(r.status) && canonicalStatus(r.status) !== "drafted" && r.status.trim() !== "")
    .map((row) => ({ row, daysQuiet: daysBetween(lastActivity(row), now), sent: followUpsSent(row.notes) }))
    .filter((f) => Number.isFinite(f.daysQuiet) && f.daysQuiet >= cfg.followup_days && f.sent < 2)
}

export interface Deadline {
  row: TrackerRow
  hoursLeft: number
}

export function upcomingDeadlines(trackerFile: string, now: Date = new Date(), withinHours = 48): Deadline[] {
  return readTracker(trackerFile)
    .rows.filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.deadline) && !isFinal(r.status) && canonicalStatus(r.status) === "drafted")
    .map((row) => ({ row, hoursLeft: (Date.parse(row.deadline.slice(0, 10) + "T23:59:00") - now.getTime()) / 3_600_000 }))
    .filter((d) => d.hoursLeft > 0 && d.hoursLeft <= withinHours)
}

/** Push due follow-ups and deadlines into the attention queue (idempotent by id). */
export function refreshReminders(p: Paths, cfg: Config, now: Date = new Date()): number {
  let n = 0
  const nowDay = today(now)
  for (const f of dueFollowUps(p.tracker, cfg, nowDay)) {
    addItem(p.attention, {
      id: `followup:${f.row.company}:${f.row.role}:${f.sent}`,
      kind: "followup_due",
      title: `Follow up with ${f.row.company}`,
      why: `${f.daysQuiet} days with no reply on "${f.row.role}". Follow-ups sent: ${f.sent} of 2.`,
      action: "Tap Write follow-up and I'll draft a short note for you to send.",
      ref: f.row.source,
      data: { company: f.row.company, role: f.row.role, sent: f.sent },
    })
    n++
  }
  for (const d of upcomingDeadlines(p.tracker, now)) {
    addItem(p.attention, {
      id: `deadline:${d.row.company}:${d.row.role}`,
      kind: "deadline",
      title: `Deadline soon: ${d.row.company}`,
      why: `"${d.row.role}" closes on ${d.row.deadline} (about ${Math.round(d.hoursLeft)} hours left) and isn't submitted yet.`,
      action: "Open the kit and submit, or mark it skipped.",
      due: d.row.deadline,
      ref: d.row.source,
    })
    n++
  }
  // Deadlines captured from emails (assessments) get a 4-hour reminder too.
  for (const it of readQueue(p.attention)) {
    if (it.resolved || it.kind !== "deadline" || !it.due) continue
    const hours = (Date.parse(it.due.length === 10 ? it.due + "T23:59:00" : it.due) - now.getTime()) / 3_600_000
    if (hours > 0 && hours <= 4) {
      addItem(p.attention, { ...it, id: `${it.id}:4h`, title: `In about ${Math.max(1, Math.round(hours))} hours: ${it.title}` })
      n++
    }
  }
  void nowDay
  return n
}
