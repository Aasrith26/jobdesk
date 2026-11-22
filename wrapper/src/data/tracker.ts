// Reads and (narrowly) updates job_search_tracker.csv under the upstream /outcome rules:
// canonical status spellings, legacy space spellings accepted on read, notes never
// contain commas/quotes/newlines, only `status`, `notes` and (when leaving drafted)
// `date` are touched, every other field and every other row is preserved byte for byte.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { parseCsv, serializeRow } from "./csv.ts"
import { today } from "../lib/store.ts"

export const TRACKER_COLUMNS = [
  "date", "company", "sector", "role", "role_type", "channel", "status", "contact_person",
  "fit_rating", "notes", "cv_file", "cover_letter_file", "source", "deadline",
] as const

export type TrackerRow = Record<(typeof TRACKER_COLUMNS)[number], string> & { _index: number; _extra: string[] }

export const CANONICAL_STATUSES = ["drafted", "applied", "interview", "offer", "hired", "rejected", "no_response", "offer_declined", "withdrawn"] as const
export const FINAL_STATUSES = new Set(["hired", "rejected", "no_response", "offer_declined", "withdrawn"])

export type Bucket = "Drafted" | "Active" | "Interview" | "Offer" | "Hired" | "Rejected/Closed"

/** Canonicalise a status value read from the tracker (legacy spaces, case). */
export function canonicalStatus(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (s === "no response") return "no_response"
  if (s === "offer declined") return "offer_declined"
  return s
}

/** Same bucket map as /html-report Step 1. */
export function bucketOf(raw: string): { bucket: Bucket; unknown: boolean } {
  const s = canonicalStatus(raw)
  switch (s) {
    case "drafted": return { bucket: "Drafted", unknown: false }
    case "applied": return { bucket: "Active", unknown: false }
    case "interview": return { bucket: "Interview", unknown: false }
    case "offer": return { bucket: "Offer", unknown: false }
    case "hired": return { bucket: "Hired", unknown: false }
    case "rejected": case "no_response": case "offer_declined": case "withdrawn":
      return { bucket: "Rejected/Closed", unknown: false }
    default: return { bucket: "Rejected/Closed", unknown: true }
  }
}

export function isFinal(raw: string): boolean {
  return FINAL_STATUSES.has(canonicalStatus(raw))
}

export interface Tracker {
  header: string[]
  rows: TrackerRow[]
  /** Raw lines, kept so untouched rows are rewritten byte for byte. */
  lines: string[]
  eol: string
}

export function readTracker(file: string): Tracker {
  if (!existsSync(file)) return { header: [...TRACKER_COLUMNS], rows: [], lines: [], eol: "\n" }
  const text = readFileSync(file, "utf8")
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const parsed = parseCsv(text)
  const header = parsed[0] ?? [...TRACKER_COLUMNS]
  const lines = text.split(/\r?\n/)
  const rows: TrackerRow[] = []
  parsed.slice(1).forEach((fields, i) => {
    const row = { _index: i, _extra: [] as string[] } as unknown as TrackerRow
    header.forEach((h, j) => {
      ;(row as unknown as Record<string, string>)[h] = fields[j] ?? ""
    })
    for (const c of TRACKER_COLUMNS) if ((row as unknown as Record<string, string>)[c] === undefined) (row as unknown as Record<string, string>)[c] = ""
    row._extra = fields.slice(header.length)
    rows.push(row)
  })
  return { header, rows, lines, eol }
}

