// RFC 4180 CSV parsing and serialisation. Upstream writers never quote fields,
// but users edit the tracker in spreadsheets, which do - so reading handles quotes,
// and writing quotes only when a field needs it.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  const s = text.replace(/^﻿/, "")
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"' && field === "") inQuotes = true
    else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++
      row.push(field)
      field = ""
      if (!(row.length === 1 && row[0] === "")) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== "" || row.length) {
    row.push(field)
    if (!(row.length === 1 && row[0] === "")) rows.push(row)
  }
  return rows
}

export function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function serializeRow(fields: string[]): string {
  return fields.map(csvField).join(",")
}
