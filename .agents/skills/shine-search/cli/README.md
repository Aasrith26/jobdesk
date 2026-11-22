# shine-cli

CLI for searching jobs on **Shine.com** (India).

**Data source**: Shine's public, server-rendered search pages (`/job-search/<kw>-jobs-in-<city>`)
and job pages (`/jobs/<title>/<company>/<id>`). See `../url-reference.md`.
**Authentication**: none.
**Dependencies**: none (plain `bun` + `fetch` + regex parsing). `bun install` only pulls dev types.

> **Personal use only.** Keep volume low, don't use it commercially or for bulk collection.
> The CLI never requests the paths Shine's robots.txt disallows (`/api/*` and others).

## Installation

```bash
cd .agents/skills/shine-search/cli
bun install   # optional: TypeScript dev types for typecheck
```

## Commands

| Command | Description |
|---------|-------------|
| `search` | Search listings (`-q` and/or `-l` required) |
| `detail <id\|url>` | Full detail for one posting |

`search` flags: `-q/--query`, `-l/--location`, `--jobage <days>` (client-side filter),
`--sort relevance|date`, `--page <n>` (20/page), `--limit <n>`, `--format json|table|plain`.
`detail` flags: `--format json|plain`.

Errors go to **stderr** as `{ "error": "...", "code": "..." }` with exit code `1`
(`UNKNOWN_FLAG`, `BAD_ARG`, `MISSING_REQUIRED`, `NO_ID`, `BAD_ID`, `NOT_FOUND`, `SEARCH_FAILED`,
`DETAIL_FAILED`, `BAD_CMD`).

## Quick examples

```bash
bun run src/cli.ts search -q "machine learning engineer" -l Hyderabad --format table
bun run src/cli.ts search -q "ai engineer" -l Hyderabad --sort date --jobage 7 --format table
bun run src/cli.ts detail 19984543 --format plain
```

## Development

```bash
bun run typecheck
bun run test                     # offline fixture tests + one live smoke test (2 requests)
SKIP_LIVE_TESTS=1 bun run test   # offline only
```

Fixtures in `tests/fixtures/` are trimmed copies of real pages (two real cards plus a malformed
card and a card with hidden/zero-width injected text; one job page with a hidden span injected).
