// wrapper-data/recommended.json - every job the user has been shown, when, where, and what they
// did with it. "New jobs" means jobs that are not in here yet, so asking twice never repeats a list.

import { readJson, writeJson, nowIso } from "../lib/store.ts"

export type Reaction = "skipped" | "applied" | "drafted"

export interface Shown {
  first_shown: string
  last_shown: string
  times: number
  /** Where it was shown first: telegram, dashboard, digest, daily. */
  via: string
  reaction?: Reaction
  reacted_at?: string
}

export function readShown(file: string): Record<string, Shown> {
  const raw = readJson<Record<string, Shown>>(file, {})
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
}

/** Record that these jobs were put in front of the user. Read, change and write in one step. */
export function markShown(file: string, keys: string[], via: string, at: string = nowIso()): void {
  if (!keys.length) return
  const all = readShown(file)
  for (const k of keys) {
    const prev = all[k]
    all[k] = prev ? { ...prev, last_shown: at, times: prev.times + 1 } : { first_shown: at, last_shown: at, times: 1, via }
  }
  writeJson(file, all)
}

/** What the user did with a job. A job they react to counts as shown, even if it came from elsewhere. */
export function react(file: string, key: string, reaction: Reaction, at: string = nowIso()): void {
  const all = readShown(file)
  const prev = all[key] ?? { first_shown: at, last_shown: at, times: 1, via: "reaction" }
  all[key] = { ...prev, reaction, reacted_at: at }
  writeJson(file, all)
}
