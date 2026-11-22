// `jobdesk autostart on|off`: run `jobdesk start` when the user logs in, so the bot keeps answering
// after a reboot. macOS: a LaunchAgent. Linux: a systemd user service. Both are per-user, need no
// admin rights, and are removed again by `autostart off`.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Paths } from "./lib/paths.ts"
import { run } from "./lib/exec.ts"

export const LABEL = "dev.jobdesk.service"

export interface AutostartPlan {
  file: string
  content: string
  on: string[][]
  off: string[][]
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function plan(p: Paths, o: { bun: string; platform?: string; home?: string; uid?: number; path?: string } ): AutostartPlan | null {
  const platform = o.platform ?? process.platform
  const home = o.home ?? homedir()
  const script = join(p.root, "wrapper", "bin", "jobdesk.ts")
  const log = join(p.runs, "service.log")
  const path = o.path ?? process.env.PATH ?? ""
  if (platform === "darwin") {
    const file = join(home, "Library", "LaunchAgents", `${LABEL}.plist`)
    const args = [o.bun, "run", script, "start", "--no-open"].map((a) => `    <string>${xml(a)}</string>`).join("\n")
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(p.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`
    const uid = o.uid ?? process.getuid?.() ?? 501
    return { file, content, on: [["launchctl", "bootstrap", `gui/${uid}`, file]], off: [["launchctl", "bootout", `gui/${uid}/${LABEL}`]] }
  }
  if (platform === "linux") {
    const file = join(home, ".config", "systemd", "user", "jobdesk.service")
    const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`
    const content = `[Unit]
Description=jobdesk (dashboard, Telegram bot and daily job search)
After=network-online.target

[Service]
WorkingDirectory=${p.root}
Environment=${q(`PATH=${path}`)}
ExecStart=${q(o.bun)} run ${q(script)} start --no-open
Restart=on-failure
RestartSec=30
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`
    return { file, content, on: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "jobdesk.service"]], off: [["systemctl", "--user", "disable", "--now", "jobdesk.service"]] }
  }
  return null
}

export async function autostart(p: Paths, on: boolean, bun: string): Promise<string> {
  const pl = plan(p, { bun })
  if (!pl) return "Starting at login isn't set up for Windows yet. Run `jobdesk start` after you log in, or add it to Task Scheduler."
  if (on) {
    mkdirSync(dirname(pl.file), { recursive: true })
    // Replace an older copy cleanly: unload first (an error here just means it wasn't loaded).
    if (existsSync(pl.file)) for (const c of pl.off) await run(c[0], c.slice(1), { timeoutMs: 15_000 })
    writeFileSync(pl.file, pl.content, "utf8")
    for (const c of pl.on) {
      const r = await run(c[0], c.slice(1), { timeoutMs: 30_000 })
      if (r.code !== 0) return `Wrote ${pl.file}, but "${c.join(" ")}" failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`
    }
    return `jobdesk will now start by itself when you log in (and it has started now). Its log: ${join(p.runs, "service.log")}\nTo stop that: jobdesk autostart off`
  }
  for (const c of pl.off) await run(c[0], c.slice(1), { timeoutMs: 15_000 })
  if (existsSync(pl.file)) rmSync(pl.file)
  return "jobdesk won't start by itself any more. It has been stopped."
}
