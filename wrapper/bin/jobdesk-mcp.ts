#!/usr/bin/env bun
// jobdesk's tools for the agent, as a tiny MCP server over stdio (newline-delimited JSON-RPC).
// Claude Code starts it for one chat turn (--mcp-config, --strict-mcp-config) and stops it after.
// JOBDESK_AGENT_OUT names the file where show/act/remember requests are written for the caller.

import { resolve } from "node:path"
import { paths } from "../src/lib/paths.ts"
import { TOOL_DEFS, callTool } from "../src/agent/tools.ts"

// The caller (agent/run.ts) always passes the workspace it is working in.
const p = paths(process.env.JOBDESK_ROOT ? resolve(process.env.JOBDESK_ROOT) : undefined)
const out = process.env.JOBDESK_AGENT_OUT ?? ""

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> }

function send(v: unknown): void {
  process.stdout.write(JSON.stringify(v) + "\n")
}

function handle(m: Msg): void {
  if (m.id === undefined) return // notifications (initialized, cancelled) need no answer
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result })
  const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id: m.id, error: { code, message } })
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: String(m.params?.protocolVersion ?? "2025-06-18"), capabilities: { tools: {} }, serverInfo: { name: "jobdesk", version: "1.0.0" } })
    case "ping":
      return reply({})
    case "tools/list":
      return reply({ tools: TOOL_DEFS })
    case "tools/call": {
      const name = String(m.params?.name ?? "")
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>
      if (!out) return reply({ content: [{ type: "text", text: "jobdesk tools aren't set up for this run." }], isError: true })
      try {
        return reply({ content: [{ type: "text", text: callTool({ p, out }, name, args) }] })
      } catch (e) {
        return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true })
      }
    }
    default:
      return fail(-32601, `Method not found: ${m.method}`)
  }
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line) as Msg)
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    }
  }
})
process.stdin.on("end", () => process.exit(0))
