// wrapper-data/scores.json - quick fit scores jobdesk made from the posting text it already has.
// They live here, not in seen_jobs.json: upstream /rank fetches the full posting and its score is
// the authoritative one, so a quick score never stops /rank from scoring a job properly later.

import { readJson, writeJson } from "../lib/store.ts"

export type LocationVerdict = "PASS" | "FAIL" | "FLAG"

export interface QuickScore {
  score: number
  verdict: string
  /** One plain sentence: why it is or isn't a fit. */
  reason: string
  strengths: string[]
  gaps: string[]
  location: LocationVerdict
  /** Set when the posting hits one of the profile's deal-breakers. */
  dealbreaker?: string
  /** What the score was made from. A title alone gives a capped, cautious score. */
  basis: "posting excerpt" | "title only"
  date: string
  model: string
}

/** The framework's weights and bands (04-job-evaluation.md, tools/rank_state.py). */
export const WEIGHTS = { technical: 0.3, experience: 0.25, behavioral: 0.15, career: 0.3 } as const
const BANDS: [number, string][] = [[75, "Strong Fit"], [60, "Good Fit"], [45, "Moderate Fit"], [30, "Weak Fit"], [0, "Poor Fit"]]

export function overallScore(s: Record<keyof typeof WEIGHTS, number>): number {
  // Whole-number arithmetic in tenths, so 59.5 never rounds down by float error.
  let tenths = 0
  for (const [dim, w] of Object.entries(WEIGHTS)) tenths += s[dim as keyof typeof WEIGHTS] * Math.round(w * 100)
  return Math.floor(tenths / 100 + 0.5)
}

export function band(score: number): string {
  return BANDS.find(([floor]) => score >= floor)?.[1] ?? "Poor Fit"
}

export function readScores(file: string): Record<string, QuickScore> {
  const raw = readJson<Record<string, QuickScore>>(file, {})
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
}

export function saveScores(file: string, add: Record<string, QuickScore>): void {
  if (!Object.keys(add).length) return
  writeJson(file, { ...readScores(file), ...add })
}
