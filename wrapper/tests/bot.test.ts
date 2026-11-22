import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpWorkspace } from "./helpers.ts"
import { Bot, COMMANDS, MENU, applyDaily, describeDaily } from "../src/bridge/bot.ts"
import { parseMentorReply } from "../src/bridge/mentor.ts"
import { plainFollowUp } from "../src/outreach.ts"
import { DEFAULT_CONFIG } from "../src/data/config.ts"
import { Telegram, type TgUpdate } from "../src/bridge/telegram.ts"
import { readConfig, writeConfig } from "../src/data/config.ts"
import { readTracker } from "../src/data/tracker.ts"
import { addItem, openItems } from "../src/data/attention.ts"
import { readBank } from "../src/data/answers.ts"

function harness(rows: string[] = []) {
  const p = tmpWorkspace(rows, { a: { title: "AI Engineer", company: "Acme", url: "https://e.com/a", status: "ranked", rank_score: 70 } })
  const sent: { method: string; body: Record<string, unknown> }[] = []
  const fake = async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop()!
    const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])) : JSON.parse(String(init?.body ?? "{}"))
    sent.push({ method, body })
    return new Response(JSON.stringify({ ok: true, result: method === "getUpdates" ? [] : true }))
  }
  const claudeCalls: string[][] = []
  const bot = new Bot({
    paths: p,
    tg: new Telegram("123:TEST", fake as never),
    pairCode: "424242",
    claudeExec: async (args) => {
      claudeCalls.push(args)
      return { code: 0, stdout: JSON.stringify({ result: "answer", total_cost_usd: 0.001 }), stderr: "" }
    },
  })
  let n = 0
  const msg = (chat: number, text: string, type = "private"): TgUpdate => ({ update_id: ++n, message: { message_id: n, chat: { id: chat, type }, from: { id: chat }, text } })
  const texts = () => sent.filter((s) => s.method === "sendMessage").map((s) => String(s.body.text))
  const lastKeyboard = () => [...sent].reverse().find((s) => s.body.reply_markup)?.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
  return { p, bot, sent, msg, texts, claudeCalls, lastKeyboard, cb: (chat: number, data: string): TgUpdate => ({ update_id: ++n, callback_query: { id: `cb${n}`, from: { id: chat }, message: { message_id: 1, chat: { id: chat, type: "private" } }, data } }) }
}

