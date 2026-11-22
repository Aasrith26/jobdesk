// Process helpers. Python tools run with the first Python that is 3.10 or newer: `python` first
// on Windows (python3 there is the Store alias, upstream #669), `python3` first elsewhere, then
// the usual install folders. Output is forced to UTF-8.

import { spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...(opts.env ?? {}) },
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined
    child.on("error", (e) => {
      if (timer) clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr + String(e) })
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** The original framework's tools use syntax that needs Python 3.10 or newer. */
export const MIN_PYTHON: [number, number] = [3, 10]

export interface FoundPython {
  cmd: string
  version: string
  ok: boolean
}

export function parsePythonVersion(out: string): [number, number] | null {
  const m = out.match(/Python\s+(\d+)\.(\d+)/i)
  return m ? [Number(m[1]), Number(m[2])] : null
}

export function pythonIsNewEnough(v: [number, number] | null): boolean {
  return !!v && (v[0] > MIN_PYTHON[0] || (v[0] === MIN_PYTHON[0] && v[1] >= MIN_PYTHON[1]))
}

/** Where a usable Python may live, best first. PATH names come first, then the usual install folders. */
export function pythonCandidates(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  const names = platform === "win32" ? ["python", "python3", "py"] : ["python3", "python3.13", "python3.12", "python3.11", "python3.10", "python"]
  const dirs = platform === "win32"
    ? [join(home, ".local", "bin")]
    : [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, "miniforge3", "bin"), join(home, "miniconda3", "bin"), join(home, "anaconda3", "bin")]
  const exe = platform === "win32" ? ".exe" : ""
  const inDirs = dirs.flatMap((d) => names.filter((n) => n !== "py").map((n) => join(d, n + exe))).filter((f) => existsSync(f))
  return [...(env.JOBDESK_PYTHON ? [env.JOBDESK_PYTHON] : []), ...names, ...inDirs]
}

export type Probe = (cmd: string, args: string[]) => { code: number; out: string }

const spawnProbe: Probe = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, windowsHide: true })
    return { code: r.error ? 127 : (r.status ?? 1), out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
  } catch {
    return { code: 127, out: "" }
  }
}

/**
 * The first Python that is new enough. A Mac's built-in python3 is 3.9, which is on PATH ahead of
 * anything the user installs later, so the first name that runs is not always the right one.
 * When nothing is new enough, the first Python that runs is returned with ok=false, so the
 * caller can say plainly what is wrong.
 */
export function findPython(cands: string[] = pythonCandidates(), probe: Probe = spawnProbe): FoundPython | null {
  let tooOld: FoundPython | null = null
  for (const cmd of cands) {
    const r = probe(cmd, ["--version"])
    if (r.code !== 0) continue
    const v = parsePythonVersion(r.out)
    const found = { cmd, version: v ? v.join(".") : r.out.trim().slice(0, 40), ok: pythonIsNewEnough(v) }
    if (found.ok) return found
    tooOld ??= found
  }
  // uv keeps its own Pythons outside PATH.
  const uv = probe("uv", ["python", "find", `>=${MIN_PYTHON.join(".")}`])
  const uvPath = uv.code === 0 ? uv.out.trim().split(/\r?\n/)[0] : ""
  if (uvPath && existsSync(uvPath)) {
    const v = parsePythonVersion(probe(uvPath, ["--version"]).out)
    if (pythonIsNewEnough(v)) return { cmd: uvPath, version: v!.join("."), ok: true }
  }
  return tooOld
}

let cachedPython: FoundPython | null | undefined

export function resolvedPython(): FoundPython | null {
  if (cachedPython === undefined) cachedPython = findPython()
  return cachedPython
}

/** The Python command jobdesk runs tools with. Falls back to the platform's usual name. */
export function pythonBin(): string {
  return resolvedPython()?.cmd ?? (process.platform === "win32" ? "python" : "python3")
}

export function python(root: string, tool: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return run(pythonBin(), [join(root, "tools", tool), ...args], { cwd: root, ...opts })
}

/**
 * Where Claude Code may be installed. A program started from a desktop app, a scheduler or a
 * service often gets a short PATH that leaves out the folder Claude was installed into.
 */
export function claudeCandidates(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  const files = platform === "win32"
    ? [join(home, ".local", "bin", "claude.exe"), join(home, ".claude", "local", "claude.exe"), join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm", "claude.cmd")]
    : [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(home, ".npm-global", "bin", "claude"), join(home, ".bun", "bin", "claude")]
  return [...(env.JOBDESK_CLAUDE ? [env.JOBDESK_CLAUDE] : []), "claude", ...files.filter((f) => existsSync(f)), ...editorClaude(home, platform)]
}

/** Last resort: the copy that ships inside the Claude Code editor extension, newest first. */
function editorClaude(home: string, platform: string): string[] {
  const out: string[] = []
  for (const editor of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const ext = join(home, editor, "extensions")
    if (!existsSync(ext)) continue
    let names: string[] = []
    try {
      names = readdirSync(ext).filter((n) => n.startsWith("anthropic.claude-code-"))
    } catch {
      continue
    }
    for (const n of names.sort().reverse()) {
      const bin = join(ext, n, "resources", "native-binary", platform === "win32" ? "claude.exe" : "claude")
      if (existsSync(bin)) out.push(bin)
    }
  }
  return out
}

export function findClaude(cands: string[] = claudeCandidates(), probe: Probe = spawnProbe): { cmd: string; version: string } | null {
  for (const cmd of cands) {
    const r = probe(cmd, ["--version"])
    if (r.code === 0) return { cmd, version: r.out.trim().split(/\r?\n/)[0] }
  }
  return null
}

let cachedClaude: { cmd: string; version: string } | null | undefined

/** The Claude Code command, or "claude" when none was found (the run then reports it as missing). */
export function claudeBin(): string {
  if (cachedClaude === undefined) cachedClaude = findClaude()
  return cachedClaude?.cmd ?? "claude"
}

/**
 * PATH for programs that run Python by name (Claude Code runs `python3 tools/...`): the folder
 * of the Python jobdesk chose goes first, so they get the same one.
 */
export function pathWithPython(env: Record<string, string | undefined> = process.env, py: FoundPython | null = resolvedPython()): string {
  const cur = env.PATH ?? env.Path ?? ""
  if (!py?.ok || !isAbsolute(py.cmd)) return cur
  const dir = dirname(py.cmd)
  return [dir, ...cur.split(delimiter).filter((d) => d && d !== dir)].join(delimiter)
}

/** The bun binary running us (no PATH lookup needed). */
export function bunBin(): string {
  return process.execPath
}

export function portalCli(root: string, portal: string): string | null {
  const p = join(root, ".agents", "skills", portal, "cli", "src", "cli.ts")
  return existsSync(p) ? p : null
}

export function bunRun(root: string, script: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return run(bunBin(), ["run", script, ...args], { cwd: root, timeoutMs })
}
