// Paste-a-link (MSG-5 core, LEAD-2): fetch what's really at the URL, run it through the
// guard, flag it, store it. A URL that cannot be fetched gives a plain error - nothing is
// ever made up in its place.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Paths } from "./lib/paths.ts"
import { bunRun, python } from "./lib/exec.ts"
import { guard } from "./lib/guard.ts"
import { detectScam } from "./safety/scam.ts"
import { detectDiscrimination } from "./safety/discrimination.ts"
import { publishedContactRoutes, upsertLead, type Lead } from "./data/leads.ts"
import { addItem } from "./data/attention.ts"
import { discoverPortals, heuristicFit, profileTerms } from "./scan.ts"
import type { Config } from "./data/config.ts"
import { today } from "./lib/store.ts"

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** Which installed portal skill handles this host (read from its SKILL.md / url-reference.md / CLI source). */
export function portalForHost(root: string, host: string): { name: string; cli: string } | null {
  if (!host) return null
  for (const p of discoverPortals(root)) {
    const dir = dirname(dirname(dirname(p.cli)))
    const files = ["SKILL.md", "url-reference.md"].map((f) => join(dir, f)).filter(existsSync)
    const src = join(dir, "cli", "src")
    if (existsSync(src)) for (const f of readdirSync(src)) if (f.endsWith(".ts")) files.push(join(src, f))
    const hay = files.map((f) => readFileSync(f, "utf8")).join("\n").toLowerCase()
    const base = host.split(".").slice(-2).join(".")
    if (hay.includes(host) || (base.length > 6 && new RegExp(`https?://([a-z0-9-]+\\.)*${base.replace(/\./g, "\\.")}`).test(hay))) return { name: p.name, cli: p.cli }
  }
  return null
}

export function isXUrl(url: string): boolean {
  return /^(x\.com|twitter\.com|mobile\.twitter\.com)$/.test(hostOf(url)) && /\/status\/\d+/.test(url)
}

const decodeEntities = (s: string) =>
  s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&mdash;/g, "-").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")

/** One X post through X's official oEmbed endpoint (no login, no scraping). */
export async function fetchX(url: string, f: FetchFn = fetch): Promise<{ title: string; company: string; text: string }> {
  const canonical = url.replace(/^https?:\/\/(www\.|mobile\.)?x\.com/i, "https://twitter.com")
  const r = await f(`https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(canonical)}`, { redirect: "follow" })
  if (!r.ok) throw new Error(`X did not return that post (HTTP ${r.status}). Open it and paste the text instead.`)
  const j = (await r.json()) as { author_name?: string; author_url?: string; html?: string }
  const text = decodeEntities(j.html ?? "").trim()
  if (!text) throw new Error("X returned an empty post. Open it and paste the text instead.")
  const handle = j.author_url?.split("/").pop() ?? j.author_name ?? "x"
  return { title: text.split("\n")[0].slice(0, 120), company: `@${handle}`, text }
}

function firstMatch(html: string, re: RegExp): string | undefined {
  const m = html.match(re)?.[1]
  return m ? decodeEntities(m).trim() : undefined
}

export interface LinkResult {
  key: string | null
  stored: boolean
  title: string
  company: string
  url: string
  method: string
  guard_verdict: string
  scam: string[]
  discrimination: string[]
  fit: string
  text: string
  note?: string
}