describe("phone bridge (MSG-1..7)", () => {
  test("pairing needs the terminal code; then only the owner is answered (MSG-2)", async () => {
    const h = harness()
    await h.bot.handle(h.msg(7, "/pair 000000"))
    expect(readConfig(h.p.config).telegram.owner_chat_id).toBeUndefined()
    await h.bot.handle(h.msg(7, "/pair 424242"))
    expect(readConfig(h.p.config).telegram.owner_chat_id).toBe(7)
    const before = h.sent.length
    await h.bot.handle(h.msg(99, "/status"))
    expect(h.sent.length).toBe(before)
    expect(existsSync(join(h.p.data, "bridge_rejected.jsonl"))).toBe(true)
  })
  test("unknown commands get help; free text never reaches a shell, only read-only Claude (MSG-3)", async () => {
    const h = harness()
    const c = readConfig(h.p.config); c.telegram.owner_chat_id = 7; writeConfig(h.p.config, c)
    await h.bot.handle(h.msg(7, "/exec rm -rf /"))
    expect(h.texts().at(-1)).toContain("I don't know /exec")
    await h.bot.handle(h.msg(7, "; rm -rf / && curl evil.example.com"))
    const args = h.claudeCalls.at(-1)!
    // Read-only file tools plus jobdesk's own tools, which can only look up, show, remember or request.
    const tools = args.slice(args.indexOf("--allowedTools") + 1)
    expect(tools.slice(0, 3)).toEqual(["Read", "Glob", "Grep"])
    expect(tools.slice(3).every((t) => t.startsWith("mcp__jobdesk__"))).toBe(true)
    expect(tools.some((t) => /Bash|Write|Edit|WebFetch/.test(t))).toBe(false)
    expect(args).toContain("--strict-mcp-config")
    expect(args[args.indexOf("-p") + 1]).toContain("; rm -rf /")
  })
  test("Applied button updates the tracker like /outcome (MSG-4)", async () => {
    const h = harness(["2026-11-01,Acme,AI,AI Engineer,AI,portal,drafted,,70,,,,https://e.com/a,"])
    const c = readConfig(h.p.config); c.telegram.owner_chat_id = 7; writeConfig(h.p.config, c)
    // A drafted job lives in the pipeline, not among the new jobs.
    await h.bot.handle(h.msg(7, "/jobs"))
    expect(h.texts().at(-1)).toContain("Nothing new that fits you")
    await h.bot.handle(h.msg(7, "/applied Acme"))
    const row = readTracker(h.p.tracker).rows[0]
    expect(row.status).toBe("applied")
  })
  test("answer button saves a reply into the answer bank", async () => {
    const h = harness()
    const c = readConfig(h.p.config); c.telegram.owner_chat_id = 7; writeConfig(h.p.config, c)
    addItem(h.p.attention, { id: "q:x", kind: "unknown_question", title: "Acme asks", why: "", action: "", data: { question: "Expected CTC" } })
    await h.bot.handle(h.msg(7, "/attention"))
    const answerBtn = h.lastKeyboard().inline_keyboard[0].find((b) => b.text === "Answer")!
    await h.bot.handle(h.cb(7, answerBtn.callback_data))
    await h.bot.handle(h.msg(7, "18 LPA"))
    expect(readBank(h.p.answers).expected_ctc.answer).toBe("18 LPA")
  })
  test("submit waits for a tap; cancel sends nothing (APP-5)", async () => {
    const h = harness()
    const c = readConfig(h.p.config); c.telegram.owner_chat_id = 7; writeConfig(h.p.config, c)
    const pending = h.bot.askApproval(7, { id: "run1", url: "https://e.com", company: "Acme", role: "R", site: "Greenhouse", terms_checked: false, fields: [{ label: "Email", value: "a@e.com", source: "answer bank: Email", required: true }], unknown: [], stops: [], flags: [], submittable: true })
    await Bun.sleep(20)
    expect(h.texts().at(-1)).toContain("Nothing is sent until you tap Send")
    const cancel = h.lastKeyboard().inline_keyboard[0].find((b) => b.text === "Cancel")!
    await h.bot.handle(h.cb(7, cancel.callback_data))
    expect(await pending).toBe("cancel")
  })
  test("digest goes out once a day at the set time, and says so when late (MSG-6)", async () => {
    const h = harness()
    const c = readConfig(h.p.config); c.telegram.owner_chat_id = 7; c.telegram.digest_time = "09:00"; writeConfig(h.p.config, c)
    let now = new Date("2026-11-11T08:59:00")
    const bot = new Bot({ paths: h.p, tg: (h.bot as unknown as { tg: Telegram }).tg, now: () => now, pairCode: "1" })
    await bot.tick()
    expect(h.texts().some((t) => t.includes("Good morning"))).toBe(false)
    now = new Date("2026-11-11T11:30:00")
    await bot.tick()
    expect(h.texts().filter((t) => t.includes("Good morning")).length).toBe(1)
    expect(h.texts().find((t) => t.includes("Good morning"))).toContain("Sent late")
    await bot.tick()
    expect(h.texts().filter((t) => t.includes("Good morning")).length).toBe(1)
  })
  test("the token never lands in the repo", () => {
    const h = harness()
    expect(readFileSync(join(h.p.data, ".gitignore"), "utf8")).toContain("*")
  })
})

const SEEN2 = {
  a: { title: "AI Engineer", company: "Acme", url: "https://e.com/a", status: "ranked", rank_score: 70, portal: "linkedin-search" },
  b: { title: "Voice Engineer", company: "Bolt", url: "https://e.com/b", status: "ranked", rank_score: 90 },
}

function owned(h: ReturnType<typeof harness>, seen?: Record<string, unknown>) {
  const c = readConfig(h.p.config); c.telegram.owner_chat_id = 7; writeConfig(h.p.config, c)
  if (seen) writeFileSync(h.p.seen, JSON.stringify({ seen }))
  return h
}

