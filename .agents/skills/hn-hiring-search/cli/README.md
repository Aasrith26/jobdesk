# hn-hiring-cli

CLI for searching the job posts in Hacker News' monthly **"Ask HN: Who is
hiring?"** threads.

**Data source**: the official public Algolia HN Search API
(`hn.algolia.com/api/v1/search`, `/search_by_date`) and the HN Firebase API
(`hacker-news.firebaseio.com/v0/item/<id>.json`).
**Authentication**: none.
**Dependencies**: none at runtime (plain `bun` + `fetch` + regex parsing). `bun install` only pulls dev types.

## Installation

```bash
cd .agents/skills/hn-hiring-search/cli
bun install --ignore-scripts   # optional: TypeScript dev types for `bun run typecheck`
```

## Commands

| Command | Description |
|---------|-------------|
| `search` | Search top-level comments (job posts) of the latest monthly thread(s) |
| `detail <id\|url>` | Full text + parsed header of one HN job post |

`search` accepts `--format json|table|plain` (default `json`); `detail` accepts
`--format json|plain`. Errors go to **stderr** as `{ "error": "...", "code": "..." }`
with exit code `1`; unknown flags are rejected.

## Quick examples

```bash
bun run src/cli.ts search -q "LLM" --remote --limit 10 --format table
bun run src/cli.ts search -q "voice" --india-friendly --months 2 --format table
bun run src/cli.ts search -q "inference" -l "Bengaluru" --months 3
bun run src/cli.ts detail 49997244 --format plain
```

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords passed to Algolia (searches the whole comment). |
| `--months` | | Recent monthly threads to search, 1-12. Default 1. |
| `--thread` | | One specific thread (HN story id). Excludes `--months`. |
| `--location` | `-l` | Case-insensitive substring of the header line. |
| `--remote` | | Header mentions REMOTE. |
| `--india-friendly` | | Looks open to a candidate in India (see `../SKILL.md`). |
| `--jobage` | | Posted within N days. |
| `--page` | | 1-indexed page of filtered results. Default 1. |
| `--limit` | `-n` | Results per page, 0-1000. Default 25. |
| `--format` | | `json` \| `table` \| `plain`. |

## Tests

```bash
bun run typecheck
bun run test                       # offline suites + a 3-4 request live smoke test
HN_HIRING_SKIP_LIVE=1 bun run test # offline only
```

Offline tests run on `tests/fixtures/thread-comments.json`, a synthetic Algolia
response (see `tests/fixtures/README.md`). See `../url-reference.md` for the
endpoints and the parsing anchors.
