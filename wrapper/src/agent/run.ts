// One turn of the agent, the same for Telegram and the dashboard: the model gets a short snapshot,
// its notes about the user, the recent conversation, and jobdesk's tools (a local MCP server that
// lives only for this turn). It replies in plain words; what it asked to show or do comes back as
// a list the caller turns into buttons. Read-only file tools plus jobdesk's own tools: no shell,
// no writing outside wrapper-data, no web.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import type { Paths } from "../lib/paths.ts"
import type { Config } from "../data/config.ts"
import { runClaude, TOOLS, type ClaudeExec } from "../lib/claude.ts"
import { bunBin } from "../lib/exec.ts"
import { readJsonl } from "../lib/store.ts"
import { snapshot, mentorPrompt, parseMentorReply } from "../bridge/mentor.ts"
import { TOOL_DEFS, readOutput } from "./tools.ts"
import { addTurn, pastForPrompt, readNotes } from "./memory.ts"

export const AGENT_TOOLS = [...TOOLS.readOnly, ...TOOL_DEFS.map((t) => `mcp__jobdesk__${t.name}`)]

export interface AgentTurn {
  ok: boolean
  reply: string
  /** Job keys the agent chose to show, best first. */
  show: string[]
  /** "verb arg" requests: free ones run at once, the rest become a Yes/No. */
  actions: string[]
  remembered: string[]
  usd: number
  error?: string
  skipped?: string
}

export async function askAgent(p: Paths, cfg: Config, o: { question: string; channel: "telegram" | "dashboard"; lastList?: string[]; help: string; exec?: ClaudeExec; now?: Date; recordReply?: boolean }): Promise<AgentTurn> {
  const dir = join(p.data, "agent")
  mkdirSync(dir, { recursive: true })
  const id = randomBytes(6).toString("hex")
  const out = join(dir, `${id}.jsonl`)
  const mcp = join(dir, `${id}.mcp.json`)
  writeFileSync(mcp, JSON.stringify({
    mcpServers: {
      jobdesk: {
        command: bunBin(),
        args: ["run", resolve(import.meta.dir, "..", "..", "bin", "jobdesk-mcp.ts")],
        env: { JOBDESK_ROOT: p.root, JOBDESK_DATA: p.data, JOBDESK_AGENT_OUT: out },
      },
    },
  }))
  const past = pastForPrompt(p)
  addTurn(p, o.channel, "user", o.question)
  const prompt = mentorPrompt({ snapshot: snapshot(p, cfg, o.lastList ?? [], o.now), help: o.help, past, question: o.question, notes: readNotes(p), channel: o.channel })
  try {
    const r = await runClaude({
      root: p.root, ledger: p.costs, cfg, task: "chat", prompt, allowedTools: AGENT_TOOLS, exec: o.exec, timeoutMs: 5 * 60_000,
      extraArgs: ["--mcp-config", mcp, "--strict-mcp-config"],
    })
    if (r.skipped) return { ok: false, reply: r.error ?? "", show: [], actions: [], remembered: [], usd: 0, skipped: r.skipped, error: r.error }
    // Plain text is the normal reply; the older JSON form ({"reply","actions"}) is still understood.
    const parsed = parseMentorReply(r.text)
    const got = readOutput(existsSync(out) ? readJsonl(out) : [])
    const reply = parsed.reply.trim()
    if (r.ok && reply && o.recordReply !== false) addTurn(p, o.channel, "assistant", reply, got.show)
    return { ok: r.ok && !!reply, reply, show: got.show, actions: [...parsed.actions, ...got.actions].slice(0, 4), remembered: got.remembered, usd: r.usd, error: r.error }
  } finally {
    rmSync(out, { force: true })
    rmSync(mcp, { force: true })
  }
}
