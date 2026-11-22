// wrapper-data/leads.json - metadata for social/community leads, keyed by the same
// canonical job_key that seen_jobs.json uses, so the two never disagree on identity.

import { readJson, writeJson, nowIso } from "../lib/store.ts"

export interface Lead {
  key: string
  url: string
  title: string
  company: string
  portal: string
  kind: "lead" | "job"
  lead_type?: string
  fetched_at: string
  fetch_method: string
  guard_verdict: string
  guard_findings?: unknown
  flags: { scam: string[]; discrimination: string[] }
  contact_routes: string[]
  text_excerpt?: string
  /** Labels from the optional model check (src/safety/check.ts). */
  model_check?: { scam: string; discrimination: string }
}

export function readLeads(file: string): Record<string, Lead> {
  return readJson<Record<string, Lead>>(file, {})
}

export function upsertLead(file: string, lead: Omit<Lead, "fetched_at"> & { fetched_at?: string }): Lead {
  if (!lead.url || !/^https?:\/\//.test(lead.url)) throw new Error("A lead needs the URL it was fetched from (LEAD-2)")
  if (!lead.fetch_method) throw new Error("A lead needs a fetch record (LEAD-2)")
  const all = readLeads(file)
  const full: Lead = { ...lead, fetched_at: lead.fetched_at ?? nowIso() }
  all[lead.key] = full
  writeJson(file, all)
  return full
}

/**
 * Contact routes the poster published themselves (LEAD-6): emails and handles that
 * appear verbatim in the post text. Nothing is guessed or enriched.
 */
export function publishedContactRoutes(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(m[0])
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    if (/(apply|careers|jobs|calendly|forms\.gle|docs\.google\.com\/forms|lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com)/i.test(m[0])) out.add(m[0])
  }
  for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_]{3,32})\b/g)) out.add("@" + m[1])
  return [...out].slice(0, 10)
}