export async function ingestLink(p: Paths, cfg: Config, url: string, opts: { fetchFn?: FetchFn; store?: boolean } = {}): Promise<LinkResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error("That doesn't look like a web link. It should start with http:// or https://")
  const host = hostOf(url)
  let title = ""
  let company = ""
  let raw = ""
  let mode: "text" | "html" = "text"
  let method = ""
  const portal = portalForHost(p.root, host)
  const tmp = mkdtempSync(join(tmpdir(), "jobdesk-link-"))
  try {
    if (isXUrl(url)) {
      const x = await fetchX(url, opts.fetchFn)
      ;({ title, company } = x)
      raw = x.text
      method = "x oembed"
    } else if (portal) {
      const cli = portal.cli
      const dj = await bunRun(p.root, cli, ["detail", url, "--format", "json"], 90_000)
      if (dj.code === 0) {
        try {
          const j = JSON.parse(dj.stdout)
          const o = Array.isArray(j) ? j[0] : (j.job ?? j)
          title = String(o.title ?? o.jobTitle ?? "")
          company = String(o.company ?? o.companyName ?? o.author ?? "")
        } catch {
          /* fall through to plain */
        }
      }
      const dp = await bunRun(p.root, cli, ["detail", url, "--format", "plain"], 90_000)
      if (dp.code !== 0) throw new Error(`The ${portal.name} source could not read that page: ${dp.stderr.trim().slice(0, 200)}`)
      raw = dp.stdout
      method = `${portal.name} cli`
    } else {
      const out = join(tmp, "page.html")
      const r = await python(p.root, "fetch_page.py", [url, "--out", out], { timeoutMs: 90_000 })
      const status = Number(r.stdout.match(/HTTP (\d+)/)?.[1] ?? 0)
      if (r.code !== 0 || !existsSync(out) || status >= 400 || status === 0) {
        throw new Error(`Could not read that page${status ? ` (HTTP ${status})` : ""}. ${r.stdout.trim() || r.stderr.trim()}`.slice(0, 300))
      }
      raw = readFileSync(out, "utf8")
      mode = "html"
      title = firstMatch(raw, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ?? firstMatch(raw, /<title[^>]*>([^<]+)/i) ?? host
      company = firstMatch(raw, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i) ?? host
      method = "fetch_page"
    }
    const g = await guard(p.root, raw, mode)
    if (!title) title = g.text.split("\n").find((l) => l.trim())?.trim().slice(0, 120) ?? host
    if (!company) company = host
    const scam = detectScam(g.text)
    const disc = detectDiscrimination(g.text)
    const fit = heuristicFit(`${title}\n${g.text}`, profileTerms(p.profile, cfg), title, cfg.queries)
    let key: string | null = null
    let stored = false
    let note: string | undefined
    if (opts.store !== false) {
      const f = join(tmp, "store.json")
      const job = {
        title, company, url, location: "", first_seen: today(), posted_date: null, deadline: null,
        fit, status: "new", portal: portal?.name ?? (isXUrl(url) ? "x-link" : "pasted-link"), source: portal ? "cli" : "websearch",
      }
      writeFileSync(f, JSON.stringify([job]), "utf8")
      const st = await python(p.root, "scrape_state.py", ["store", "--results", f])
      if (st.code === 0) {
        const res = JSON.parse(st.stdout) as { added: string[]; already_seen: number; already_applied: number }
        key = res.added[0] ?? null
        stored = !!key
        if (!key) note = res.already_applied ? "You've already applied to this one." : "Already in your list."
      } else note = st.stderr.trim()
      if (!key) {
        const k = await python(p.root, "job_key.py", ["--company", company, "--title", title, "--url", url])
        key = k.stdout.trim().split(/\r?\n/).at(-1) || null
      }
      if (key) {
        const lead: Omit<Lead, "fetched_at"> = {
          key, url, title, company, portal: job.portal, kind: portal ? "job" : "lead",
          fetch_method: method, guard_verdict: g.verdict, guard_findings: g.findings,
          flags: { scam: scam.flags.map((x) => x.reason), discrimination: disc.flags.map((x) => x.reason) },
          contact_routes: portal ? [] : publishedContactRoutes(g.text), text_excerpt: g.text.slice(0, 1200),
        }
        upsertLead(p.leads, lead)
        if (scam.flagged || disc.flagged || !g.clean) {
          addItem(p.attention, {
            id: `flag:${key}`, kind: "flagged_posting", title: `${company}: ${title}`,
            why: [...scam.flags.map((x) => x.reason), ...disc.flags.map((x) => x.reason), g.clean ? "" : g.verdict].filter(Boolean).join(" "),
            action: "Read the warning before spending time on this posting.", ref: key, data: { url },
          })
        }
      }
    }
    return {
      key, stored, title, company, url, method, guard_verdict: g.verdict,
      scam: scam.flags.map((x) => x.reason), discrimination: disc.flags.map((x) => x.reason), fit, text: g.text, note,
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
