// Tiny Telegram Bot API client over long polling (MSG-1): no server, no public URL,
// works behind home NAT. fetch is injectable so tests run offline.

import { readFileSync } from "node:fs"
import { basename } from "node:path"

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface TgUser {
  id: number
  first_name?: string
  username?: string
}

export interface TgMessage {
  message_id: number
  chat: { id: number; type: string }
  from?: TgUser
  text?: string
  caption?: string
  reply_to_message?: TgMessage
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  photo?: { file_id: string; file_size?: number; width: number; height: number }[]
}

export interface TgCallback {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallback
}

export type Button = { text: string; callback_data?: string; url?: string }
export type Keyboard = Button[][]

export class Telegram {
  constructor(
    private token: string,
    private f: FetchFn = fetch,
    private base = "https://api.telegram.org",
  ) {}

  private async call<T>(method: string, body: Record<string, unknown> | FormData, retried = false): Promise<T> {
    const isForm = body instanceof FormData
    const r = await this.f(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
    })
    let j: { ok: boolean; result: T; description?: string; parameters?: { retry_after?: number } }
    try {
      j = (await r.json()) as typeof j
    } catch {
      // A proxy or outage page instead of JSON.
      throw new Error(`Telegram ${method}: no answer (HTTP ${r.status})`)
    }
    if (!j.ok) {
      const wait = j.parameters?.retry_after
      if (wait) {
        // "Too many requests": wait as told and try once more, so the message isn't lost.
        await Bun.sleep(Math.min(wait, 30) * 1000)
        if (!retried && wait <= 30) return this.call<T>(method, body, true)
      }
      throw new Error(`Telegram ${method}: ${j.description ?? r.status}`)
    }
    return j.result
  }

  getUpdates(offset: number, timeout = 30): Promise<TgUpdate[]> {
    return this.call("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] })
  }

  getMe(): Promise<TgUser> {
    return this.call("getMe", {})
  }

  /** Telegram caps messages at 4096 chars; long texts are split on line breaks. */
  async send(chatId: number, text: string, keyboard?: Keyboard): Promise<void> {
    const chunks: string[] = []
    let cur = ""
    for (const line of text.split("\n")) {
      if ((cur + "\n" + line).length > 3800) {
        chunks.push(cur)
        cur = line
      } else cur = cur ? cur + "\n" + line : line
    }
    if (cur) chunks.push(cur)
    for (let i = 0; i < chunks.length; i++) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: chunks[i],
        disable_web_page_preview: true,
        ...(keyboard && i === chunks.length - 1 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      })
    }
  }

  async sendFile(chatId: number, path: string, kind: "photo" | "document", caption?: string, keyboard?: Keyboard): Promise<void> {
    const form = new FormData()
    form.set("chat_id", String(chatId))
    if (caption) form.set("caption", caption.slice(0, 1000))
    if (keyboard) form.set("reply_markup", JSON.stringify({ inline_keyboard: keyboard }))
    form.set(kind, new Blob([readFileSync(path)]), basename(path))
    await this.call(kind === "photo" ? "sendPhoto" : "sendDocument", form)
  }

  /** Download a file the user sent (Telegram's limit for bots is 20 MB). */
  async downloadFile(fileId: string): Promise<Buffer> {
    const f = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId })
    if (!f.file_path) throw new Error("Telegram didn't give a download path for that file.")
    const r = await this.f(`${this.base}/file/bot${this.token}/${f.file_path}`)
    if (!r.ok) throw new Error(`Couldn't download the file (HTTP ${r.status}).`)
    return Buffer.from(await r.arrayBuffer())
  }

  /** Shows "typing..." in the chat for about five seconds. */
  typing(chatId: number): Promise<boolean> {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" })
  }

  /** The command list Telegram shows when the user types "/" or taps the menu button. */
  setCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    return this.call("setMyCommands", { commands })
  }

  answerCallback(id: string, text?: string): Promise<boolean> {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) })
  }
}
