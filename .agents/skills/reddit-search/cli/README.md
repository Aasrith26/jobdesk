# reddit-cli

CLI for reading job posts from **public subreddit RSS/Atom feeds**.

**Data source**: `https://www.reddit.com/r/<sub>/new/.rss?limit=<n>` and `<permalink>.rss`.
**Authentication**: none (no OAuth, no JSON API, no login).
**Dependencies**: none at runtime (plain `bun` + `fetch` + regex parsing). `bun install` only pulls dev types.
**Robots**: every URL is checked with `python tools/robots_check.py <url>` first.
reddit.com's robots.txt disallowed all paths on 2026-11-11, so the CLI currently
stops with `ROBOTS_DISALLOWED` before any feed request (see `../SKILL.md`).

## Installation

```bash
cd .agents/skills/reddit-search/cli
bun install --ignore-scripts   # optional: TypeScript dev types for `bun run typecheck`
```

## Commands

| Command | Description |
|---------|-------------|
| `search` | Newest posts of each subreddit feed, filtered client-side |
| `detail <id\|url>` | Full text of one post |

`search` accepts `--format json|table|plain` (default `json`); `detail` accepts
`--format json|plain`. Errors go to **stderr** as `{ "error": "...", "code": "..." }`
with exit code `1`; unknown flags are rejected.

## Quick examples

```bash
bun run src/cli.ts search -q python --format table
bun run src/cli.ts search -s forhire,remotejs -q react --jobage 7
bun run src/cli.ts detail https://www.reddit.com/r/forhire/comments/<id>/<slug>/ --format plain
```

## Tests

```bash
bun run typecheck
bun run test                                   # offline: synthetic feed fixtures, stubbed fetch/robots
REDDIT_SEARCH_LIVE=1 bun test tests/live.test.ts   # opt-in live smoke test
```

See `tests/fixtures/README.md` for why the fixtures are synthetic and
`../url-reference.md` for the feed layout.
