// Reads documents/applications/*/outcome.md (status line + checked interview stages).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export interface Archive {
  folder: string
  path: string
  status?: string
  stages: string[]
  files: string[]
}

export function readArchives(dir: string): Archive[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isDirectory())
    .map((folder) => {
      const path = join(dir, folder)
      const files = readdirSync(path)
      let status: string | undefined
      const stages: string[] = []
      const om = join(path, "outcome.md")
      if (existsSync(om)) {
        const text = readFileSync(om, "utf8")
        status = text.match(/^\s*(?:\*\*)?Status:?(?:\*\*)?:?\s*`?([a-z_ ]+)`?/im)?.[1]?.trim()
        for (const m of text.matchAll(/^\s*-\s*\[x\]\s*(.+)$/gim)) stages.push(m[1].trim())
      }
      return { folder, path, status, stages, files }
    })
}
