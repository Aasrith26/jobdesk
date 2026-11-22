// Measures rules alone vs rules + model on the unseen holdout. Spends a little on the
// user's Claude login (Haiku, batched). Run by hand: bun run tests/eval-llm.ts
import { readFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { llmLabels } from "../src/safety/llm.ts"
import { detectScam } from "../src/safety/scam.ts"
import { detectDiscrimination } from "../src/safety/discrimination.ts"
import { classifyEmail } from "../src/inbox.ts"
import { DEFAULT_CONFIG } from "../src/data/config.ts"
import { findRoot } from "../src/lib/paths.ts"

const H = join(import.meta.dir, "fixtures", "holdout")
const root = findRoot()
const ledger = join(mkdtempSync(join(tmpdir(), "jobdesk-eval-")), "costs.jsonl")
const cfg = { ...DEFAULT_CONFIG, monthly_budget_usd: 3 }
let total = 0

async function bin(file: string, kind: "scam" | "discrimination", pos: string, rule: (t: string) => boolean) {
  const xs = JSON.parse(readFileSync(join(H, file), "utf8")) as { id: string; label: string; text: string }[]
  const r = await llmLabels({ root, ledger, cfg, kind, items: xs })
  total += r.usd
  for (const [name, pred] of [
    ["rules", (x: { id: string; text: string }) => rule(x.text)],
    ["model", (x: { id: string; text: string }) => r.labels[x.id] === pos],
    ["rules OR model", (x: { id: string; text: string }) => rule(x.text) || r.labels[x.id] === pos],
  ] as const) {
    let tp = 0, fp = 0, fn = 0, tn = 0
    for (const x of xs) {
      const y = pred(x), t = x.label === pos
      if (y && t) tp++; else if (y) fp++; else if (t) fn++; else tn++
    }
    console.log(`${kind.padEnd(15)} ${name.padEnd(15)} recall ${((tp / (tp + fn)) * 100).toFixed(1)}%  fp ${((fp / (fp + tn)) * 100).toFixed(1)}%  (labelled ${Object.keys(r.labels).length}/${xs.length})`)
  }
}

await bin("scam_holdout.json", "scam", "scam", (t) => detectScam(t).flagged)
await bin("discrimination_holdout.json", "discrimination", "discriminatory", (t) => detectDiscrimination(t).flagged)
const mail = JSON.parse(readFileSync(join(H, "email_holdout.json"), "utf8")) as { id: string; label: string; subject: string; body: string }[]
const r = await llmLabels({ root, ledger, cfg, kind: "email", items: mail.map((m) => ({ id: m.id, text: `Subject: ${m.subject}\n\n${m.body}` })) })
total += r.usd
const rulesAcc = mail.filter((m) => classifyEmail(m.subject, m.body).label === m.label).length / mail.length
const modelAcc = mail.filter((m) => (r.labels[m.id] ?? classifyEmail(m.subject, m.body).label) === m.label).length / mail.length
console.log(`email           rules           accuracy ${(rulesAcc * 100).toFixed(1)}%`)
console.log(`email           model (+rules fallback) accuracy ${(modelAcc * 100).toFixed(1)}%  (labelled ${Object.keys(r.labels).length}/${mail.length})`)
console.log(`cost: $${total.toFixed(3)}`)
