// Filling benchmark (release item 6) on real public ATS forms. DRY RUN ONLY: nothing is ever
// submitted. Uses a TEST identity with a realistic answer bank - the generic answers a candidate
// builds up after a few applications. Employer-specific questions stay unknown by design.
//   bun run tests/benchmark-forms.ts > benchmark.log
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpWorkspace, TINY_PDF } from "./helpers.ts"
import { fillApplication } from "../src/fill/runner.ts"
import { readConfig } from "../src/data/config.ts"
import { seedFromProfile, setAnswer } from "../src/data/answers.ts"
import { makeDrafter } from "../src/fill/drafts.ts"

export const FORMS = [
  "https://job-boards.greenhouse.io/anthropic/jobs/5391381008",
  "https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited/jobs/4747985005",
  "https://job-boards.greenhouse.io/gitlab/jobs/8704363002",
  "https://job-boards.greenhouse.io/figma/jobs/5458801004",
  "https://job-boards.greenhouse.io/cloudflare/jobs/8287256",
  "https://job-boards.greenhouse.io/databricks/jobs/8880398002",
  "https://job-boards.greenhouse.io/stripe/jobs/8332467",
  "https://job-boards.greenhouse.io/airbnb/jobs/7789554",
  "https://job-boards.greenhouse.io/coinbase/jobs/8093264",
  "https://job-boards.greenhouse.io/datadog/jobs/6652564",
  "https://job-boards.greenhouse.io/groww/jobs/4970739101",
  "https://job-boards.greenhouse.io/hackerrank/jobs/7567121",
  "https://jobs.lever.co/palantir/10dfc8bc-99ad-4ca2-ab76-853cb90a92c2",
  "https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd",
  "https://jobs.lever.co/cred/aa98a938-af3a-45f5-851d-966b2b5bad33",
  "https://jobs.lever.co/meesho/7d9af9b5-c1c7-48ec-bbb5-9b25e49f6596",
  "https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3",
  "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245",
  "https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff",
  "https://jobs.ashbyhq.com/notion/1fc309c8-da20-4ff2-84c7-8b863ece2b0a",
]

const GENERIC: [string, string][] = [
  ["first_name", "Test"], ["last_name", "Person"], ["sponsorship", "No"], ["work_authorization", "Yes"],
  ["relocation", "Yes"], ["notice_period", "30 days"], ["current_company", "Test Company"], ["current_title", "AI Engineer"],
  ["total_experience", "1"], ["expected_ctc", "18 LPA"], ["current_ctc", "12 LPA"], ["heard_about", "LinkedIn"],
  ["website", "https://example.com/portfolio"], ["remote_ok", "Yes"],
  // Generic facts a user gives once, then every form reuses:
  ["citizenship", "India"], ["onsite_ok", "Yes"], ["non_compete", "No"], ["postal_code", "500001"],
]

/** A fictional but complete profile, so derived answers and drafts have real facts to work from. */
const BENCH_PROFILE = `# Candidate Profile

## Identity
- **Name:** Test Person
- **Location:** Hyderabad, India
- **Phone:** +91-90000-00000
- **Email:** test.person@example.com
- **LinkedIn:** linkedin.com/in/test-person
- **GitHub:** github.com/testperson

## Education
- B.E. Computer Science, Test Institute of Technology, Hyderabad (2019 - 2023)

## Professional Experience
### AI Engineer - Test Company, Hyderabad (Jan 2024 - Present)
- Built a retrieval-augmented search service over 40,000 support documents with Python, FastAPI and pgvector.
- Shipped a real-time voice assistant prototype using streaming speech-to-text and an open LLM.
- Moved model serving from a paid API to a self-hosted vLLM deployment.

## Independent Projects
- Open-source resume parser in Python with 300 GitHub stars.

## Technical Skills
- **Primary:** Python, FastAPI, PostgreSQL, pgvector, vLLM, PyTorch, Docker, AWS (EC2, S3)

## Publications
- pending

## Awards
- Winner, Test Institute hackathon (2022)

## References
- pending
`

