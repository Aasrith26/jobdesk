// Small JSON file helpers: atomic writes so a crash never leaves half a file.

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs"
import { dirname } from "node:path"

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`)
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8")
  renameSync(tmp, file)
}

export function appendJsonl(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(value) + "\n", "utf8")
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T]
      } catch {
        return []
      }
    })
}

export function today(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function daysBetween(a: string, b: string): number {
  const da = Date.parse(a.length === 10 ? a + "T00:00:00" : a)
  const db = Date.parse(b.length === 10 ? b + "T00:00:00" : b)
  if (Number.isNaN(da) || Number.isNaN(db)) return NaN
  return Math.round((db - da) / 86_400_000)
}
