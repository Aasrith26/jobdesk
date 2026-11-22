// Model check for new leads (SAFE-1, SAFE-2): rules flagged everything they could for free;
// here a small model labels the same texts. A warning shows when EITHER flags it - on the
// unseen holdout that reached 100% scam recall at 8% false positives (rules alone: 58%).
// Skipped quietly when model checks are off, there's no Claude login, or the budget is used.

import type { Paths } from "../lib/paths.ts"
import type { Config } from "../data/config.ts"
import { readLeads, upsertLead } from "../data/leads.ts"
import { addItem } from "../data/attention.ts"
import { llmLabels } from "./llm.ts"
import type { ClaudeExec } from "../lib/claude.ts"

/** Email labeler for processInboxFolder, or undefined when model checks are off. */
export function emailLabeler(p: Paths, cfg: Config, exec?: ClaudeExec) {
  if (!cfg.model_checks) return undefined
  return async (emails: { id: string; subject: string; body: string }[]) =>
    (await llmLabels({ root: p.root, ledger: p.costs, cfg, kind: "email", items: emails.map((e) => ({ id: e.id, text: `Subject: ${e.subject}\n\n${e.body}` })), exec })).labels
}

export async function modelCheckLeads(p: Paths, cfg: Config, keys: string[], exec?: ClaudeExec): Promise<{ checked: number; flagged: string[]; usd: number; skipped?: string }> {
  if (!cfg.model_checks) return { checked: 0, flagged: [], usd: 0, skipped: "model checks are off" }
  const leads = readLeads(p.leads)
  // News articles (funding announcements) aren't postings, so they're not checked for job scams.
  const items = keys.map((k) => leads[k]).filter((l) => l && !l.model_check && l.text_excerpt && l.lead_type !== "funded_startup" && l.portal !== "funding-news-search").map((l) => ({ id: l.key, text: `${l.title}\n${l.company}\n${l.text_excerpt}` }))
  if (!items.length) return { checked: 0, flagged: [], usd: 0 }
  const scam = await llmLabels({ root: p.root, ledger: p.costs, cfg, kind: "scam", items, exec })
  if (scam.skipped) return { checked: 0, flagged: [], usd: scam.usd, skipped: scam.skipped }
  const disc = await llmLabels({ root: p.root, ledger: p.costs, cfg, kind: "discrimination", items, exec })
  const flagged: string[] = []
  const fresh = readLeads(p.leads)
  for (const it of items) {
    const l = fresh[it.id]
    if (!l) continue
    const isScam = scam.labels[it.id] === "scam"
    const isDisc = disc.labels[it.id] === "discriminatory"
    const extra = { scam: [...l.flags.scam], discrimination: [...l.flags.discrimination] }
    if (isScam && !extra.scam.length) extra.scam.push("A model check thinks this looks like a scam. Read it carefully before sharing anything.")
    if (isDisc && !extra.discrimination.length) extra.discrimination.push("A model check thinks this posting screens people on a personal trait (age, gender, family, origin or similar).")
    const { fetched_at, ...rest } = l
    upsertLead(p.leads, { ...rest, fetched_at, flags: extra, model_check: { scam: scam.labels[it.id] ?? "unknown", discrimination: disc.labels[it.id] ?? "unknown" } })
    if ((isScam && !l.flags.scam.length) || (isDisc && !l.flags.discrimination.length)) {
      flagged.push(it.id)
      addItem(p.attention, {
        id: `flag:${it.id}`, kind: "flagged_posting", title: `${l.company}: ${l.title}`,
        why: [...extra.scam, ...extra.discrimination].join(" "), action: "Read the warning before spending time on this posting.", ref: it.id, data: { url: l.url },
      })
    }
  }
  return { checked: items.length, flagged, usd: scam.usd + disc.usd }
}
