// `jobdesk start`: one process for everything - the dashboard, the Telegram bot (switched on as soon
// as a token is saved, from the dashboard or the terminal) and the daily schedule. A lock file stops
// a second copy: two bots polling one token make Telegram reject both.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { Paths } from "./lib/paths.ts"
import { readConfig, writeConfig } from "./data/config.ts"
import { Bot, readToken, saveToken } from "./bridge/bot.ts"
import { Telegram } from "./bridge/telegram.ts"
import { startDashboard, type DashboardHandle } from "./dashboard/server.ts"
import type { BotStatus } from "./setup.ts"
import { scan } from "./scan.ts"
import { quickRank } from "./rank.ts"
import { modelCheckLeads } from "./safety/check.ts"
import { readJson, writeJson, today } from "./lib/store.ts"
import { join } from "node:path"

export interface Lock {
  pid: number
  port: number
  started: string
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it exists but belongs to someone else - still running.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The running copy, if there is one. A lock left by a crashed copy doesn't count. */
export function runningCopy(p: Paths): Lock | null {
  if (!existsSync(p.lock)) return null
  try {
    const l = JSON.parse(readFileSync(p.lock, "utf8")) as Lock
    return l.pid && l.pid !== process.pid && alive(l.pid) ? l : null
  } catch {
    return null
  }
}

export function takeLock(p: Paths, port: number): () => void {
  const other = runningCopy(p)
  if (other) throw new Error(`jobdesk is already running (process ${other.pid}${other.port ? `, dashboard at http://127.0.0.1:${other.port}/` : ""}). Use that one, or stop it first.`)
  writeFileSync(p.lock, JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() } satisfies Lock))
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const l = JSON.parse(readFileSync(p.lock, "utf8")) as Lock
      if (l.pid === process.pid) rmSync(p.lock, { force: true })
    } catch {
      /* already gone */
    }
  }
}

/** Starts, stops and replaces the bot while the service keeps running. */
export class BotSupervisor {
  private bot?: Bot
  private tg?: Telegram
  private username?: string
  private error?: string
  private loop?: Promise<void>
  constructor(private p: Paths, private log: (s: string) => void, private makeTg: (token: string) => Telegram = (t) => new Telegram(t)) {}

  status(): BotStatus {
    const paired = readConfig(this.p.config).telegram.owner_chat_id !== undefined
    const code = this.bot?.pairCode
    return {
      running: !!this.bot,
      username: this.username,
      paired,
      code: !paired ? code : undefined,
      link: !paired && this.username && code ? `https://t.me/${this.username}?start=${code}` : undefined,
      error: this.error,
    }
  }

  /** Check the token with Telegram, save it, and (re)start the bot with it. */
  async connect(token: string): Promise<BotStatus> {
    const t = token.trim()
    const tg = this.makeTg(t)
    let me
    try {
      me = await tg.getMe()
    } catch (e) {
      throw new Error(`Telegram didn't accept that token: ${(e as Error).message.replace(/^Telegram getMe:\s*/, "")}`)
    }
    const previous = readToken(this.p)
    saveToken(this.p, t)
    // A different bot means a different chat: pair again.
    if (previous && previous !== t) {
      const c = readConfig(this.p.config)
      delete c.telegram.owner_chat_id
      writeConfig(this.p.config, c)
    }
    await this.stop()
    this.launch(tg, me.username)
    return this.status()
  }

  /** Start with the saved token, if there is one. A bad token is reported, not fatal. */
  async startSaved(): Promise<void> {
    const t = readToken(this.p)
    if (!t) return
    const tg = this.makeTg(t)
    try {
      const me = await tg.getMe()
      this.launch(tg, me.username)
    } catch (e) {
      this.error = `The saved bot token didn't work: ${(e as Error).message}`
      this.log(this.error)
    }
  }

  /** Forget the paired chat; the next /start with the new code pairs again. */
  async unpair(): Promise<BotStatus> {
    const c = readConfig(this.p.config)
    delete c.telegram.owner_chat_id
    writeConfig(this.p.config, c)
    if (this.bot && this.tg) {
      const tg = this.tg
      const name = this.username
      await this.stop()
      this.launch(tg, name)
    }
    return this.status()
  }

