# remote-boards-cli

CLI that searches five public remote-job boards at once — **Remote OK, Himalayas,
Jobicy, We Work Remotely (RSS) and Working Nomads** — merges and dedupes the
results, and can keep only roles open to candidates in India (`--india-friendly`).

**Data sources**: the boards' public JSON APIs / RSS feed (see `../url-reference.md`).
**Authentication**: none.
**Dependencies**: none (plain `bun` + `fetch` + regex parsing). `bun install` is optional and only pulls dev type defs.

> **Credit the boards.** Each board allows this use on the condition that results
> link back to it and name it as the source; every result's `url` is the board's
> own posting page and the output includes attribution lines. Keep volume low (one
> request per board per search). Remotive is excluded because its robots.txt
> disallows `/api/*`.

## Installation

```bash
cd .agents/skills/remote-boards-search/cli
bun install --ignore-scripts   # optional — only installs TypeScript dev types
```

## Commands

| Command | Description |
|---------|-------------|
| `search` | Query the selected boards in parallel, filter, dedupe, page |
| `detail` | Full description of one posting (`<source:id>` or a board URL) |

`search` accepts `--format json|table|plain` (default `json`); `detail` accepts `--format json|plain`.
Errors go to **stderr** as `{ "error": "...", "code": "..." }` with exit code `1`. A
single failing board is not an error: it is reported in `meta.errors` (and as a
stderr warning in table/plain mode).

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Phrase matched against title, tags, description; uppercase `OR` for alternatives. |
| `--title-only` | | Match `-q` against title + tags only. |
| `--source` | `-s` | `remoteok,himalayas,jobicy,weworkremotely,workingnomads` (alias `wwr`). Default all. |
| `--india-friendly` | | Keep Worldwide/Anywhere/APAC/Asia/India/unspecified roles; drop US-only, EU-only etc. |
| `--region` | | Substring of the location-restriction text (comma = OR); `worldwide` matches Anywhere/Global. |
| `--jobage` | | Posted within N days (client-side). |
| `--page` | | 1-indexed page over merged results. Default 1. |
| `--limit` | `-n` | Results per page. Default 25. |
| `--timeout` | | Per-request timeout in seconds. Default 15. |
| `--format` | | `json` \| `table` \| `plain`. |

## Quick examples

```bash
bun run src/cli.ts search -q "machine learning" --india-friendly --limit 10 --format table
bun run src/cli.ts search -q "llm OR rag OR vllm" --india-friendly --jobage 14 --format table
bun run src/cli.ts search -q "ai engineer" --title-only --source himalayas,wwr --format plain
bun run src/cli.ts detail himalayas:jumpcloud/staff-data-scientist-machine-learning-india --format plain
```

## Tests

```bash
bun run typecheck
bun run test                               # offline suite + one small live smoke search
REMOTE_BOARDS_SKIP_LIVE=1 bun run test     # offline only
```

The offline tests stub `fetch` with synthetic fixtures shaped like each board's
response (`tests/fixtures/boards.ts`); the live smoke test makes one search against
two boards.
