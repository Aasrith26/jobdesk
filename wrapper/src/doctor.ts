// `jobdesk doctor` and `jobdesk bootstrap` (ONB-5, ONB-6): what's installed, what's missing,
// and the one command that fixes each gap - in plain words. Bootstrap only runs official
// installers after the user says yes.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { run, resolvedPython, findClaude, MIN_PYTHON } from "./lib/exec.ts"

export interface Check {
  name: string
  ok: boolean
  detail: string
  fix?: string
  required: boolean
}

const WIN = process.platform === "win32"

async function has(cmd: string, args = ["--version"]): Promise<string | null> {
  const r = await run(cmd, args, { timeoutMs: 15_000 })
  return r.code === 0 ? (r.stdout || r.stderr).trim().split(/\r?\n/)[0] : null
}

export function findBrowser(): string | null {
  const env = process.env.JOBDESK_BROWSER
  if (env && existsSync(env)) return env
  const cands = WIN
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
      ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"]
  return cands.find((c) => c && existsSync(c)) ?? null
}

export async function doctor(): Promise<Check[]> {
  const checks: Check[] = []
  checks.push({ name: "bun", ok: true, detail: `bun ${Bun.version}`, required: true })
  const uvFix = !!(await has("uv"))
  const py = resolvedPython()
  const need = MIN_PYTHON.join(".")
  checks.push({
    name: "Python",
    ok: !!py?.ok,
    detail: !py ? "not found" : py.ok ? `Python ${py.version} (${py.cmd})` : `Python ${py.version} is too old. jobdesk needs ${need} or newer, so searching for jobs will not work.`,
    fix: WIN ? "uv python install 3.12" : (uvFix ? "uv python install 3.12" : "curl -LsSf https://astral.sh/uv/install.sh | sh && $HOME/.local/bin/uv python install 3.12"),
    required: true,
  })
  if (py?.ok) {
    const pypdf = await run(py.cmd, ["-c", "import pypdf;print(pypdf.__version__)"], { timeoutMs: 15_000 })
    checks.push({ name: "pypdf (reads PDF resumes)", ok: pypdf.code === 0, detail: pypdf.code === 0 ? pypdf.stdout.trim() : "missing", fix: `${py.cmd} -m pip install pypdf`, required: false })
  }
  const claude = findClaude()
  checks.push({ name: "Claude Code", ok: !!claude, detail: claude ? `${claude.version} (${claude.cmd})` : "not found. Only the free features will work.", fix: "Install it from https://claude.com/claude-code, then run: claude", required: false })
  // install.sh puts Tectonic in ~/.local/bin, which isn't always on PATH.
  const tex = (await has("tectonic")) ?? (await has(join(process.env.HOME ?? "", ".local", "bin", "tectonic"))) ?? (await has("lualatex")) ?? (await has("xelatex")) ?? (await has("pdflatex"))
  checks.push({
    name: "LaTeX (to make PDFs)", ok: !!tex, detail: tex ?? "not found",
    fix: WIN ? 'powershell -c "irm https://drop-ps1.fullyjustified.net | iex"' : "sh wrapper/install.sh --latex",
    required: false,
  })
  const uv = await has("uv")
  checks.push({ name: "uv (installs Python for you)", ok: !!uv, detail: uv ?? "not found", fix: WIN ? 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"' : "curl -LsSf https://astral.sh/uv/install.sh | sh", required: false })
  const browser = findBrowser()
  checks.push({ name: "Chrome or Edge (for form filling)", ok: !!browser, detail: browser ?? "not found", fix: "Install Google Chrome or Microsoft Edge", required: false })
  return checks
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) => `${c.ok ? "OK  " : c.required ? "NEED" : "OPT "} ${c.name}: ${c.detail}${!c.ok && c.fix ? `\n      Fix: ${c.fix}` : ""}`)
  const missing = checks.filter((c) => !c.ok && c.required)
  lines.push("", missing.length ? `${missing.length} required item(s) missing. Run the "Fix" commands above, or: jobdesk bootstrap --yes` : "Everything required is installed.")
  return lines.join("\n")
}

/** Runs the official installer for each missing item. Only called with --yes. */
export async function bootstrap(checks: Check[], log: (s: string) => void): Promise<void> {
  for (const c of checks.filter((x) => !x.ok && x.fix && !x.fix.startsWith("Install "))) {
    const cmd = c.fix!.split("   (")[0]
    log(`Installing ${c.name}: ${cmd}`)
    const r = WIN && cmd.startsWith("powershell") ? await run("powershell", ["-NoProfile", "-Command", cmd.replace(/^powershell -c "|"$/g, "")], { timeoutMs: 600_000 }) : await run("sh", ["-c", cmd], { timeoutMs: 600_000 })
    log(r.code === 0 ? `  done` : `  failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
  }
}
