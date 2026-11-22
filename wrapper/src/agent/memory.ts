// What the agent keeps between messages, on disk so a restart forgets nothing:
//   - the conversation (one history for Telegram and the dashboard: it's one assistant)
//   - notes about the user ("no sales roles", "prefers remote") that it chose to remember.
// Both are the user's own data in wrapper-data/, shown on the dashboard and never committed.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Paths } from "../lib/paths.ts"
import { appendJsonl, readJsonl, nowIso } from "../lib/store.ts"

export interface Turn {
  at: string
  channel: "telegram" | "dashboard"
  role: "user" | "assistant"
  text: string
  /** Jobs shown with this reply (keys), so the conversation reads the same after a reload. */
  jobs?: string[]
}

const chatFile = (p: Paths) => join(p.data, "chat.jsonl")
export const notesFile = (p: Paths) => join(p.data, "agent_notes.md")

export function addTurn(p: Paths, channel: Turn["channel"], role: Turn["role"], text: string, jobs?: string[]): void {
  if (!text.trim()) return
  appendJsonl(chatFile(p), { at: nowIso(), channel, role, text: text.slice(0, 4000), ...(jobs?.length ? { jobs } : {}) } satisfies Turn)
}

export function recentTurns(p: Paths, n = 12): Turn[] {
  return readJsonl<Turn>(chatFile(p)).slice(-n)
}

export function pastForPrompt(p: Paths, n = 8): string {
  return recentTurns(p, n).map((t) => `${t.role === "user" ? "Them" : "You"} (${t.channel}): ${t.text.slice(0, 600)}`).join("\n")
}

export function readNotes(p: Paths): string[] {
  if (!existsSync(notesFile(p))) return []
  return readFileSync(notesFile(p), "utf8").split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean)
}

/** Keep one short note. Exact repeats are ignored; the list is capped so the prompt stays small. */
export function addNote(p: Paths, note: string): string[] {
  const n = note.replace(/\s+/g, " ").trim().slice(0, 200)
  const notes = readNotes(p)
  if (!n || notes.some((x) => x.toLowerCase() === n.toLowerCase())) return notes
  const next = [...notes, n].slice(-30)
  mkdirSync(dirname(notesFile(p)), { recursive: true })
  writeFileSync(notesFile(p), next.map((x) => `- ${x}`).join("\n") + "\n", "utf8")
  return next
}

export function removeNote(p: Paths, index: number): string[] {
  const next = readNotes(p).filter((_, i) => i !== index)
  writeFileSync(notesFile(p), next.map((x) => `- ${x}`).join("\n") + (next.length ? "\n" : ""), "utf8")
  return next
}
