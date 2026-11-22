import { htmlFetch, normalizeDetailInput, parseJobDetail, stripInvisible, writeError } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const target = normalizeDetailInput(opts.id)
  if (!target) {
    writeError(
      `Could not parse a Shine job id from "${opts.id}" - pass the numeric id from search results or a https://www.shine.com/jobs/<title>/<company>/<id> URL`,
      "BAD_ID",
    )
    return 1
  }
  try {
    const html = await htmlFetch(target.url)
    if (!html) {
      writeError(`Job ${target.id} not found (404) - it may have been removed`, "NOT_FOUND")
      return 1
    }
    const job = stripInvisible(parseJobDetail(html, target.id))
    if (job.title === "(untitled)" && !job.description) {
      writeError(`Job ${target.id} page did not contain a job posting`, "NOT_FOUND")
      return 1
    }

    if (opts.format === "plain") {
      const lines = [
        job.title,
        `${job.company || "-"} · ${job.location || "-"}`,
        "",
        job.date ? `Posted: ${job.date}` : "",
        job.validThrough ? `Valid through: ${job.validThrough.slice(0, 10)}${job.expired ? " (EXPIRED)" : ""}` : "",
        job.experience ? `Experience: ${job.experience}` : "",
        job.salary ? `Salary: ${job.salary}` : "",
        job.employmentType ? `Employment: ${job.employmentType}` : "",
        job.industry ? `Industry: ${job.industry}` : "",
        job.skills.length ? `Skills: ${job.skills.join(", ")}` : "",
        "",
        job.description || "(no description)",
        "",
        `URL: ${job.url}`,
      ].filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
      process.stdout.write(lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
