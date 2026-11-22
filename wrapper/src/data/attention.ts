// The attention queue (ATT-*): one list of everything that needs a human.
// Priority: deadlines > recruiter replies > blocked applications > everything else (ATT-3).

import { readJson, writeJson, nowIso } from "../lib/store.ts"

export type AttentionKind =
  | "deadline"
  | "recruiter_reply"
  | "unknown_question"
  | "hard_stop"
  | "review_submit"
  | "review_ready"
  | "unconfirmed_submission"
  | "flagged_posting"
  | "followup_due"
  | "failed_run"
  | "other"

export const PRIORITY: Record<AttentionKind, number> = {
  deadline: 0,
  recruiter_reply: 1,
  unknown_question: 2,
  hard_stop: 2,
  review_submit: 2,
  review_ready: 2,
  unconfirmed_submission: 2,
  flagged_posting: 3,
  followup_due: 3,
  failed_run: 3,
  other: 4,
}

export interface AttentionItem {
  id: string
  kind: AttentionKind
  title: string
  why: string
  action: string
  ref?: string
  due?: string
  data?: Record<string, unknown>
  created: string
  resolved?: string
  resolution?: string
}

export function readQueue(file: string): AttentionItem[] {
  return readJson<AttentionItem[]>(file, [])
}

export function openItems(file: string): AttentionItem[] {
  return sortQueue(readQueue(file).filter((i) => !i.resolved))
}

export function sortQueue(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      PRIORITY[a.kind] - PRIORITY[b.kind] ||
      (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
      a.created.localeCompare(b.created) ||
      a.id.localeCompare(b.id),
  )
}

/** Add an item; an open item with the same id is updated in place, never duplicated. */
export function addItem(file: string, item: Omit<AttentionItem, "created"> & { created?: string }): AttentionItem {
  const q = readQueue(file)
  const existing = q.find((i) => i.id === item.id && !i.resolved)
  const full: AttentionItem = { ...item, created: existing?.created ?? item.created ?? nowIso() }
  writeJson(file, existing ? q.map((i) => (i === existing ? full : i)) : [...q, full])
  return full
}

export function resolveItem(file: string, id: string, resolution: string): AttentionItem | undefined {
  const q = readQueue(file)
  const it = q.find((i) => i.id === id && !i.resolved)
  if (!it) return undefined
  it.resolved = nowIso()
  it.resolution = resolution
  writeJson(file, q)
  return it
}

export function getItem(file: string, id: string): AttentionItem | undefined {
  return readQueue(file).find((i) => i.id === id)
}
