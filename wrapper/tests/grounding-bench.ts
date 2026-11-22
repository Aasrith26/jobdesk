// Release item 4: zero invented claims across 10 postings x 3 personas. For each persona workspace
// (from tests/personas.ts), draft a message for 10 real scraped postings with jobdesk's own
// drafter (which checks itself), then have a separate, stronger model judge every finished draft
// against the profile. Spends a little on the user's Claude login.
//   bun run tests/grounding-bench.ts <persona workspace dir>...
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../src/lib/paths.ts"
import { readConfig } from "../src/data/config.ts"
import { readLeads } from "../src/data/leads.ts"
import { scan } from "../src/scan.ts"
import { draftDm } from "../src/outreach.ts"
import { runClaude } from "../src/lib/claude.ts"

const rows: Record<string, unknown>[] = []
let cost = 0
for (const dir of process.argv.slice(2)) {
  const p = paths(dir)
  const cfg = { ...readConfig(p.config), monthly_budget_usd: 10 }
  if (Object.keys(readLeads(p.leads)).length < 10) {
    const s = await scan(p, cfg, { portals: ["linkedin-search", "shine-search"], perPortal: 8 })
    console.error(`${dir}: topped up ${s.added.length}`)
  }
  const profile = readFileSync(p.profile, "utf8")
  const name = profile.match(/\*\*Name:\*\*\s*(.+)/)?.[1] ?? dir
  const offset = Number(process.env.OFFSET ?? 0)
  const leads = Object.values(readLeads(p.leads)).filter((l) => l.text_excerpt).slice(offset, offset + Number(process.env.COUNT ?? 10))
  for (const l of leads) {
    const d = await draftDm(p, cfg, l.key)
    cost += d.usd
    let unsupported: string[] = []
    if (d.ok) {
      const prompt = `Compare the MESSAGE with the PROFILE. List every factual claim about the candidate in the MESSAGE that the PROFILE does not support (skills, employers, years, numbers, education, responsibilities, availability, language levels, alignment claims). Facts about the job or employer don't count. Reply with ONLY JSON: {"unsupported": ["..."]}.\n\nPROFILE:\n${profile}\n\nMESSAGE:\n${d.text}`
      const j = await runClaude({ root: p.root, ledger: p.costs, cfg: { ...cfg, tier: "standard" }, task: "evaluate", prompt, allowedTools: [] })
      cost += j.usd
      try {
        unsupported = JSON.parse(j.text.match(/\{[\s\S]*\}/)?.[0] ?? '{"unsupported":["(unreadable)"]}').unsupported
      } catch {
        unsupported = ["(judge reply unreadable)"]
      }
    }
    const row = { persona: name, posting: `${l.title} @ ${l.company}`, drafted: d.ok, refused: d.ok ? null : d.error, words: d.ok ? d.text.split(/\s+/).length : 0, unsupported }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
}
const drafted = rows.filter((r) => r.drafted)
const summary = { postings: rows.length, drafted: drafted.length, refused: rows.length - drafted.length, drafts_with_unsupported_claims: drafted.filter((r) => (r.unsupported as string[]).length).length, cost_usd: Number(cost.toFixed(2)) }
console.log("SUMMARY " + JSON.stringify(summary))
mkdirSync(join(import.meta.dir, "benchmarks"), { recursive: true })
writeFileSync(join(import.meta.dir, "benchmarks", `${process.env.BENCH_OUT ?? "grounding"}_2026-11-11.json`), JSON.stringify({ summary, rows }, null, 2))