/** Notes may not contain commas, double quotes or line breaks (/outcome Step 4). */
export function safeNote(note: string): string {
  return note.replace(/[\r\n]+/g, " ").replace(/,/g, " -").replace(/"/g, "'").replace(/\s+/g, " ").trim()
}

export function followUpsSent(notes: string): number {
  return (notes.match(/followed up \d{4}-\d{2}-\d{2}/g) ?? []).length
}

export function lastActivity(row: TrackerRow): string {
  const dates = [row.date, ...(row.notes.match(/\d{4}-\d{2}-\d{2}/g) ?? [])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  return dates.sort().at(-1) ?? row.date
}

function rowToFields(t: Tracker, row: TrackerRow): string[] {
  return [...t.header.map((h) => (row as unknown as Record<string, string>)[h] ?? ""), ...row._extra]
}

function writeTracker(file: string, t: Tracker, changed: Map<number, TrackerRow>, appended: TrackerRow[] = []): void {
  // Rebuild from the raw text so untouched rows (and any quoting a spreadsheet added) stay byte-identical.
  // Data rows are matched to raw lines in order; rows spanning several lines (quoted newlines) are left
  // untouched, and a change to one of them is refused rather than risking corruption.
  const text = readFileSync(file, "utf8")
  const rawLines = text.split(/\r?\n/)
  const nonEmpty = rawLines.filter((l) => l.trim()).length - 1
  if (nonEmpty !== t.rows.length) {
    throw new Error("The tracker has a field with a line break inside it, so jobdesk will not rewrite it. Fix that row in a spreadsheet, then try again.")
  }
  const out: string[] = []
  let dataIdx = -1
  let headerSeen = false
  for (const line of rawLines) {
    if (!headerSeen) {
      out.push(line)
      if (line.trim()) headerSeen = true
      continue
    }
    if (!line.trim()) {
      out.push(line)
      continue
    }
    dataIdx++
    const ch = changed.get(dataIdx)
    out.push(ch ? serializeRow(rowToFields(t, ch)) : line)
  }
  while (out.length && out[out.length - 1] === "") out.pop()
  for (const r of appended) out.push(serializeRow(rowToFields(t, r)))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, out.join(t.eol) + t.eol, "utf8")
  renameSync(tmp, file)
}

export interface Match {
  company: string
  role?: string
  url?: string
}

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")

export function findRow(t: Tracker, m: Match): TrackerRow | undefined {
  if (m.url) {
    const u = m.url.replace(/\/+$/, "")
    const hit = t.rows.find((r) => r.source.replace(/\/+$/, "") === u)
    if (hit) return hit
  }
  return t.rows.find((r) => normKey(r.company) === normKey(m.company) && (!m.role || normKey(r.role) === normKey(m.role)))
}

/**
 * Move a row to a new canonical status and append a dated note, exactly as /outcome Step 4 does.
 * Leaving `drafted` overwrites `date` with the real submission date.
 */
export function updateStatus(file: string, m: Match, status: string, note: string, date: string = today()): TrackerRow {
  if (!(CANONICAL_STATUSES as readonly string[]).includes(status)) throw new Error(`Unknown status "${status}"`)
  const t = readTracker(file)
  const row = findRow(t, m)
  if (!row) throw new Error(`No tracker row for ${m.company}${m.role ? " / " + m.role : ""}`)
  const wasDrafted = canonicalStatus(row.status) === "drafted"
  const next = { ...row, _extra: [...row._extra] } as TrackerRow
  next.status = status
  const n = safeNote(`${note} (${date})`)
  next.notes = row.notes ? `${row.notes}; ${n}` : n
  if (wasDrafted && status !== "drafted") next.date = date
  writeTracker(file, t, new Map([[row._index, next]]))
  return next
}

export function appendNote(file: string, m: Match, note: string): TrackerRow {
  const t = readTracker(file)
  const row = findRow(t, m)
  if (!row) throw new Error(`No tracker row for ${m.company}`)
  const next = { ...row, _extra: [...row._extra] } as TrackerRow
  const n = safeNote(note)
  next.notes = row.notes ? `${row.notes}; ${n}` : n
  writeTracker(file, t, new Map([[row._index, next]]))
  return next
}

export function appendRow(file: string, values: Partial<Record<(typeof TRACKER_COLUMNS)[number], string>>): void {
  if (!existsSync(file)) writeFileSync(file, TRACKER_COLUMNS.join(",") + "\n", "utf8")
  const t = readTracker(file)
  const row = { _index: t.rows.length, _extra: [] } as unknown as TrackerRow
  for (const c of t.header) (row as unknown as Record<string, string>)[c] = c === "notes" ? safeNote(values.notes ?? "") : ((values as Record<string, string>)[c] ?? "").replace(/[\r\n,"]/g, " ")
  writeTracker(file, t, new Map(), [row])
}
