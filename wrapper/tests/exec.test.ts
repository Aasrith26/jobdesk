import { describe, expect, test } from "bun:test"
import { delimiter } from "node:path"
import { findPython, findClaude, parsePythonVersion, pythonIsNewEnough, pathWithPython, pythonCandidates, type Probe } from "../src/lib/exec.ts"
import { doctor } from "../src/doctor.ts"

/** A pretend machine: which commands exist and what `--version` prints. */
const machine = (versions: Record<string, string>): Probe => (cmd, args) => {
  if (cmd === "uv") return versions.uv && args[0] === "python" ? { code: 0, out: versions.uv } : { code: 127, out: "" }
  return cmd in versions ? { code: 0, out: versions[cmd] } : { code: 127, out: "" }
}

describe("finding Python and Claude (ONB-5, ONB-6)", () => {
  test("version parsing and the 3.10 floor", () => {
    expect(parsePythonVersion("Python 3.9.6")).toEqual([3, 9])
    expect(parsePythonVersion("nonsense")).toBeNull()
    expect(pythonIsNewEnough([3, 9])).toBe(false)
    expect(pythonIsNewEnough([3, 10])).toBe(true)
    expect(pythonIsNewEnough([4, 0])).toBe(true)
    expect(pythonIsNewEnough(null)).toBe(false)
  })
  test("a Mac's built-in python3 (3.9) is passed over for a newer one further down", () => {
    const found = findPython(["python3", "python3.12", "/opt/homebrew/bin/python3"], machine({ python3: "Python 3.9.6", "/opt/homebrew/bin/python3": "Python 3.13.1" }))
    expect(found).toEqual({ cmd: "/opt/homebrew/bin/python3", version: "3.13", ok: true })
  })
  test("when every Python is too old, that one is reported as not good enough - never as fine", () => {
    const found = findPython(["python3"], machine({ python3: "Python 3.9.6" }))
    expect(found).toEqual({ cmd: "python3", version: "3.9", ok: false })
    expect(findPython(["python3"], machine({}))).toBeNull()
  })
  test("JOBDESK_PYTHON is tried first", () => {
    expect(pythonCandidates({ JOBDESK_PYTHON: "/my/python", HOME: "/nonexistent" }, "linux")[0]).toBe("/my/python")
    expect(pythonCandidates({ HOME: "/nonexistent" }, "win32")[0]).toBe("python")
    expect(pythonCandidates({ HOME: "/nonexistent" }, "linux")[0]).toBe("python3")
  })
  test("Claude Code is found outside PATH", () => {
    expect(findClaude(["claude", "/home/u/.local/bin/claude"], machine({ "/home/u/.local/bin/claude": "2.1.0 (Claude Code)" }))).toEqual({ cmd: "/home/u/.local/bin/claude", version: "2.1.0 (Claude Code)" })
    expect(findClaude(["claude"], machine({}))).toBeNull()
  })
  test("programs jobdesk starts get the chosen Python first on PATH", () => {
    const path = pathWithPython({ PATH: ["/usr/bin", "/opt/py/bin", "/bin"].join(delimiter) }, { cmd: "/opt/py/bin/python3", version: "3.12", ok: true })
    expect(path.split(delimiter)).toEqual(["/opt/py/bin", "/usr/bin", "/bin"])
    // A bare name is already on PATH; a Python that's too old is never promoted.
    expect(pathWithPython({ PATH: "/usr/bin" }, { cmd: "python3", version: "3.12", ok: true })).toBe("/usr/bin")
    expect(pathWithPython({ PATH: "/usr/bin" }, { cmd: "/old/python3", version: "3.9", ok: false })).toBe("/usr/bin")
  })
  test("doctor on this machine: the Python it approves really can run the framework's tools", async () => {
    const py = (await doctor()).find((c) => c.name === "Python")!
    if (!py.ok) {
      expect(py.detail).toMatch(/too old|not found/)
      return
    }
    const cmd = py.detail.match(/\((.+)\)$/)![1]
    const r = Bun.spawnSync([cmd, "-c", "import sys; x: int | None = None; sys.exit(0 if sys.version_info >= (3, 10) else 1)"])
    expect(r.exitCode).toBe(0)
  })
})
