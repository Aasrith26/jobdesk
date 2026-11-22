import {
  buildPost,
  extractLinks,
  parseFeed,
  postFeedUrl,
  postText,
  robotsAllowed,
  splitContent,
  stripInvisible,
  textFetch,
  writeError,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const url = postFeedUrl(opts.id)
  if (!url) {
    writeError(
      `Could not parse a Reddit post from "${opts.id}" (pass a post id or a reddit.com/r/<sub>/comments/<id>/... URL)`,
      "BAD_ID",
    )
    return 1
  }
  const robots = robotsAllowed(url)
  if (!robots.allowed) {
    writeError(`robots.txt check did not allow ${url}: ${robots.message}; nothing was fetched`, "ROBOTS_DISALLOWED")
    return 1
  }
  try {
    const xml = await textFetch(url)
    const entries = xml ? parseFeed(xml) : []
    // The post's own feed: the first t3_ entry is the post, t1_ entries are comments.
    const entry = entries.find((e) => /^t3_/i.test(e.fullname))
    const post = entry ? buildPost(entry) : null
    if (!entry || !post) {
      writeError(`Reddit post not found at ${url} (deleted, removed, or not a post)`, "NOT_FOUND")
      return 1
    }
    const { snippet: _snippet, ...rest } = post
    const job = stripInvisible({
      ...rest,
      comment_count_in_feed: entries.filter((e) => /^t1_/i.test(e.fullname)).length,
      links: extractLinks(splitContent(entry.contentHtml).body),
      description: postText(entry) || null,
    })

    if (opts.format === "plain") {
      const head = [
        job.header.split("\n")[0],
        `${job.company} (${job.kind}) · ${job.location ?? "—"} · ${job.date ?? "—"}`,
        `Posted in ${job.thread_title ?? "—"} by ${job.author ? `u/${job.author}` : "—"}`,
        job.salary ? `Salary: ${job.salary}` : "",
      ].filter(Boolean)
      const foot = [`URL: ${job.url}`, job.apply_url ? `Link: ${job.apply_url}` : ""].filter(Boolean)
      process.stdout.write([head.join("\n"), job.description ?? "(no text)", foot.join("\n")].join("\n\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
