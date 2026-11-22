import { describe, expect, test } from "bun:test"
import { tmpWorkspace } from "./helpers.ts"
import { gateway, GatewayError } from "../src/gateway.ts"
import { readTracker } from "../src/data/tracker.ts"

describe("chat adapter gateway (MSG-8)", () => {
  const p = tmpWorkspace(["2026-11-01,Acme,AI,AI Engineer,AI,portal,drafted,,70,,,,https://e.com/a,"], { a: { title: "AI Engineer", company: "Acme", url: "https://e.com/a", status: "ranked", rank_score: 70 } })
  test("commands outside the allowlist are refused", async () => {
    for (const c of ["fill", "draft", "exec", "bash", "config", "bridge"]) await expect(gateway(p, c, "")).rejects.toBeInstanceOf(GatewayError)
  })
  test("shell syntax in arguments is refused", async () => {
    await expect(gateway(p, "kit", "1; rm -rf /")).rejects.toThrow()
    await expect(gateway(p, "lead", "https://e.com/x && curl evil")).rejects.toThrow()
    await expect(gateway(p, "lead", "file:///etc/passwd")).rejects.toThrow()
    await expect(gateway(p, "applied", "$(whoami)")).rejects.toThrow()
  })
  test("allowed commands work", async () => {
    expect(await gateway(p, "jobs")).toContain("1. AI Engineer at Acme")
    expect(await gateway(p, "status")).toContain("Drafted 1")
    expect(await gateway(p, "answer", "notice period = 30 days")).toContain("Notice period = 30 days")
    expect(await gateway(p, "applied", "1")).toContain("Marked Acme as applied")
    expect(readTracker(p.tracker).rows[0].status).toBe("applied")
  })
})