const results: Record<string, unknown>[] = []
const LIST = process.argv.slice(2).length ? process.argv.slice(2) : FORMS
for (const url of LIST) {
  const p = tmpWorkspace()
  const cv = join(p.root, "cv", "Test_Resume.pdf")
  writeFileSync(cv, TINY_PDF)
  writeFileSync(p.profile, BENCH_PROFILE)
  seedFromProfile(p.answers, p.profile)
  for (const [key, answer] of GENERIC) setAnswer(p.answers, { key, answer })
  setAnswer(p.answers, { question: "Country", answer: "India" })
  const cfg = { ...readConfig(p.config), monthly_budget_usd: 5 }
  const t0 = Date.now()
  let r
  try {
    r = await fillApplication(p, cfg, {
      url, company: new URL(url).pathname.split("/")[1], role: "benchmark", files: { cv }, level: "dry", headless: true,
      draftOpenAnswers: process.env.NO_DRAFTS ? undefined : makeDrafter(p, cfg),
    })
  } catch (e) {
    console.log(`\n${url}\n  ERROR ${(e as Error).message}`)
    results.push({ url, error: (e as Error).message })
    continue
  }
  const c = r.card
  const filled = c?.fields ?? []
  const ok = filled.filter((f) => f.source !== "FAILED")
  const failed = filled.filter((f) => f.source === "FAILED")
  const unknown = c?.unknown ?? []
  const answerable = filled.length + unknown.length
  const row = { url, drafted: ok.filter((f) => f.source.startsWith("DRAFT")).length, derived: ok.filter((f) => f.source.startsWith("derived")).length, status: r.status, seconds: Math.round((Date.now() - t0) / 1000), filled_ok: ok.length, failed: failed.length, unknown: unknown.length, stops: c?.stops.length ?? 0, coverage: answerable ? ok.length / answerable : null, correctness: filled.length ? ok.length / filled.length : null, sourceless: filled.filter((f) => !f.source).length }
  results.push(row)
  console.log(`\n${url}\n  ${JSON.stringify(row)}`)
  for (const f of filled) console.log(`   ${f.source === "FAILED" ? "x" : "+"} ${f.label.slice(0, 60)} = ${f.value.slice(0, 40)} [${f.source}]`)
  for (const u of unknown) console.log(`   ? ${u.slice(0, 100)}`)
  for (const s of c?.stops ?? []) console.log(`   ! ${s.slice(0, 100)}`)
}
const done = results.filter((r) => typeof r.coverage === "number") as { coverage: number; correctness: number; filled_ok: number; failed: number; unknown: number; sourceless: number }[]
const sum = (k: "filled_ok" | "failed" | "unknown" | "sourceless") => done.reduce((s, r) => s + r[k], 0)
const summary = {
  forms: LIST.length, ran: done.length, kit_only: results.filter((r) => r.status === "kit_only").length,
  drafted_open_answers: done.reduce((s, r) => s + ((r as unknown as { drafted: number }).drafted ?? 0), 0), derived_answers: done.reduce((s, r) => s + ((r as unknown as { derived: number }).derived ?? 0), 0),
  filled_ok: sum("filled_ok"), failed_flagged: sum("failed"), unknown_to_user: sum("unknown"), sourceless: sum("sourceless"), submitted: 0,
  pooled_coverage: sum("filled_ok") / (sum("filled_ok") + sum("failed") + sum("unknown")),
  pooled_correctness_of_attempts: sum("filled_ok") / (sum("filled_ok") + sum("failed")),
}
console.log(`\nSUMMARY ${JSON.stringify(summary)}`)
const out = join(import.meta.dir, "benchmarks")
mkdirSync(out, { recursive: true })
writeFileSync(join(out, `${process.env.BENCH_NAME ?? "forms"}_2026-11-11.json`), JSON.stringify({ note: "Dry runs only, test identity, generic answer bank. See tests/benchmark-forms.ts.", summary, results }, null, 2))
