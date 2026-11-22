// Runs upstream tools/posting_guard.py on any third-party text (LEAD-3, APP-10).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { python } from "./exec.ts"

export interface GuardResult {
  verdict: string
  clean: boolean
  findings: Record<string, unknown>
  text: string
}

export async function guard(root: string, raw: string, mode: "html" | "text" = "text"): Promise<GuardResult> {
  const dir = mkdtempSync(join(tmpdir(), "jobdesk-guard-"))
  try {
    const inFile = join(dir, "in.txt")
    const outFile = join(dir, "out.txt")
    writeFileSync(inFile, raw, "utf8")
    const r = await python(root, "posting_guard.py", ["--in", inFile, mode === "html" ? "--html" : "--text", "--json", "--out", outFile], { timeoutMs: 60_000 })
    if (r.code !== 0) throw new Error(`posting_guard failed: ${r.stderr.trim() || r.stdout.trim()}`)
    const verdict = r.stdout.split(/\r?\n/)[0]?.trim() ?? ""
    const jsonStart = r.stdout.indexOf("{")
    const jsonEnd = r.stdout.lastIndexOf("}")
    let findings: Record<string, unknown> = {}
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        findings = JSON.parse(r.stdout.slice(jsonStart, jsonEnd + 1))
      } catch {
        findings = {}
      }
    }
    let text = ""
    try {
      text = readFileSync(outFile, "utf8")
    } catch {
      const marker = r.stdout.indexOf("--- text ---")
      text = marker >= 0 ? r.stdout.slice(marker + 12).trim() : ""
    }
    return { verdict, clean: !verdict.includes("⚠"), findings, text }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
