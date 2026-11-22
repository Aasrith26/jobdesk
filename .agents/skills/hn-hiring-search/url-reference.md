# HN "Who is hiring?" API reference

The endpoints, parameters and response shapes this skill depends on. Update this
file if Algolia or the HN API change. Both APIs are official, public, and
unauthenticated; all were verified live (HTTP 200) on 2026-11-09.

| Endpoint | Used for |
|----------|----------|
| `GET https://hn.algolia.com/api/v1/search_by_date` | Listing the monthly threads; listing a thread's posts (no `-q`) |
| `GET https://hn.algolia.com/api/v1/search` | Searching a thread's posts by keyword (`-q`) |
| `GET https://hacker-news.firebaseio.com/v0/item/<id>.json` | `detail`, its parent thread, and `--thread` resolution |
| `GET https://hn.algolia.com/api/v1/items/<id>` | Not used: returns the item **with its whole reply tree** (heavy for a thread) |

Every request sends `User-Agent: Mozilla/5.0 (compatible; hn-hiring-cli/1.0)` and
`Accept: application/json`, a 20 s timeout, and exponential backoff with jitter on
429/5xx (500 ms doubling to 8 s, max 6 retries). 404 -> `null`.

## 1. Find the threads

```
GET /api/v1/search_by_date?tags=story,author_whoishiring&query=who%20is%20hiring
    &hitsPerPage=<months*3+6>&attributesToRetrieve=title,created_at&attributesToHighlight=[]
```

`whoishiring` posts up to three stories a month at the same second:
"Ask HN: Who is hiring? (Month YYYY)", "Ask HN: Who wants to be hired? (...)" and
(historically) "Ask HN: Freelancer? Seeking freelancer? (...)". The CLI keeps
titles matching `/^ask hn:\s*who is hiring\?/i`, newest first, and takes the
first `--months`.

Hit fields used: `objectID` (story id), `title`, `created_at`.

## 2. Search a thread's job posts

```
GET /api/v1/search            (with -q; relevance order)
GET /api/v1/search_by_date    (without -q; newest first)
    ?tags=comment,story_<threadId>
    &numericFilters=parent_id=<threadId>[,created_at_i><epoch>]
    &query=<q>
    &hitsPerPage=1000&page=<p>
    &attributesToRetrieve=comment_text,author,created_at,created_at_i,parent_id,story_id
    &attributesToHighlight=[]
```

| Param | Notes |
|-------|-------|
| `tags=comment,story_<id>` | AND of tags: comments inside that story. |
| `numericFilters=parent_id=<id>` | Restricts to **top-level** comments (the job posts). `parent_id` is a numeric attribute in the HN index; verified: November 2026 thread = 314 comments, 212 top-level. `created_at_i>N` implements `--jobage`. |
| `query` | Algolia full-text over `comment_text` (all words, typo-tolerant, prefix on last word). |
| `hitsPerPage` | Up to 1000; one page normally covers a month. The CLI reads at most 3 pages per thread and follows `nbPages`. |
| `attributesToRetrieve` / `attributesToHighlight=[]` | Cut the payload roughly in half (≈650 KB -> ≈330 KB for a full month); `[]` drops `_highlightResult`. |

Response: `{ hits: [...], nbHits, nbPages, page, hitsPerPage, ... }`. Hit fields:

```jsonc
{
  "objectID": "50425675",              // -> result.id
  "comment_text": "Company | Role | ...<p>Body ...",   // HTML
  "author": "someone",
  "created_at": "2026-11-09T13:57:09Z",   // -> result.date (first 10 chars)
  "created_at_i": 1794232629,
  "parent_id": 50338728,                 // == story_id for top-level comments
  "story_id": 50338728
}
```

## 3. Item detail (Firebase)

```
GET https://hacker-news.firebaseio.com/v0/item/<id>.json
```

Comment: `{ id, type: "comment", by, text (HTML), time (epoch s), parent, kids?, dead?, deleted? }`.
A missing id answers `200` with body `null`. Story (thread): `{ id, type: "story", title, time, kids, ... }`.
`detail` fetches the comment, then its `parent` to learn whether it is a
top-level post in a "Who is hiring?" thread (2 small requests).

## Comment HTML

HN comment text is sanitized HTML: paragraphs are separated by `<p>` (newer
comments also carry raw `\n`), links are `<a href="..." rel="nofollow">` with the
**visible text truncated** to ~60 chars + `...` (so the CLI uses the `href`),
entities are hex-escaped (`&#x2F;`, `&#x27;`, `&quot;`, `&amp;`), plus `<i>`,
`<pre><code>`. Processing: `visibleHtml` -> anchors replaced by their href ->
`<p>` to blank line -> tags stripped -> entities decoded in one pass ->
`stripInvisible` on every output string.

## Header parsing anchors (`cli/src/helpers.ts`)

- Header = first line of the first paragraph; if that paragraph is 2-6 short
  lines with no pipe, they are joined with ` | ` (one-field-per-line style).
- Fields split on `|`, or on spaced `-`/`–`/`—`/`•` when there is no pipe.
- First field = company, unless it looks like a place / work mode, a URL, or a
  role (`Software Engineer — Remote — US Only`).
- Other fields classified in order: URL (skipped) -> work mode
  (`remote|onsite|on-site|hybrid|in office|in person`; kept as location when it
  carries more than the bare mode) -> role keywords (title, first one wins) ->
  salary (currency, `NNk`, `equity`, `/hr`) -> employment type -> geography
  (country/region/city/timezone list, `City, ST`) -> unclassified.
- Fields over 14 words are body text that ran into the header: cut after an
  early `)` or dropped.
