// Measures the rule-based classifiers on the independently written labelled sets.
// Items are split by position: even = "tune" (rules may be adjusted while looking at these),
// odd = "held-out" (never inspected while tuning). Both numbers are reported.
//   bun run tests/eval.ts [--misses]

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { detectScam } from "../src/safety/scam.ts"
import { detectDiscrimination } from "../src/safety/discrimination.ts"
import { classifyEmail } from "../src/inbox.ts"

const F = join(import.meta.dir, "fixtures")
const load = <T>(f: string) => JSON.parse(readFileSync(join(F, f), "utf8")) as T[]
const showMisses = process.argv.includes("--misses")

export function binary(name: string, items: { id: string; label: string; text: string }[], pos: string, pred: (t: string) => boolean, split: "tune" | "held") {
  const xs = items.filter((_, i) => (split === "tune" ? i % 2 === 0 : i % 2 === 1))
  let tp = 0, fp = 0, fn = 0, tn = 0
  const misses: string[] = []
  for (const x of xs) {
    const y = pred(x.text)
    const t = x.label === pos
    if (y && t) tp++
    else if (y && !t) { fp++; misses.push(`FP ${x.id}`) }
    else if (!y && t) { fn++; misses.push(`FN ${x.id}`) }
    else tn++
  }
  return { name, split, n: xs.length, recall: tp / (tp + fn), fpr: fp / (fp + tn), misses }
}

export function multi(items: { id: string; label: string; subject: string; body: string }[], split: "tune" | "held") {
  const xs = items.filter((_, i) => (split === "tune" ? i % 2 === 0 : i % 2 === 1))
  let ok = 0
  const misses: string[] = []
  for (const x of xs) {
    const y = classifyEmail(x.subject, x.body).label
    if (y === x.label) ok++
    else misses.push(`${x.id} want=${x.label} got=${y}`)
  }
  return { name: "email triage", split, n: xs.length, accuracy: ok / xs.length, misses }
}

if (import.meta.main) {
  const scam = load<{ id: string; label: string; text: string }>("scam_set.json")
  const disc = load<{ id: string; label: string; text: string }>("discrimination_set.json")
  const mail = load<{ id: string; label: string; subject: string; body: string }>("email_set.json")
  for (const split of ["tune", "held"] as const) {
    const s = binary("scam", scam, "scam", (t) => detectScam(t).flagged, split)
    const d = binary("discrimination", disc, "discriminatory", (t) => detectDiscrimination(t).flagged, split)
    const m = multi(mail, split)
    console.log(`${split.padEnd(5)} scam: recall ${(s.recall * 100).toFixed(1)}% fp ${(s.fpr * 100).toFixed(1)}% (n=${s.n})`)
    console.log(`${split.padEnd(5)} discrimination: recall ${(d.recall * 100).toFixed(1)}% fp ${(d.fpr * 100).toFixed(1)}% (n=${d.n})`)
    console.log(`${split.padEnd(5)} email: accuracy ${(m.accuracy * 100).toFixed(1)}% (n=${m.n})`)
    if (showMisses && split === "tune") console.log([...s.misses, ...d.misses, ...m.misses].join("\n"))
  }
}
