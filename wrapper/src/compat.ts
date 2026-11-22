// `jobdesk compat` (C-1..C-5): proves the original framework is untouched and still green.
//   C-1  no upstream-tracked framework file changed by the wrapper
//   C-2  (with --merge) the upstream branch merges into HEAD with no conflicts in wrapper paths
//   C-3  upstream's own CI checks pass
//   C-5  wrapper paths are separable: wrapper-data is ignored, nothing upstream imports wrapper/

import { run, pythonBin } from "./lib/exec.ts"
import type { Paths } from "./lib/paths.ts"

/** Personal-data files upstream itself tells the user (and /apply, /setup) to edit. */
export const PERSONAL_FILES = [
  /^\.claude\/skills\/job-application-assistant\/0[1-6]-[a-z-]+\.md$/,
  /^\.claude\/skills\/job-scraper\/search-queries\.md$/,
  /^CLAUDE\.md$/,
  /^job_search_tracker\.csv$/,
  /^cv\//, /^cover_letters\//, /^documents\//, /^company_research\//,
  // Changes a fork makes through upstream's own documented /add-portal path.
  /^\.claude\/settings\.json$/, /^tools\/security_guards\.py$/,
]
/**
 * Upstream tests that assert the BLANK profile template. They fail in any clone where the user has
 * filled in 01-candidate-profile.md (which /setup itself does). Listed by exact name.
 */
export const EXPECTED_PERSONAL_FAILURES = new Set(["test_pristine_profile_carries_the_sentinel", "test_full_file_skeletons_keep_the_shipped_headings"])

export const WRAPPER_PATHS = [/^wrapper\//, /^wrapper-data\//, /^docs\/wrapper-[a-z-]+\.md$/, /^\.agents\/skills\/[a-z0-9-]+-search\//]

export interface CompatResult {
  ok: boolean
  checks: { name: string; ok: boolean; detail: string }[]
}

export async function compat(p: Paths, o: { merge?: boolean; upstream?: string; log?: (s: string) => void } = {}): Promise<CompatResult> {
  const log = o.log ?? (() => {})
  const checks: CompatResult["checks"] = []
  const git = (args: string[]) => run("git", args, { cwd: p.root, timeoutMs: 120_000 })

  const st = await git(["status", "--porcelain", "--untracked-files=no"])
  const modified = st.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim().replace(/\\/g, "/"))
  const framework = modified.filter((f) => !PERSONAL_FILES.some((r) => r.test(f)) && !WRAPPER_PATHS.some((r) => r.test(f)))
  checks.push({ name: "C-1 framework files unchanged", ok: framework.length === 0, detail: framework.length ? `changed: ${framework.join(", ")}` : `${modified.length} tracked change(s), all personal data or fork customisation` })

  const ign = await git(["check-ignore", "-q", "wrapper-data/answer_bank.json"])
  checks.push({ name: "C-5 wrapper-data is never committed", ok: ign.code === 0, detail: ign.code === 0 ? "ignored by wrapper-data/.gitignore" : "wrapper-data is NOT ignored" })

  const grep = await git(["grep", "-l", "-E", "wrapper/(src|bin)", "--", ".claude", "tools", ".agents"])
  const refs = grep.stdout.split(/\r?\n/).filter((f) => f && !WRAPPER_PATHS.some((r) => r.test(f.replace(/\\/g, "/"))))
  checks.push({ name: "C-5 framework doesn't depend on the wrapper", ok: refs.length === 0, detail: refs.length ? `references in ${refs.join(", ")}` : "no framework file imports wrapper code" })

  const ci: [string, string[]][] = [
    ["lint_skills", [pythonBin(), "tools/lint_skills.py"]],
    ["check_framework_version", [pythonBin(), "tools/check_framework_version.py"]],
    ["security_guards", [pythonBin(), "tools/security_guards.py"]],
    ["unit tests", [pythonBin(), "-m", "unittest", "discover", "-s", "tests"]],
  ]
  for (const [name, cmd] of ci) {
    log(`running ${name}...`)
    const r = await run(cmd[0], cmd.slice(1), { cwd: p.root, timeoutMs: 600_000 })
    const out = r.stdout + r.stderr
    const tail = out.trim().split(/\r?\n/).slice(-3).join(" | ")
    if (r.code === 0) {
      checks.push({ name: `C-3 ${name}`, ok: true, detail: tail.slice(0, 300) })
      continue
    }
    // Failures that exist only because the user filled in their own profile in a clone of the
    // template repo (these tests assert the blank template). Named exactly; anything else fails.
    const failing = [...out.matchAll(/^(?:FAIL|ERROR): (\w+)/gm)].map((m) => m[1])
    const versionFiles = [...out.matchAll(/- (\S+): modified without bumping/g)].map((m) => m[1].replace(/\\/g, "/"))
    const expectedTests = failing.length > 0 && failing.every((f) => EXPECTED_PERSONAL_FAILURES.has(f))
    const expectedVersion = name === "check_framework_version" && versionFiles.length > 0 && versionFiles.every((f) => PERSONAL_FILES.some((re) => re.test(f)))
    if (expectedTests || expectedVersion) {
      checks.push({ name: `C-3 ${name}`, ok: true, detail: `expected for a personalised profile (not caused by jobdesk): ${expectedTests ? failing.join(", ") : versionFiles.join(", ")}` })
    } else checks.push({ name: `C-3 ${name}`, ok: false, detail: tail.slice(0, 300) })
  }

  if (o.merge) {
    const up = o.upstream ?? "origin/master"
    await git(["fetch", "--quiet", up.split("/")[0]])
    const mt = await git(["merge-tree", "--write-tree", "--name-only", "HEAD", up])
    const conflicted = mt.code === 0 ? [] : mt.stdout.split(/\r?\n/).slice(1).filter((l) => l && !l.startsWith("Auto-merging") && !l.startsWith("CONFLICT"))
    const inWrapper = conflicted.filter((f) => WRAPPER_PATHS.some((r) => r.test(f)))
    checks.push({ name: `C-2 merge ${up}`, ok: inWrapper.length === 0, detail: mt.code === 0 ? "merges cleanly" : `conflicts outside wrapper paths: ${conflicted.filter((f) => !inWrapper.includes(f)).join(", ") || "none"}; in wrapper paths: ${inWrapper.join(", ") || "none"}` })
  }

  for (const c of checks) log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`)
  return { ok: checks.every((c) => c.ok), checks }
}
