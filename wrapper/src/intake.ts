// Resume intake (ONB-3): PDF via upstream verify_pdf.py, DOCX via a built-in zip reader,
// plain text as-is. Photos and scans are read by Claude in the onboarding command (it can
// see images), so this module reports them as "needs Claude" rather than guessing.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, extname, join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { run, pythonBin } from "./lib/exec.ts"

/** Minimal ZIP reader: returns one entry's bytes (stored or deflated). Enough for .docx. */
export function unzipEntry(buf: Buffer, name: string): Buffer | null {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nlen = buf.readUInt16LE(off + 28)
    const xlen = buf.readUInt16LE(off + 30)
    const clen = buf.readUInt16LE(off + 32)
    const local = buf.readUInt32LE(off + 42)
    const fname = buf.subarray(off + 46, off + 46 + nlen).toString("utf8")
    if (fname === name) {
      const lnlen = buf.readUInt16LE(local + 26)
      const lxlen = buf.readUInt16LE(local + 28)
      const start = local + 30 + lnlen + lxlen
      const data = buf.subarray(start, start + csize)
      if (method === 0) return Buffer.from(data)
      if (method === 8) return inflateRawSync(data)
      return null
    }
    off += 46 + nlen + xlen + clen
  }
  return null
}

export function docxText(file: string): string {
  const xml = unzipEntry(readFileSync(file), "word/document.xml")
  if (!xml) throw new Error("Couldn't open this Word file. Try saving it as PDF.")
  return xml
    .toString("utf8")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

const IMPORTED = "## Resume (imported as text - not yet sorted into the sections above)"

/**
 * Free path for users with no AI budget (no one left behind): put the resume text into the profile
 * verbatim, so keyword fit, kits and later drafting have the real facts. Nothing is rewritten or
 * inferred. Replaces an earlier import rather than stacking them.
 */
export function importResumeToProfile(profilePath: string, text: string): void {
  const prev = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "# Candidate Profile\n"
  const base = prev.includes(IMPORTED) ? prev.slice(0, prev.indexOf(IMPORTED)).replace(/\s*$/, "") : prev.replace(/\s*$/, "")
  const body = text.replace(/\r/g, "").replace(/^#+\s/gm, "").trim()
  writeFileSync(profilePath, `${base}\n\n${IMPORTED}\n<!-- Copied word for word by jobdesk. Every fact here is the candidate's own. -->\n\n${body}\n`, "utf8")
}

/**
 * The PDF's text layer, read with pypdf (installed by install.sh), then pdftotext if pypdf is missing.
 * Upstream verify_pdf.py can't be used here: it only writes text dumps inside cv/ and cover_letters/.
 * An empty result means a scan or photo, which Claude has to read.
 */
export async function pdfText(file: string): Promise<string> {
  const script = "import sys,pypdf\nr=pypdf.PdfReader(sys.argv[1])\nsys.stdout.reconfigure(encoding='utf-8')\nprint('\\n'.join((p.extract_text() or '') for p in r.pages))"
  const py = await run(pythonBin(), ["-c", script, file], { cwd: tmpdir(), timeoutMs: 60_000 })
  if (py.code === 0 && py.stdout.trim()) return py.stdout.replace(/\r/g, "").trim()
  const pt = await run("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { timeoutMs: 60_000 })
  return pt.code === 0 ? pt.stdout.replace(/\r/g, "").trim() : ""
}

export interface Intake {
  kind: "pdf" | "docx" | "text" | "image" | "unknown"
  text: string
  needsClaude: boolean
  copiedTo?: string
}

/** Read a resume and copy it into documents/cv/ (where upstream /setup looks). */
export async function readResume(root: string, file: string): Promise<Intake> {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`)
  const ext = extname(file).toLowerCase()
  const cvDir = join(root, "documents", "cv")
  mkdirSync(cvDir, { recursive: true })
  const dest = join(cvDir, basename(file))
  if (dest !== file && !existsSync(dest)) copyFileSync(file, dest)
  if (ext === ".pdf") {
    const text = await pdfText(file)
    return { kind: "pdf", text, needsClaude: !text, copiedTo: dest }
  }
  if (ext === ".docx") return { kind: "docx", text: docxText(file), needsClaude: false, copiedTo: dest }
  if ([".txt", ".md", ".tex"].includes(ext)) return { kind: "text", text: readFileSync(file, "utf8"), needsClaude: false, copiedTo: dest }
  if ([".png", ".jpg", ".jpeg", ".webp", ".heic"].includes(ext)) return { kind: "image", text: "", needsClaude: true, copiedTo: dest }
  return { kind: "unknown", text: "", needsClaude: true, copiedTo: dest }
}
