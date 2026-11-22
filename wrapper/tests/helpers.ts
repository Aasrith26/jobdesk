import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { paths, ensureDataDir, type Paths } from "../src/lib/paths.ts"

export const HEADER = "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline"

export const PROFILE = `# Candidate Profile

## Identity
- **Name:** Test Person
- **Location:** Hyderabad, India
- **Phone:** +91-90000-00000
- **Email:** test.person@example.com
- **LinkedIn:** linkedin.com/in/test-person
- **GitHub:** github.com/testperson

## Technical Skills
- **Primary:** Python, LLM, RAG, vLLM, FastAPI
`

/** A throwaway workspace that looks like an ai-job-search checkout (data only). */
export function tmpWorkspace(rows: string[] = [], seen: Record<string, unknown> = {}): Paths {
  const root = mkdtempSync(join(tmpdir(), "jobdesk-test-"))
  writeFileSync(join(root, "job_search_tracker.csv"), [HEADER, ...rows].join("\n") + "\n")
  mkdirSync(join(root, "job_scraper"), { recursive: true })
  writeFileSync(join(root, "job_scraper", "seen_jobs.json"), JSON.stringify({ seen }, null, 2))
  mkdirSync(join(root, ".claude", "skills", "job-application-assistant"), { recursive: true })
  writeFileSync(join(root, ".claude", "skills", "job-application-assistant", "01-candidate-profile.md"), PROFILE)
  mkdirSync(join(root, "documents", "applications"), { recursive: true })
  mkdirSync(join(root, "cv"), { recursive: true })
  const p = paths(root)
  ensureDataDir(p)
  return p
}

/** Smallest valid PDF, enough for a file upload. */
export const TINY_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
