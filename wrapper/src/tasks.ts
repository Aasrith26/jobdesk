// Background work the dashboard starts (scoring, searching, drafting a profile): it runs on the
// server, not inside a browser request, so switching pages or reloading never loses it. Progress is
// written to wrapper-data/tasks.json, which the page shows wherever you are. A task left "running"
// by a jobdesk that has since stopped is shown as interrupted, never as running forever.

import { join } from "node:path"
import type { Paths } from "./lib/paths.ts"
import { readJson, writeJson, nowIso } from "./lib/store.ts"

export type TaskKind = "score" | "scan" | "profile"
export type TaskStatus = "running" | "done" | "failed" | "stopped" | "interrupted"

export interface Task {
  id: string
  kind: TaskKind
  /** What it is doing, in a few words: "Scoring jobs". */
  label: string
  status: TaskStatus
  started: string
  finished?: string
  done: number
  total: number
  /** The outcome in one line: "Scored 180 jobs ($0.19)." */
  message?: string
  /** Anything the page needs afterwards (e.g. the drafted profile). */
  result?: unknown
  pid: number
}

const file = (p: Paths) => join(p.data, "tasks.json")

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** All tasks, newest first. Running tasks whose process is gone are reported as interrupted. */
export function readTasks(p: Paths): Task[] {
  const raw = readJson<Task[]>(file(p), [])
  const list = Array.isArray(raw) ? raw : []
  return list
    .map((t) => (t.status === "running" && t.pid !== process.pid && !alive(t.pid) ? { ...t, status: "interrupted" as const, message: t.message ?? "Stopped when jobdesk stopped." } : t))
    .sort((a, b) => b.started.localeCompare(a.started))
}

function save(p: Paths, t: Task): void {
  const others = readJson<Task[]>(file(p), []).filter((x) => x.id !== t.id)
  // Keep the file small: the 20 newest.
  writeJson(file(p), [t, ...others].sort((a, b) => b.started.localeCompare(a.started)).slice(0, 20))
}

export function runningTask(p: Paths, kind: TaskKind): Task | undefined {
  return readTasks(p).find((t) => t.kind === kind && t.status === "running")
}

/** Tasks to show on the page: everything running, plus what finished in the last 15 minutes. */
export function visibleTasks(p: Paths, now: number = Date.now()): Task[] {
  return readTasks(p).filter((t) => t.status === "running" || (t.finished && now - Date.parse(t.finished) < 15 * 60_000))
}

const stopRequests = new Set<string>()

export function requestStop(id: string): void {
  stopRequests.add(id)
}

export interface TaskHandle {
  id: string
  progress: (done: number, total: number) => void
  shouldStop: () => boolean
}

/**
 * Start work in the background and return at once. The same kind can't run twice: the running one
 * is returned instead. `work` reports progress through the handle and returns the outcome line.
 */
export function startTask(p: Paths, kind: TaskKind, label: string, work: (h: TaskHandle) => Promise<{ message: string; result?: unknown; failed?: boolean }>): { task: Task; started: boolean } {
  const already = runningTask(p, kind)
  if (already) return { task: already, started: false }
  const id = `${kind}-${Date.now().toString(36)}`
  let t: Task = { id, kind, label, status: "running", started: nowIso(), done: 0, total: 0, pid: process.pid }
  save(p, t)
  let last = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    pending = undefined
    last = Date.now()
    if (t.status === "running") save(p, t)
  }
  const handle: TaskHandle = {
    id,
    progress: (done, total) => {
      t = { ...t, done, total }
      // At most one write every 300 ms, and the newest numbers always land (a trailing write).
      if (Date.now() - last > 300 || done >= total) {
        clearTimeout(pending)
        flush()
      } else if (!pending) pending = setTimeout(flush, 300)
    },
    shouldStop: () => stopRequests.has(id),
  }
  void work(handle)
    .then((r) => {
      const stopped = stopRequests.has(id)
      t = { ...t, status: r.failed ? "failed" : stopped ? "stopped" : "done", finished: nowIso(), message: r.message, result: r.result }
    })
    .catch((e) => {
      t = { ...t, status: "failed", finished: nowIso(), message: (e as Error).message }
    })
    .finally(() => {
      clearTimeout(pending)
      stopRequests.delete(id)
      save(p, t)
    })
  return { task: t, started: true }
}