  isActive(): boolean {
    return !!this.bot && readConfig(this.p.config).telegram.owner_chat_id !== undefined
  }

  private launch(tg: Telegram, username?: string): void {
    this.error = undefined
    this.tg = tg
    this.username = username
    const bot = new Bot({ paths: this.p, tg, log: (s) => this.log(`bot: ${s}`) })
    this.bot = bot
    this.log(readConfig(this.p.config).telegram.owner_chat_id === undefined ? `Bot @${username} is on. Pair it from the dashboard, or send it: /start ${bot.pairCode}` : `Bot @${username} is on.`)
    this.loop = bot.loop().catch((e) => {
      this.error = (e as Error).message
      this.log(`bot stopped: ${this.error}`)
    })
  }

  async stop(): Promise<void> {
    if (!this.bot) return
    this.bot.stop()
    this.bot = undefined
    // The loop ends after its current poll; don't wait the full poll time for it.
    await Promise.race([this.loop, Bun.sleep(100)])
  }
}

/**
 * The daily search when there is no paired bot to run it: search, score the new finds, and leave
 * them on the dashboard. With a paired bot, the bot does this and messages the user instead.
 */
export class Scheduler {
  private running = false
  constructor(private p: Paths, private botActive: () => boolean, private log: (s: string) => void, private now: () => Date = () => new Date()) {}

  async tick(): Promise<boolean> {
    const cfg = readConfig(this.p.config)
    if (!cfg.daily.search || this.running || this.botActive()) return false
    const stateFile = join(this.p.data, "bridge_state.json")
    const st = readJson<{ last_daily?: string }>(stateFile, {})
    const now = this.now()
    if (st.last_daily === today(now)) return false
    const [h, m] = cfg.daily.time.split(":").map(Number)
    const at = new Date(now)
    at.setHours(h || 0, m || 0, 0, 0)
    if (now < at) return false
    // Marked when it starts (shared with the bot), so a failed search isn't repeated every minute.
    writeJson(stateFile, { ...readJson<Record<string, unknown>>(stateFile, {}), last_daily: today(now) })
    this.running = true
    try {
      const s = await scan(this.p, cfg, { log: () => {} })
      if (s.added.length && cfg.model_checks) await modelCheckLeads(this.p, cfg, s.added)
      if (s.added.length && cfg.auto_rank) await quickRank(this.p, cfg, { keys: s.added })
      this.log(`Daily search: ${s.added.length} new. See the dashboard.`)
    } catch (e) {
      this.log(`Daily search failed: ${(e as Error).message}`)
    } finally {
      this.running = false
    }
    return true
  }
}

export interface Service {
  dashboard: DashboardHandle
  bot: BotSupervisor
  stop: () => Promise<void>
}

export async function startService(p: Paths, o: { port?: number; log?: (s: string) => void; startBot?: boolean } = {}): Promise<Service> {
  const log = o.log ?? ((s: string) => console.log(s))
  const cfg = readConfig(p.config)
  const port = o.port ?? cfg.dashboard_port
  const release = takeLock(p, port)
  const bot = new BotSupervisor(p, log)
  let dashboard: DashboardHandle
  try {
    dashboard = startDashboard(p, port, { service: { bot } })
  } catch (e) {
    release()
    const msg = (e as Error).message
    throw new Error(/EADDRINUSE|in use/i.test(msg) ? `Port ${port} is busy. Is the dashboard already open in another terminal? Close it, or use --port <another number>.` : msg)
  }
  writeFileSync(p.lock, JSON.stringify({ pid: process.pid, port: dashboard.port, started: new Date().toISOString() } satisfies Lock))
  if (o.startBot !== false) await bot.startSaved()
  const scheduler = new Scheduler(p, () => bot.isActive(), log)
  const timer = setInterval(() => void scheduler.tick().catch((e) => log(`schedule error: ${(e as Error).message}`)), 60_000)
  return {
    dashboard,
    bot,
    stop: async () => {
      clearInterval(timer)
      await bot.stop()
      dashboard.stop()
      release()
    },
  }
}