describe("phone bridge: buttons, results and staying alive", () => {
  test("a button acts on its own job, even after the list changed and the bot restarted", async () => {
    const h = owned(harness(), SEEN2)
    await h.bot.handle(h.msg(7, "/jobs"))
    // Bolt (fit 90) is number 1, Acme number 2. Keep Acme's Skip button.
    expect(h.lastKeyboard().inline_keyboard[1][0].text).toBe("2. Apply")
    const acmeSkip = h.lastKeyboard().inline_keyboard[1][1]
    expect(acmeSkip.text).toBe("Skip")
    // A narrower list makes a different job "number 1"...
    await h.bot.handle(h.msg(7, "/jobs voice"))
    // ...and the bot restarts (laptop slept, bridge started again).
    const restarted = new Bot({ paths: h.p, tg: (h.bot as unknown as { tg: Telegram }).tg, pairCode: "1" })
    await restarted.handle(h.cb(7, acmeSkip.callback_data))
    expect(h.texts().at(-1)).toContain("won't show that one again")
    const shown = JSON.parse(readFileSync(h.p.recommended, "utf8"))
    expect(shown.a.reaction).toBe("skipped")
    expect(shown.b.reaction).toBeUndefined()
    // New buttons made after the restart never reuse an old button's id.
    await restarted.handle(h.msg(7, "/jobs all"))
    expect(h.texts().at(-1)).toContain("Bolt")
    expect(h.texts().at(-1)).not.toContain("Acme")
    expect(h.lastKeyboard().inline_keyboard.flat().map((b) => b.callback_data)).not.toContain(acmeSkip.callback_data)
  })
  test("/applied works for a job applied by hand with the kit (no drafted row yet)", async () => {
    const h = owned(harness(), SEEN2)
    await h.bot.handle(h.msg(7, "/jobs"))
    await h.bot.handle(h.msg(7, "/applied 2"))
    expect(h.texts().at(-1)).toContain("Added Acme to your tracker as applied")
    const t = readTracker(h.p.tracker)
    expect(t.rows.length).toBe(1)
    expect(t.rows[0]).toMatchObject({ company: "Acme", role: "AI Engineer", status: "applied", channel: "portal", fit_rating: "70", source: "https://e.com/a" })
    expect(t.rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // The row is plain enough for the original tools: 14 fields, no quotes.
    const line = readFileSync(h.p.tracker, "utf8").trim().split("\n")[1]
    expect(line.split(",").length).toBe(14)
    expect(line).not.toContain('"')
    // A second tap changes nothing and says so.
    await h.bot.handle(h.msg(7, "/applied 2"))
    expect(h.texts().at(-1)).toContain('already marked "applied"')
    expect(readTracker(h.p.tracker).rows.length).toBe(1)
    // An applied job leaves the shortlist.
    await h.bot.handle(h.msg(7, "/jobs"))
    expect(h.texts().at(-1)).not.toContain("Acme")
  })
  test("/update records a result under the tracker's own status names", async () => {
    const h = owned(harness(["2026-11-01,Acme,AI,AI Engineer,AI,portal,applied,,70,,,,https://e.com/a,", "2026-11-02,Bolt Labs,AI,Voice Engineer,AI,portal,applied,,90,,,,https://e.com/b,"]))
    await h.bot.handle(h.msg(7, "/update Acme interview"))
    expect(readTracker(h.p.tracker).rows[0].status).toBe("interview")
    expect(readTracker(h.p.tracker).rows[0].notes).toContain("interview - marked from phone")
    await h.bot.handle(h.msg(7, "/update Bolt Labs no reply"))
    expect(readTracker(h.p.tracker).rows[1].status).toBe("no_response")
    const before = readFileSync(h.p.tracker, "utf8")
    await h.bot.handle(h.msg(7, "/update Acme promoted"))
    expect(h.texts().at(-1)).toContain("Write it like this")
    await h.bot.handle(h.msg(7, "/update Nowhere rejected"))
    expect(h.texts().at(-1)).toContain("isn't in your tracker")
    await h.bot.handle(h.msg(7, "/update Acme interview"))
    expect(h.texts().at(-1)).toContain("already marked")
    expect(readFileSync(h.p.tracker, "utf8")).toBe(before)
  })
  test("a 'Needs you' alert can be settled from the alert itself, and is sent once", async () => {
    const h = owned(harness())
    addItem(h.p.attention, { id: "x:1", kind: "other", title: "Check this", why: "Because", action: "Look at it" })
    const bot = new Bot({ paths: h.p, tg: (h.bot as unknown as { tg: Telegram }).tg, now: () => new Date("2026-11-11T08:00:00"), pairCode: "1" })
    await bot.tick()
    await bot.tick()
    const alerts = h.texts().filter((t) => t.startsWith("Needs you: Check this"))
    expect(alerts.length).toBe(1)
    expect(alerts[0]).toContain("Next: Look at it")
    const done = h.lastKeyboard().inline_keyboard[0].find((b) => b.text === "Done")!
    await bot.handle(h.cb(7, done.callback_data))
    expect(openItems(h.p.attention).length).toBe(0)
  })
  test("an alert that could not be sent is tried again, not lost", async () => {
    const h = owned(harness())
    addItem(h.p.attention, { id: "x:2", kind: "other", title: "Flaky", why: "w", action: "a" })
    let down = true
    const sent: string[] = []
    const tg = new Telegram("123:TEST", (async (_u: string, init?: RequestInit) => {
      if (down) throw new Error("network down")
      sent.push(String(JSON.parse(String(init?.body ?? "{}")).text ?? ""))
      return new Response(JSON.stringify({ ok: true, result: true }))
    }) as never)
    const bot = new Bot({ paths: h.p, tg, now: () => new Date("2026-11-11T08:00:00"), pairCode: "1" })
    await bot.tick().catch(() => {})
    down = false
    await bot.tick()
    expect(sent.filter((t) => t.startsWith("Needs you: Flaky")).length).toBe(1)
  })
  test("the digest is only marked sent once it went out", async () => {
    const h = owned(harness())
    let down = true
    const sent: string[] = []
    const tg = new Telegram("123:TEST", (async (_u: string, init?: RequestInit) => {
      if (down) throw new Error("network down")
      sent.push(String(JSON.parse(String(init?.body ?? "{}")).text ?? ""))
      return new Response(JSON.stringify({ ok: true, result: true }))
    }) as never)
    const bot = new Bot({ paths: h.p, tg, now: () => new Date("2026-11-11T09:01:00"), pairCode: "1" })
    await bot.tick().catch(() => {})
    down = false
    await bot.tick()
    await bot.tick()
    expect(sent.filter((t) => t.includes("Good morning")).length).toBe(1)
  })
  test("a broken connection while replying never throws out of the bot", async () => {
    const h = owned(harness())
    const tg = new Telegram("123:TEST", (async () => { throw new Error("network down") }) as never)
    const bot = new Bot({ paths: h.p, tg, pairCode: "1" })
    await expect(bot.handle(h.msg(7, "/status"))).resolves.toBeUndefined()
  })
  test("slow work shows 'typing', and the menu only lists real commands", async () => {
    const h = owned(harness())
    await h.bot.handle(h.msg(7, "how is my search going?"))
    expect(h.sent.some((s) => s.method === "sendChatAction" && s.body.action === "typing")).toBe(true)
    for (const m of MENU) expect(COMMANDS as readonly string[]).toContain("/" + m.command)
    for (const m of MENU) expect(m.description.length).toBeLessThanOrEqual(256)
  })
  test("a typed answer is still expected after a restart", async () => {
    const h = owned(harness())
    addItem(h.p.attention, { id: "q:y", kind: "unknown_question", title: "Acme asks", why: "", action: "", data: { question: "Notice period" } })
    await h.bot.handle(h.msg(7, "/attention"))
    await h.bot.handle(h.cb(7, h.lastKeyboard().inline_keyboard[0].find((b) => b.text === "Answer")!.callback_data))
    const restarted = new Bot({ paths: h.p, tg: (h.bot as unknown as { tg: Telegram }).tg, pairCode: "1" })
    await restarted.handle(h.msg(7, "30 days"))
    expect(readBank(h.p.answers).notice_period.answer).toBe("30 days")
  })
  test("'Update my profile' refuses a file outside documents/cv", async () => {
    const h = owned(harness())
    writeFileSync(join(h.p.root, "evil.txt.txt"), "## Identity\n- **Name:** Someone Else\n")
    const before = readFileSync(h.p.profile, "utf8")
    const btn = (h.bot as unknown as { btn: (t: string, a: string) => { callback_data: string } }).btn("x", `profile:${join(h.p.root, "evil.txt")}`)
    await h.bot.handle(h.cb(7, btn.callback_data))
    expect(h.texts().at(-1)).toContain("lost track of that file")
    expect(readFileSync(h.p.profile, "utf8")).toBe(before)
    expect(h.claudeCalls.length).toBe(0)
  })
  test("Telegram's 'too many requests' is waited out and the message still arrives", async () => {
    let calls = 0
    const tg = new Telegram("123:TEST", (async () => {
      calls++
      return new Response(JSON.stringify(calls === 1 ? { ok: false, description: "Too Many Requests", parameters: { retry_after: 0.01 } } : { ok: true, result: true }))
    }) as never)
    await tg.send(7, "hello")
    expect(calls).toBe(2)
  })
})

/** A bot whose "Claude" answers from a script: each call takes the next reply. */
function scripted(rows: string[], seen: Record<string, unknown>, replies: (string | ((prompt: string) => string))[]) {
  const h = owned(harness(rows), seen)
  const prompts: string[] = []
  let i = 0
  const bot = new Bot({
    paths: h.p,
    tg: (h.bot as unknown as { tg: Telegram }).tg,
    pairCode: "1",
    now: () => new Date("2026-11-16T10:00:00"),
    claudeExec: async (args) => {
      const prompt = args[args.indexOf("-p") + 1]
      prompts.push(prompt)
      const r = replies[Math.min(i++, replies.length - 1)]
      return { code: 0, stdout: JSON.stringify({ result: typeof r === "function" ? r(prompt) : r, total_cost_usd: 0.001 }), stderr: "" }
    },
  })
  return { ...h, bot, prompts }
}
const say = (reply: string, actions: string[] = []) => JSON.stringify({ reply, actions })
/** The newest button with this label, on any message. */
const tap = (h: ReturnType<typeof harness>, text: string) =>
  [...h.sent].reverse().flatMap((s) => ((s.body.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat()).find((b) => b.text === text)!

describe("mentor chat: plain words in, one tap to act", () => {
  test("the mentor is told what is going on, so it can answer without digging", async () => {
    const h = scripted(["2026-11-01,Acme,AI,AI Engineer,AI,portal,applied,,70,,,,https://e.com/a,"], SEEN2, [say("Bolt is your best bet.")])
    await h.bot.handle(h.msg(7, "/jobs"))
    await h.bot.handle(h.msg(7, "anything good today?"))
    const p = h.prompts[0]
    expect(p).toContain("job-search mentor")
    expect(p).toContain("- Acme | AI Engineer | applied | 2026-11-01 | fit 70")
    expect(p).toContain("1. Voice Engineer at Bolt")
    expect(p).toContain("Follow-ups due (1)")
    expect(p).toContain("Daily search: off")
    expect(h.texts().at(-1)).toBe("Bolt is your best bet.")
  })
  test("'apply to the second one' is offered with Yes/No and nothing is written until Yes", async () => {
    const h = scripted([], SEEN2, [say("Good pick. I'll get it ready.", ["apply 2"]), "drafted"])
    await h.bot.handle(h.msg(7, "/jobs"))
    await h.bot.handle(h.msg(7, "apply to the second one"))
    expect(h.texts().at(-1)).toContain("Apply to AI Engineer at Acme?")
    expect(h.texts().at(-1)).toContain("about $")
    expect(h.prompts.length).toBe(1)
    expect(h.texts().some((t) => t.includes("Writing your CV"))).toBe(false)
    // "No" leaves everything alone.
    await h.bot.handle(h.cb(7, tap(h, "No").callback_data))
    expect(h.texts().at(-1)).toBe("Okay, left it.")
    expect(h.prompts.length).toBe(1)
    // "Yes" starts the work, for the job the button was made for.
    await h.bot.handle(h.msg(7, "/jobs voice"))
    await h.bot.handle(h.msg(7, "apply to the second one"))
    const offers = h.sent.filter((s) => String(s.body.text ?? "").startsWith("Apply to AI Engineer at Acme?"))
    const yes = (offers[0].body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0][0]
    await h.bot.handle(h.cb(7, yes.callback_data))
    expect(h.texts().some((t) => t.includes("Writing your CV and letter for AI Engineer"))).toBe(true)
    expect(h.prompts.some((p) => p.startsWith("/apply https://e.com/a"))).toBe(true)
  })
  test("'they called me for an interview' updates the tracker after one tap", async () => {
    const h = scripted(["2026-11-01,Acme,AI,AI Engineer,AI,portal,applied,,70,,,,https://e.com/a,"], SEEN2, [say("That's great news.", ["update Acme interview"])])
    await h.bot.handle(h.msg(7, "acme called me for an interview!"))
    expect(readTracker(h.p.tracker).rows[0].status).toBe("applied")
    expect(h.texts().at(-1)).toBe('Mark Acme as "interview"?')
    await h.bot.handle(h.cb(7, tap(h, "Yes").callback_data))
    expect(readTracker(h.p.tracker).rows[0].status).toBe("interview")
  })
  test("the model cannot act outside the list, and a vague job is asked about, not guessed", async () => {
    const h = scripted([], SEEN2, [say("ok", ["fill 1", "rm -rf /", "config level L2", "apply the nice one"])])
    await h.bot.handle(h.msg(7, "do everything"))
    const t = h.texts()
    expect(t.some((x) => x.includes("Filling the form"))).toBe(false)
    expect(readConfig(h.p.config).approval_level).toBe("L0")
    expect(t.at(-1)).toBe("ok")
    // Only three actions are looked at, so "apply the nice one" is never reached here; alone it is asked about.
    const h2 = scripted([], SEEN2, [say("ok", ["apply the nice one"])])
    await h2.bot.handle(h2.msg(7, "apply"))
    expect(h2.texts().at(-1)).toContain("couldn't tell which job")
  })
  test("a reply that isn't JSON is still shown as the answer", () => {
    expect(parseMentorReply("Just apply to Bolt.")).toEqual({ reply: "Just apply to Bolt.", actions: [] })
    expect(parseMentorReply('{"reply":"hi","actions":["jobs", 3]}')).toEqual({ reply: "hi", actions: ["jobs", "3"] })
  })
  test("an unknown command gets one line, not the whole manual", async () => {
    const h = owned(harness())
    await h.bot.handle(h.msg(7, "/frobnicate"))
    expect(h.texts().at(-1)!.split("\n").length).toBe(1)
  })
})

describe("follow-ups: short, human, sent by the owner", () => {
  const QUIET = ["2026-11-01,Acme,AI,AI Engineer,AI,portal,applied,jobs@acme.example,70,,,,https://e.com/a,"]
  test("the draft is checked against the profile, opens in Gmail, and 'I sent it' is logged like /outcome", async () => {
    const draft = "Subject: AI Engineer application\n\nHi,\n\nI applied for the AI Engineer role on 2026-11-01 and wanted to check in. I'm still keen. Is there anything else you need from me?\n\nTest"
    const h = scripted(QUIET, SEEN2, [draft, '{"unsupported": []}'])
    await h.bot.handle(h.msg(7, "/followup Acme"))
    const msg = h.texts().at(-1)!
    expect(msg).toContain("Subject: AI Engineer application")
    expect(msg).toContain("I'm still keen.")
    expect(msg).toContain("send it yourself")
    expect(h.prompts[0]).toContain("No \"I hope this finds you well\"")
    expect(h.prompts[0]).toContain("This is the first follow-up.")
    expect(h.prompts[1]).toContain("Compare the MESSAGE with the PROFILE")
    const gmail = h.lastKeyboard().inline_keyboard[0][0] as unknown as { text: string; url: string }
    expect(gmail.text).toBe("Open in Gmail")
    expect(gmail.url).toContain("to=jobs%40acme.example")
    expect(decodeURIComponent(gmail.url)).toContain("I'm still keen.")
    await h.bot.handle(h.cb(7, tap(h, "I sent it").callback_data))
    expect(readTracker(h.p.tracker).rows[0].notes).toBe("followed up 2026-11-16")
    expect(readTracker(h.p.tracker).rows[0].status).toBe("applied")
    expect(h.texts().at(-1)).toContain("remind you once more in 10 days")
  })
  test("a draft that adds something untrue is thrown away for the plain note", async () => {
    const h = scripted(QUIET, SEEN2, ["Subject: Hi\n\nHi,\n\nI led a team of 40 at Google.\n\nTest", '{"unsupported": ["led a team of 40 at Google"]}'])
    await h.bot.handle(h.msg(7, "/followup Acme"))
    const msg = h.texts().at(-1)!
    expect(msg).not.toContain("Google")
    expect(msg).toContain("I applied for the AI Engineer role on 2026-11-01")
    expect(msg).toContain("Written without AI")
  })
  test("with no AI budget the plain note is used, and it never invents anything", async () => {
    const h = scripted(QUIET, SEEN2, ["unused"])
    const c = readConfig(h.p.config); c.monthly_budget_usd = 0; writeConfig(h.p.config, c)
    await h.bot.handle(h.msg(7, "/followup Acme"))
    expect(h.prompts.length).toBe(0)
    expect(h.texts().at(-1)).toContain("I applied for the AI Engineer role on 2026-11-01 and wanted to check if there is any update.")
    const second = plainFollowUp({ ...readTracker(h.p.tracker).rows[0], contact_person: "Priya Rao" }, 1, "Test")
    expect(second.text.startsWith("Hi Priya,")).toBe(true)
    expect(second.text).toContain("If it has been filled, no problem at all.")
  })
  test("no follow-up before applying, after it's closed, or a third time", async () => {
    const h = scripted([
      "2026-11-01,Acme,AI,AI Engineer,AI,portal,drafted,,70,,,,https://e.com/a,",
      "2026-11-01,Bolt,AI,Voice Engineer,AI,portal,rejected,,70,,,,https://e.com/b,",
      "2026-10-01,Cove,AI,ML Engineer,AI,portal,applied,,70,followed up 2026-10-12; followed up 2026-10-23,,,https://e.com/c,",
    ], {}, ["unused"])
    await h.bot.handle(h.msg(7, "/followup Acme"))
    expect(h.texts().at(-1)).toContain("haven't applied to Acme yet")
    await h.bot.handle(h.msg(7, "/followup Bolt"))
    expect(h.texts().at(-1)).toContain("Bolt is closed")
    await h.bot.handle(h.msg(7, "/followup Cove"))
    expect(h.texts().at(-1)).toContain("already followed up twice")
    expect(h.prompts.length).toBe(0)
  })
  test("with automatic follow-ups on, the draft arrives when one is due - once", async () => {
    const h = scripted(QUIET, SEEN2, ["Subject: Checking in\n\nHi,\n\nAny update on the AI Engineer role I applied for on 2026-11-01?\n\nTest", '{"unsupported": []}'])
    const c = readConfig(h.p.config); c.daily.followups = true; writeConfig(h.p.config, c)
    await h.bot.tick(); await h.bot.whenIdle()
    await h.bot.tick(); await h.bot.whenIdle()
    expect(h.texts().filter((t) => t.startsWith("Follow-up for Acme")).length).toBe(1)
    expect(h.texts().some((t) => t.startsWith("Needs you: Follow up with Acme"))).toBe(false)
  })
  test("with them off, the reminder carries a Write follow-up button", async () => {
    const h = scripted(QUIET, SEEN2, ["Subject: s\n\nHi,\n\nAny update on the AI Engineer role?\n\nTest", '{"unsupported": []}'])
    await h.bot.tick(); await h.bot.whenIdle()
    expect(h.texts().some((t) => t.startsWith("Needs you: Follow up with Acme"))).toBe(true)
    await h.bot.handle(h.cb(7, tap(h, "Write follow-up").callback_data))
    expect(h.texts().at(-1)).toContain("Follow-up for Acme")
  })
})

describe("daily search: once every 24 hours, only when switched on", () => {
  const FOUND = {
    strong: { title: "Voice AI Engineer", company: "Bolt", url: "https://boards.greenhouse.io/bolt/1", status: "new", fit: "high", first_seen: "2026-11-16", portal: "linkedin-search" },
    weak: { title: "Sales Lead", company: "Cove", url: "https://e.com/c", status: "new", fit: "low", first_seen: "2026-11-16" },
    risky: { title: "AI Engineer", company: "Dune", url: "https://e.com/d", status: "new", fit: "high", first_seen: "2026-11-16" },
    news: { title: "Eon raises $5M", company: "Eon", url: "https://e.com/e", status: "new", fit: "high", first_seen: "2026-11-16", portal: "funding-news-search" },
  }
  function daily(apply: "off" | "ask" | "auto", replies: string[] = ["unused"], found: Record<string, unknown> = FOUND) {
    const h = scripted([], {}, replies)
    // Scoring is tested on its own below; here the keyword fit stands in for it.
    const c = readConfig(h.p.config); c.daily = { ...c.daily, search: true, time: "08:30", apply }; c.model_checks = false; c.auto_rank = false; writeConfig(h.p.config, c)
    let scans = 0
    ;(h.bot as unknown as { d: { scanFn: unknown } }).d.scanFn = async () => {
      scans++
      writeFileSync(h.p.seen, JSON.stringify({ seen: found }))
      return { portals: [{ name: "x-search", status: "failed", found: 0, added: 0 }], added: Object.keys(found), flagged: ["risky"] }
    }
    return { ...h, scans: () => scans }
  }
  test("it is off by default, and runs once a day when on", async () => {
    expect(DEFAULT_CONFIG.daily.search).toBe(false)
    const h = daily("ask")
    await h.bot.tick(); await h.bot.whenIdle()
    await h.bot.tick(); await h.bot.whenIdle()
    expect(h.scans()).toBe(1)
    const off = scripted([], {}, ["unused"])
    let ran = false
    ;(off.bot as unknown as { d: { scanFn: unknown } }).d.scanFn = async () => { ran = true; return { portals: [], added: [], flagged: [] } }
    await off.bot.tick(); await off.bot.whenIdle()
    expect(ran).toBe(false)
  })
  test("only strong, unflagged, real jobs are put forward, each with its own Apply button", async () => {
    const h = daily("ask")
    await h.bot.runDaily(7)
    const msg = h.texts().at(-1)!
    expect(msg).toContain("Today's search: 4 new jobs. One is worth your time:")
    expect(msg).toContain("1. Voice AI Engineer at Bolt")
    for (const no of ["Cove", "Dune", "Eon"]) expect(msg).not.toContain(no)
    expect(msg).toContain("x-search")
    expect(h.lastKeyboard().inline_keyboard[0].map((b) => b.text)).toEqual(["1. Apply", "Kit", "Skip"])
    // Nothing was started, and nothing was spent.
    expect(h.prompts.length).toBe(0)
    expect(readTracker(h.p.tracker).rows.length).toBe(0)
  })
  test("a quiet day is one line", async () => {
    const h = daily("ask", ["unused"], { weak: FOUND.weak })
    await h.bot.runDaily(7)
    expect(h.texts().at(-1)).toContain("none strong enough")
    expect(h.lastKeyboard()).toBeUndefined()
  })
  test("on auto the CV is written without asking, but kit-only level still leaves the sending to the owner", async () => {
    const h = daily("auto", ["drafted"])
    // Stand in for /apply: the draft run records the application, as the real command does.
    ;(h.bot as unknown as { d: { claudeExec: unknown } }).d.claudeExec = async (args: string[]) => {
      const prompt = args[args.indexOf("-p") + 1]
      h.prompts.push(prompt)
      if (prompt.includes("Compare the MESSAGE with the PROFILE")) return { code: 0, stdout: JSON.stringify({ result: '{"unsupported": []}', total_cost_usd: 0.001 }), stderr: "" }
      writeFileSync(join(h.p.root, "cv", "bolt.tex"), "\\begin{document}\n\\resumeItem{Voice}{Built a voice agent with Python, LLM and RAG for a clinic.}\n\\end{document}\n")
      writeFileSync(h.p.tracker, readFileSync(h.p.tracker, "utf8") + "2026-11-16,Bolt,AI,Voice AI Engineer,AI,online,drafted,,80,,cv/bolt.tex,cover_letters/bolt.tex,https://boards.greenhouse.io/bolt/1,\n")
      return { code: 0, stdout: JSON.stringify({ result: "Drafted.", total_cost_usd: 0.5 }), stderr: "" }
    }
    let filled = false
    ;(h.bot as unknown as { d: { fillFn: unknown } }).d.fillFn = async () => { filled = true; return { status: "submitted", message: "Sent." } }
    await h.bot.runDaily(7)
    expect(h.prompts.filter((p) => p.startsWith("/apply https://boards.greenhouse.io/bolt/1")).length).toBe(1)
    // The CV is written, then the owner sees what changed before anything else happens.
    const review = h.texts().at(-1)!
    expect(review).toContain("Ready to review: Voice AI Engineer at Bolt")
    expect(review).toMatch(/[+~] (Added|Reworded): Voice: Built a voice agent with Python, LLM and RAG for a clinic\./)
    expect(review).toContain("nothing is made up")
    expect(h.lastKeyboard().inline_keyboard[0].map((b) => b.text)).toEqual(["Looks good, apply", "Not now"])
    expect(filled).toBe(false)
    // Level L0: after "Looks good" the form is never touched; one tap opens the page, one logs it.
    await h.bot.handle(h.cb(7, h.lastKeyboard().inline_keyboard[0][0].callback_data))
    expect(filled).toBe(false)
    expect(h.texts().at(-1)).toContain("Kit: Voice AI Engineer at Bolt")
    const kb = h.lastKeyboard().inline_keyboard as unknown as { text: string; url?: string }[][]
    expect(kb[0][0]).toEqual({ text: "Open the application page", url: "https://boards.greenhouse.io/bolt/1" })
    expect(kb[1][0].text).toBe("I applied")
    expect(readTracker(h.p.tracker).rows[0].status).toBe("drafted")
    await h.bot.handle(h.cb(7, (kb[1][0] as unknown as { callback_data: string }).callback_data))
    expect(readTracker(h.p.tracker).rows[0].status).toBe("applied")
  })
  test("on auto, the daily limit stops it", async () => {
    const h = daily("auto", ["drafted"])
    const c = readConfig(h.p.config); c.daily_application_cap = 1; writeConfig(h.p.config, c)
    // The limit counts tracker rows dated today by the real clock.
    const real = new Date(); const pad = (n: number) => String(n).padStart(2, "0")
    writeFileSync(h.p.tracker, readFileSync(h.p.tracker, "utf8") + `${real.getFullYear()}-${pad(real.getMonth() + 1)}-${pad(real.getDate())},Zed,AI,Eng,AI,online,applied,,80,,,,https://e.com/z,\n`)
    await h.bot.runDaily(7)
    expect(h.prompts.length).toBe(0)
    expect(h.texts().at(-1)).toContain("reached today's limit of 1 applications")
  })
  test("settings: plain changes, clear wording, nonsense refused", async () => {
    const base = DEFAULT_CONFIG
    expect(applyDaily(base, "on 8")!.daily).toMatchObject({ search: true, time: "08:00" })
    expect(applyDaily(base, "on at 7:45")!.daily.time).toBe("07:45")
    expect(applyDaily(base, "apply auto")!.daily.apply).toBe("auto")
    expect(applyDaily(base, "followups on")!.daily.followups).toBe(true)
    expect(applyDaily(base, "on 25:00")).toBeUndefined()
    expect(applyDaily(base, "apply everything")).toBeUndefined()
    const auto = describeDaily({ ...base, daily: { ...base.daily, search: true, apply: "auto" } })
    expect(auto).toContain("you send every application yourself")
    const h = scripted([], SEEN2, [say("I'll search every morning.", ["daily on 08:00"])])
    await h.bot.handle(h.msg(7, "search every morning at 8"))
    expect(readConfig(h.p.config).daily.search).toBe(false)
    await h.bot.handle(h.cb(7, tap(h, "Yes").callback_data))
    expect(readConfig(h.p.config).daily).toMatchObject({ search: true, time: "08:00" })
    // Two changes in one reply are one question and one tap (found on a live run: they came as
    // two questions, the second describing the search as still off).
    expect(applyDaily(base, "on 08:00; apply auto")!.daily).toMatchObject({ search: true, apply: "auto" })
    expect(applyDaily(base, "on 08:00; apply everything")).toBeUndefined()
    const h2 = scripted([], SEEN2, [say("Tap Yes and I'll take it from here.", ["daily on 07:00", "daily apply auto"])])
    await h2.bot.handle(h2.msg(7, "search daily and apply yourself"))
    const asks = h2.texts().filter((t) => t.startsWith("Change this?"))
    expect(asks.length).toBe(1)
    expect(asks[0]).toContain("on, every day at 07:00")
    expect(asks[0]).toContain("without asking")
    await h2.bot.handle(h2.cb(7, tap(h2, "Yes").callback_data))
    expect(readConfig(h2.p.config).daily).toMatchObject({ search: true, time: "07:00", apply: "auto" })
  })
})
