// Manual check, never run in CI: dry-run the filler on real public ATS forms with a TEST
// identity and a dummy PDF. Nothing is submitted. Usage: bun run tests/dryrun-real.ts <url>...
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpWorkspace, TINY_PDF } from "./helpers.ts"
import { fillApplication } from "../src/fill/runner.ts"
import { readConfig } from "../src/data/config.ts"
import { seedFromProfile, setAnswer } from "../src/data/answers.ts"

for (const url of process.argv.slice(2)) {
  const p = tmpWorkspace()
  const cv = join(p.root, "cv", "Test_Resume.pdf")
  writeFileSync(cv, TINY_PDF)
  seedFromProfile(p.answers, p.profile)
  setAnswer(p.answers, { key: "first_name", answer: "Test" })
  setAnswer(p.answers, { key: "last_name", answer: "Person" })
  setAnswer(p.answers, { key: "sponsorship", answer: "No" })
  setAnswer(p.answers, { key: "relocation", answer: "Yes" })
  setAnswer(p.answers, { key: "notice_period", answer: "30 days" })
  setAnswer(p.answers, { key: "total_experience", answer: "1" })
  setAnswer(p.answers, { key: "current_company", answer: "Test Company" })
  setAnswer(p.answers, { question: "Country", answer: "India" })
  const r = await fillApplication(p, readConfig(p.config), { url, company: "Real", role: "Dry run", files: { cv }, level: "dry", headless: true })
  const c = r.card
  const total = (c?.fields.length ?? 0) + (c?.unknown.length ?? 0)
  const ok = c?.fields.filter((f) => f.source !== "FAILED").length ?? 0
  console.log(`\n${url}\n  status: ${r.status} | filled ${ok}/${total} visible required-or-known fields | unknown ${c?.unknown.length ?? 0} | stops ${c?.stops.length ?? 0} | sourceless 0 by construction`)
  for (const f of c?.fields ?? []) console.log(`   + ${f.label.slice(0, 50)} = ${f.value.slice(0, 40)} [${f.source}]`)
  for (const u of c?.unknown ?? []) console.log(`   ? ${u.slice(0, 90)}`)
  for (const s of c?.stops ?? []) console.log(`   ! ${s.slice(0, 90)}`)
}
