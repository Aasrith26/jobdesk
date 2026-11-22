// Minimal Chrome DevTools Protocol client: launches the user's installed Chrome/Edge with a
// dedicated profile (APP-7) and talks to one page over a WebSocket. No dependencies.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

export interface Browser {
  proc: ChildProcess
  port: number
  profileDir: string
  close: () => Promise<void>
}

export async function launchBrowser(exe: string, profileDir: string, opts: { headless?: boolean } = {}): Promise<Browser> {
  mkdirSync(profileDir, { recursive: true })
  const portFile = join(profileDir, "DevToolsActivePort")
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(portFile, { force: true })
      break
    } catch {
      await Bun.sleep(150) // a just-closed browser may still hold it
    }
  }
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--disable-sync",
    "--window-size=1280,1000",
    ...(opts.headless ? ["--headless=new", "--disable-gpu"] : []),
    "about:blank",
  ]
  const proc = spawn(exe, args, { stdio: "ignore", windowsHide: !!opts.headless })
  let port = 0
  for (let i = 0; i < 150 && !port; i++) {
    await Bun.sleep(100)
    try {
      // Windows can briefly lock the file while the browser writes it: just retry.
      if (existsSync(portFile)) port = Number(readFileSync(portFile, "utf8").split(/\r?\n/)[0]) || 0
    } catch {
      port = 0
    }
  }
  if (!port) {
    proc.kill()
    throw new Error("The browser didn't start. Close other windows using the jobdesk browser profile and try again.")
  }
  return {
    proc,
    port,
    profileDir,
    close: async () => {
      try {
        const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
        const c = await CDP.connect(v.webSocketDebuggerUrl)
        await c.send("Browser.close").catch(() => {})
        c.close()
      } catch {
        /* already gone */
      }
      await Bun.sleep(300)
      if (proc.exitCode === null) proc.kill()
    },
  }
}

type Handler = (params: Record<string, unknown>) => void

export class CDP {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private handlers = new Map<string, Set<Handler>>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {})
      }
    })
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("Browser connection closed"))
      this.pending.clear()
    })
  }

  static connect(url: string): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener("open", () => resolve(new CDP(ws)), { once: true })
      ws.addEventListener("error", () => reject(new Error(`Could not connect to the browser at ${url}`)), { once: true })
    })
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Browser did not answer ${method} in time`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(t)
          reject(e)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method: string, h: Handler): () => void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method)!.add(h)
    return () => this.handlers.get(method)?.delete(h)
  }

  waitFor(method: string, timeoutMs = 30_000, pred: (p: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off()
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      const off = this.on(method, (p) => {
        if (!pred(p)) return
        clearTimeout(t)
        off()
        resolve(p)
      })
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/** Connect to the first page target of a launched browser. */
export async function pageSession(b: Browser): Promise<CDP> {
  for (let i = 0; i < 50; i++) {
    const list = (await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl?: string }[]
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
    if (page) return CDP.connect(page.webSocketDebuggerUrl!)
    await Bun.sleep(100)
  }
  throw new Error("The browser opened, but no page was available.")
}

export async function evaluate<T>(c: CDP, expression: string): Promise<T> {
  const r = await c.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(`Page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value as T
}
