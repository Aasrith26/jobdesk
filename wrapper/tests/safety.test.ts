// Thresholds from the spec, measured on independently written labelled sets.
// The first set (fixtures/*.json) was used to tune the rules; the holdout set
// (fixtures/holdout/*.json) was written afterwards and never used for tuning.

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { detectScam } from "../src/safety/scam.ts"
import { detectDiscrimination } from "../src/safety/discrimination.ts"
import { classifyEmail, extractDate } from "../src/inbox.ts"
import { fkGrade } from "../src/lib/readability.ts"
import { HELP } from "../src/bridge/bot.ts"

const F = join(import.meta.dir, "fixtures")
const load = <T>(f: string): T[] => JSON.parse(readFileSync(join(F, f), "utf8"))

function rates<T extends { label: string }>(xs: T[], pos: string, pred: (x: T) => boolean) {
  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const x of xs) {
    const y = pred(x), t = x.label === pos
    if (y && t) tp++
    else if (y) fp++
    else if (t) fn++
    else tn++
  }
  return { recall: tp / (tp + fn), fpr: fp / (fp + tn) }
}

// Tuning set: the rules were fitted to these, so they must stay at the spec thresholds.
// Unseen holdout: rules alone generalise far worse (measured below). The spec targets are met
// there by "rules OR model" (see model_eval_2026-11-11.json); these tests are a regression floor
// so the free tier never silently gets worse than what was measured.
const SETS = [
  { name: "tuning set", scam: "scam_set.json", disc: "discrimination_set.json", mail: "email_set.json", floor: { scam: 0.9, scamFp: 0.1, disc: 0.8, discFp: 0.1, mail: 0.9 } },
  { name: "unseen holdout (rules only)", scam: "holdout/scam_holdout.json", disc: "holdout/discrimination_holdout.json", mail: "holdout/email_holdout.json", floor: { scam: 0.55, scamFp: 0.1, disc: 0.5, discFp: 0.1, mail: 0.7 } },
]
for (const s of SETS) {
  const have = existsSync(join(F, s.scam))
  describe(`classifiers on the ${s.name}`, () => {
    test.skipIf(!have)("SAFE-1 scam", () => {
      const r = rates(load<{ label: string; text: string }>(s.scam), "scam", (x) => detectScam(x.text).flagged)
      console.log(`${s.name} scam recall ${(r.recall * 100).toFixed(1)}% fp ${(r.fpr * 100).toFixed(1)}%`)
      expect(r.recall).toBeGreaterThanOrEqual(s.floor.scam)
      expect(r.fpr).toBeLessThanOrEqual(s.floor.scamFp)
    })
    test.skipIf(!have)("SAFE-2 discrimination", () => {
      const r = rates(load<{ label: string; text: string }>(s.disc), "discriminatory", (x) => detectDiscrimination(x.text).flagged)
      console.log(`${s.name} discrimination recall ${(r.recall * 100).toFixed(1)}% fp ${(r.fpr * 100).toFixed(1)}%`)
      expect(r.recall).toBeGreaterThanOrEqual(s.floor.disc)
      expect(r.fpr).toBeLessThanOrEqual(s.floor.discFp)
    })
    test.skipIf(!have)("INB-1 email triage", () => {
      const xs = load<{ label: string; subject: string; body: string }>(s.mail)
      const acc = xs.filter((x) => classifyEmail(x.subject, x.body).label === x.label).length / xs.length
      console.log(`${s.name} email accuracy ${(acc * 100).toFixed(1)}%`)
      expect(acc).toBeGreaterThanOrEqual(s.floor.mail)
    })
  })
}

describe("recorded model check on the unseen holdout", () => {
  const f = join(F, "holdout", "model_eval_2026-11-11.json")
  test.skipIf(!existsSync(f))("rules OR model meets SAFE-1/SAFE-2; model meets INB-1", () => {
    const m = JSON.parse(readFileSync(f, "utf8"))
    expect(m.scam.rules_or_model.recall).toBeGreaterThanOrEqual(0.9)
    expect(m.scam.rules_or_model.fpr).toBeLessThanOrEqual(0.1)
    expect(m.discrimination.rules_or_model.recall).toBeGreaterThanOrEqual(0.8)
    expect(m.email.model.accuracy).toBeGreaterThanOrEqual(0.9)
  })
})

describe("dates and readability", () => {
  test("extracts explicit dates in common formats", () => {
    expect(extractDate("due by Thursday, 26 November 2026")).toBe("2026-11-26")
    expect(extractDate("deadline Dec 3, 2026 5 PM")).toBe("2026-12-03")
    expect(extractDate("submit by 2026-12-01")).toBe("2026-12-01")
    expect(extractDate("no date here")).toBeNull()
  })
  test("INC-5: bot help reads at grade 8 or below", () => {
    expect(fkGrade(HELP)).toBeLessThanOrEqual(8)
  })
})
