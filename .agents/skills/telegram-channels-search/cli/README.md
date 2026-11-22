# telegram-channels-cli

CLI for reading job/lead posts from **public Telegram channels** through their
public web preview.

**Data source**: `https://t.me/s/<channel>` (list) and `https://t.me/<channel>/<id>?embed=1` (one post).
**Authentication**: none (no login, no Bot API).
**Dependencies**: none at runtime (plain `bun` + `fetch` + regex parsing). `bun install` only pulls dev types.
**Robots**: every page URL is checked with `python tools/robots_check.py <url>` first.

## Installation

```bash
cd .agents/skills/telegram-channels-search/cli
bun install --ignore-scripts   # optional: TypeScript dev types for `bun run typecheck`
```

## Commands

| Command | Description |
|---------|-------------|
| `search` | Latest ~20 messages of each channel, filtered client-side |
| `detail <channel/id\|url>` | Full text of one post |

`search` accepts `--format json|table|plain` (default `json`); `detail` accepts
`--format json|plain`. Errors go to **stderr** as `{ "error": "...", "code": "..." }`
with exit code `1`; unknown flags are rejected.

## Quick examples

```bash
bun run src/cli.ts search -c opento_dev -q python --format table
bun run src/cli.ts search --jobage 7 --remote          # channels from wrapper-data/config.json
bun run src/cli.ts detail https://t.me/opento_dev/1338 --format plain
```

## Tests

```bash
bun run typecheck
bun run test                                             # offline: recorded fixtures, stubbed fetch/robots
TELEGRAM_LIVE_CHANNEL=opento_dev bun test tests/live.test.ts   # opt-in live smoke test
```

Offline tests run on `tests/fixtures/channel-preview.html` and
`tests/fixtures/message-embed.html`, real responses trimmed and scrubbed (see
`tests/fixtures/README.md`). See `../url-reference.md` for the endpoints and markup.
