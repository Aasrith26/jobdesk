---
name: shine-search
version: 1.0.0
description: >
  Use this skill whenever the user wants to search for jobs in India on Shine.com,
  find Indian job listings, or look up a specific Shine job posting, even if they
  don't name Shine explicitly but the context is the Indian job market. Invoke for
  open positions, vacancies, naukri (jobs), hiring, and fresher or experienced roles
  in Indian cities such as Hyderabad, Bangalore/Bengaluru, Pune, Chennai, Mumbai,
  Delhi NCR, Noida, Gurgaon and Kolkata. Trigger phrases include: shine, shine.com,
  shine jobs, jobs in india, job search india, india job vacancies, naukri, naukri
  chahiye, naukri khoj, rozgar, job openings hyderabad, jobs in
  bangalore, AI engineer jobs india, machine learning engineer jobs hyderabad,
  generative ai jobs bangalore, data scientist jobs pune, python developer jobs
  chennai, software engineer jobs india, hiring in india, find work in india.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/shine-search/cli/src/cli.ts *)
---

# Shine Search Skill

Search live Indian job listings from **Shine.com** (HT Media), one of India's large
job portals. No authentication, no API key, and **zero runtime dependencies**: the
CLI reads Shine's public, server-rendered search and job pages with plain `bun`.

## ⚠️ Personal use only

This reads Shine.com's public pages with an honest User-Agent
(`Mozilla/5.0 (compatible; shine-cli/1.0)`). Shine's `robots.txt` allows the search
(`/job-search/...`) and job (`/jobs/<title>/<company>/<id>`) pages this CLI uses, and
disallows `/api/*` and a few other paths, which the CLI never requests. Shine's terms
of use still govern the content: **keep volume low (a handful of searches, not a
crawl), don't use it commercially or for bulk data collection, and run it on your own
responsibility.**

## When to use this skill

- Search Indian job openings by keyword (title, skill) and city
- Restrict to recent postings (`--jobage`) or sort newest first (`--sort date`)
- Get the full description, experience band, salary, skills and validity of one posting

## Commands

### Search job listings

```bash
bun run .agents/skills/shine-search/cli/src/cli.ts search -q "<keywords>" [-l "<city>"] [flags]
```

| Flag | Meaning |
|------|---------|
| `--query`, `-q <text>` | Job title / skill keywords, e.g. `"machine learning engineer"`. |
| `--location`, `-l <city>` | City, e.g. `Hyderabad`, `Bangalore`, `Pune`, `"New Delhi"`. Only the part before the first comma is used. |
| `--jobage <days>` | Only postings at most N days old. **Filtered client-side** (Shine has no age parameter) on the fetched page. |
| `--sort relevance\|date` | `relevance` (default) or `date` (Shine's "Most recent"). |
| `--page <n>` | 1-indexed page, 20 results per page. |
| `--limit <n>` | Cap results emitted (client-side). |
| `--format json\|table\|plain` | Default `json`. |

At least one of `--query` / `--location` is required. Unknown flags, missing values
and non-integer numbers exit 1 with a JSON error.

### Fetch full job detail

```bash
bun run .agents/skills/shine-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

`id` is the numeric id from `search` results (e.g. `19984543`); a full
`https://www.shine.com/jobs/<title>/<company>/<id>` URL (query string optional) also works.
Returns title, company, location, posted date, `validThrough` + `expired`, experience,
salary, employment type, industry, skills, and the full description.

## Usage examples

```bash
# ML engineer roles in Hyderabad
bun run .agents/skills/shine-search/cli/src/cli.ts search -q "machine learning engineer" -l Hyderabad --format table

# AI engineer roles in Hyderabad posted in the last 7 days, newest first
bun run .agents/skills/shine-search/cli/src/cli.ts search -q "ai engineer" -l Hyderabad --sort date --jobage 7 --format table

# Generative AI roles in Bangalore, page 2
bun run .agents/skills/shine-search/cli/src/cli.ts search -q "generative ai" -l Bangalore --page 2 --format table

# Data scientist roles in Pune, first 10 as JSON
bun run .agents/skills/shine-search/cli/src/cli.ts search -q "data scientist" -l Pune --limit 10

# NLP engineer roles anywhere in India
bun run .agents/skills/shine-search/cli/src/cli.ts search -q "nlp engineer" --format table

# Full description of one posting
bun run .agents/skills/shine-search/cli/src/cli.ts detail 19984543 --format plain
```

Natural workflow: `search` to find ids, then `detail <id>` for the postings worth reading.

## Output

| Format | Best for |
|--------|----------|
| `json` | Default: `{ "meta": {...}, "results": [...] }`, passing ids to `detail` |
| `table` | Quick human-readable scan |
| `plain` | Reading results or a single job's full detail |

Each search result has `id`, `title`, `company`, `location`, `date` (YYYY-MM-DD),
`postedAt` (ISO, IST), `posted` (Shine's relative label), `experience`, `salary`,
`skills[]`, `badges[]`, `url`; missing values are `null`, never omitted. `meta` carries
`count`, `page`, `total`, `pageCount`, `hasNextPage`, `sort`, `jobage`, `pageTitle`,
`renderedAt` and the fetched `url`.

All errors go to **stderr** as `{ "error": "...", "code": "..." }` with exit code `1`.

## Notes (portal quirks)

- **Keyword matching is slug-based and loose.** The query becomes a URL slug
  (`ai-engineer-jobs-in-hyderabad`). Shine silently drops keywords it doesn't know: `"llm
  engineer"` in New Delhi returned electrical-engineer jobs. Prefer established titles
  ("ai engineer", "machine learning engineer", "generative ai", "data scientist", "nlp
  engineer") and check result titles. `meta.pageTitle` (Shine's SEO title) sometimes
  hints at the rewrite but is not a reliable echo.
- **Results spill outside the city.** Shine includes "All India" and multi-city postings
  in a city search; check `location`.
- **`--sort date` is fresher but less relevant**: it returned postings like "Production
  Engineer" for `ai engineer`. Use it with `--jobage` when you need only new postings,
  and skim titles.
- **Some search pages are stale snapshots.** A relevance page can be served from a
  server-side render days or weeks old (one was 17 days old). `meta.renderedAt` shows
  when the page was rendered; the `posted` label ("2 days ago") is relative to that, while
  `postedAt`/`date` are absolute. `--jobage` uses `postedAt`, so it stays correct, but a
  stale page may yield 0 fresh results: try `--sort date`.
- **`--jobage` filters only the fetched page** (20 cards), so `count` can be below 20 and
  there may be more matches on later pages.
- An unknown keyword slug can return HTTP 404; the CLI reports that as 0 results.
- Location: use Shine's city spelling (`bangalore`, `gurgaon`, `new delhi`); there is no
  remote filter.
- Detail by bare id fetches `/jobs/job/company/<id>`; Shine serves the posting for any slug
  and its canonical link gives the real URL, which the CLI returns.
- Expired postings: `validThrough` / `expired` come from the JobPosting JSON-LD;
  removed postings return `NOT_FOUND`.
