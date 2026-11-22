// wrapper-data/config.json - every setting has a safe default, so a missing file works.

import { readJson, writeJson } from "../lib/store.ts"

export type Tier = "lite" | "standard" | "max"
export type ApprovalLevel = "L0" | "L1" | "L2"

export interface Config {
  tier: Tier
  monthly_budget_usd: number
  daily_application_cap: number
  approval_level: ApprovalLevel
  trusted_ats: string[]
  queries: string[]
  locations: string[]
  telegram_channels: string[]
  subreddits: string[]
  telegram: { owner_chat_id?: number; digest_time: string; language?: string }
  dashboard_port: number
  followup_days: number
  browser?: string
  /** Second-opinion model checks for scams, discrimination and email sorting (a fraction of a cent each). */
  model_checks: boolean
  /** The once-a-day routine. Everything here is off until the user turns it on. */
  daily: DailyConfig
  /** Lowest fit score (0-100) a job needs before it is put in front of the user. */
  min_fit: number
  /** Give new finds a quick fit score after each search (a cent or two per batch on the small model). */
  auto_rank: boolean
}

export type DailyApply = "off" | "ask" | "auto"

export interface DailyConfig {
  /** Search the job boards once every 24 hours and report the strong matches. */
  search: boolean
  /** Local time of the daily search, HH:MM. */
  time: string
  /**
   * What happens to the strong matches: "off" just lists them, "ask" adds an Apply button to each,
   * "auto" starts each application without asking. "auto" never widens what may be submitted:
   * the approval level and trusted-site rules still decide that.
   */
  apply: DailyApply
  /** How many strong matches a day, at most. The daily application cap still applies on top. */
  picks: number
  /** Write a follow-up draft when an application has gone quiet, without being asked. */
  followups: boolean
}

export const DEFAULT_CONFIG: Config = {
  tier: "standard",
  monthly_budget_usd: 10,
  daily_application_cap: 5,
  approval_level: "L0",
  trusted_ats: [],
  queries: [],
  locations: [],
  telegram_channels: [],
  subreddits: [],
  telegram: { digest_time: "09:00" },
  dashboard_port: 4317,
  followup_days: 10,
  model_checks: true,
  daily: { search: false, time: "08:30", apply: "ask", picks: 3, followups: false },
  min_fit: 60,
  auto_rank: true,
}

export function readConfig(file: string): Config {
  const raw = readJson<Partial<Config>>(file, {})
  return { ...DEFAULT_CONFIG, ...raw, telegram: { ...DEFAULT_CONFIG.telegram, ...(raw.telegram ?? {}) }, daily: { ...DEFAULT_CONFIG.daily, ...(raw.daily ?? {}) } }
}

export function writeConfig(file: string, c: Config): void {
  writeJson(file, c)
}

/** Model alias per tier (INC-2). Lite uses the cheapest model for ranking-type work. */
export function modelFor(tier: Tier, task: "rank" | "draft" | "evaluate" | "chat"): string {
  if (tier === "lite") return task === "draft" ? "sonnet" : "haiku"
  if (tier === "max") return "opus"
  return task === "rank" || task === "chat" ? "haiku" : "sonnet"
}
