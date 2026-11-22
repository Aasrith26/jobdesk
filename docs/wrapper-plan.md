# Wrapper Build Plan

Status: v0.1 (2026-11-11). Built as v1 on 2026-11-11. It implements [wrapper-requirements.md](wrapper-requirements.md) and follows decisions D1–D5 from that document. Requirement IDs (DSH-2, C-1 and so on) refer to it.

## 1. Architecture

```
 Phone: Telegram (core) / WhatsApp via OpenClaw (opt-in)   Browser: http://127.0.0.1:<port>
                     │                                                │
                     ▼                                                ▼
          wrapper/bin/bridge.ts (phase 2)              wrapper/bin/dashboard.ts (phase 1)
                     │  fixed commands only                           │  read-only
                     ▼                                                │
     claude -p  (user's own login, restricted --allowedTools)         │
                     │  runs upstream commands unchanged              │
                     ▼                                                ▼
  ┌──────────────────────── files on disk (the only shared state) ────────────────────────┐
  │ upstream-owned: job_search_tracker.csv · job_scraper/seen_jobs.json · documents/...   │
  │ wrapper-owned:  wrapper-data/ (leads, attention, answer bank, config, run logs)       │
  └────────────────────────────────────────────────────────────────────────────────────────┘
                     ▲
          wrapper/bin/scan.ts (zero-model tier): portal + lead-source CLIs → scrape_state.py store
```

**Design rules:**
- **Only upstream code writes upstream data.** Scraped jobs go in through `tools/scrape_state.py store`. Tracker rows are written by the upstream `/apply` and `/outcome` commands, or later by a writer that follows the same rules. The dashboard only reads.
- **The wrapper owns only these paths:**
  - `wrapper/`
  - `wrapper-data/`
  - `docs/wrapper-*.md`
  - new `.agents/skills/<source>-search/` directories, the same extension point `/add-portal` uses

  That is what makes C-1 and C-2 hold.
- **No changes to `.claude/settings.json` or `.gitignore`,** since both are owned upstream and checked by `security_guards.py`:
  - `wrapper-data/` ignores itself through its own `.gitignore` containing `*`.
  - New source CLIs get their permissions from their `SKILL.md` `allowed-tools` line, as the existing portal skills do.
  - The plugin ships **no hooks**, matching upstream's security stance.
- **bun is the runtime** for everything new. Upstream already needs it for the portal CLIs, so this adds nothing to install and uses no npm dependencies by default.

## 2. Directory layout

```
wrapper/                        # plugin root; can be lifted into its own repo (D4)
  .claude-plugin/plugin.json    # namespaced commands, so no name collisions (C-6)
  commands/                     # e.g. dashboard, scan, lead, kit (phase 2+)
  bin/
    dashboard.ts                # phase 1
    scan.ts                     # phase 1, zero-model
    bridge.ts                   # phase 2
  src/
    data/        tracker.ts seen.ts leads.ts paths.ts     # readers + status normalisation
    dashboard/   server.ts page.ts sse.ts
    sources/     registry.ts policy.ts                     # which sources/sites, on what terms
    safety/      scam.ts discrimination.ts                 # rules first, zero-model
    links/       paste.ts                                  # paste-a-link: fetch → guard → store
  tests/                        # bun test, network-free with fixtures
  fixtures/                     # tracker/seen samples incl. legacy spellings; scam/legit sets
wrapper-data/                   # personal data, never committed
  .gitignore                    # "*"
  config.json leads.json attention.json answer_bank.json runs/
.agents/skills/
  reddit-search/                # new lead sources, upstream portal contract
  telegram-channels-search/
  github-helpwanted-search/
```

## 3. Phase 1: dashboard, lead sources, zero-model tier

Each task lists the requirements it covers. Sizes are S (half a day or less), M (1–2 days) and L (3 days or more).

| # | Task | Covers | Size | Done when |
|---|------|--------|------|-----------|
| W1.1 | Plugin skeleton: `plugin.json`, the self-ignoring `wrapper-data/`, a path resolver that finds the host repo | C-1, C-6 | S | The plugin installs from a local marketplace, `/<plugin>:dashboard` appears, and `git status` shows no changes to upstream-tracked files. |
| W1.2 | Data readers: tracker CSV (13- and 14-field rows, legacy status spellings), `seen_jobs.json`, `documents/applications/*/outcome.md` | DSH-1, C-4 | M | Fixture tests reproduce `/html-report`'s bucket mapping exactly, including `no response` and unknown values. |
| W1.3 | Dashboard server: `Bun.serve` bound to 127.0.0.1, `fs.watch`, live updates over SSE, a single inline page with no external requests | DSH-2, DSH-5, DSH-7 | M | Editing the tracker updates the page in ≤ 5 s, the browser's network log shows only localhost, and 500 fixture rows render in ≤ 2 s. |
| W1.4 | Dashboard views: pipeline board, application detail with file links, results by source and channel, and the scraped/ranked funnel from `seen_jobs` | DSH-1, DSH-3, DSH-4 | M | Counts match a hand-computed fixture, and missing files show as missing. |
| W1.5 | Accessibility pass: semantic markup, keyboard navigation, no meaning carried by color alone | DSH-6 | S | axe-core reports 0 violations, and a manual NVDA pass is recorded. |
| W1.6 | `reddit-search` CLI over Reddit's public RSS (r/forhire, r/developersIndia, r/MachineLearningJobs and others, configurable) | LEAD-1, LEAD-5 | M | Follows the portal-skill contract (`search`/`detail`, `--format`, errors as JSON on stderr, backoff on 429/5xx). A terms note is in `url-reference.md`, and bun tests pass offline. |
| W1.7 | `telegram-channels-search` CLI over the public `t.me/s/<channel>` previews | LEAD-1, LEAD-5 | M | Same contract, uses a configurable channel list, and checks `robots_check.py` before every fetch. |
| W1.8 | `github-helpwanted-search` CLI using GitHub's search API (unauthenticated, rate-limit aware) for help-wanted issues and hiring notes in repos | LEAD-1, LEAD-5 | M | Same contract, and stays under 10 requests a minute without a token. |
| W1.9 | `scan.ts`, the zero-model run: enabled portals and sources → `scrape_state.py candidates` → `detail` → `posting_guard.py` → `scrape_state.py store`, then lead metadata into `wrapper-data/leads.json` keyed by `job_key` | INC-1, LEAD-2, LEAD-3, LEAD-4 | L | Runs with no Claude access. Every stored item has a fetch record and a guard verdict, and duplicates across sources collapse into one entry. |
| W1.10 | Paste-a-link: a URL goes through the portal CLI if one matches, otherwise `fetch_page.py`. X posts use the official oEmbed endpoint. The page then goes through the guard and into store. | MSG-5 (core), LEAD-2 | M | Works for a hirist URL, a Reddit post and an X post. An unreachable URL gives a plain-language error and never makes up content. |
| W1.11 | Scam detector, rules only: fee or deposit requests, "task" scams, look-alike domains, personal-email recruiters | SAFE-1 | M | Recall ≥ 90% and false positives ≤ 10% on the labelled fixture set (≥ 50 scam and ≥ 50 legitimate postings). Flags appear on the dashboard. |
| W1.12 | Compatibility check in CI: a weekly upstream merge, the upstream checks, a test that removing the wrapper leaves a working install, and a diff check against upstream-tracked files | C-1 – C-5 | M | The CI job fails if any of the conditions breaks. |

**First slice to build:** W1.1 → W1.2 → W1.3 → W1.4. This gives you a live dashboard of the real tracker and the 38 scraped jobs within the first few days. Everything else in phase 1 can then be built in parallel.

## 4. Later phases (outline)

**Phase 2: phone and attention queue**
- `bridge.ts` connects to Telegram by long polling. The owner pairs by typing a one-time code shown in the terminal.
- Commands are a fixed allowlist, each mapped to a prompt template that runs `claude -p ... --allowedTools <minimal set>`.
- A morning digest.
- The attention queue store and its views.
- The answer bank, with confirmed facts also written back to `01-candidate-profile.md`.
- L0 application kits.
- An inbox that sorts recruiter mail on top of `/gmail-sync`.
- Cost tracking and the budget cap.

**Phase 3: onboarding and form filling**
- One-command bootstrap that installs bun, `uv` (for Python) and Tectonic on first run.
- Resume intake from PDF, DOCX or a photo, plus the no-resume interview.
- The browser-driver decision (open decision 3), then the APP module in three steps:
  - dry run first
  - then L1 (fill and review)
  - then L2 (fill and submit)

  It starts with Greenhouse and Lever, and each step has to pass the filling benchmark first.

**Phase 4: more channels and sources**
- OpenClaw channel adapter for WhatsApp, Signal and Discord (MSG-8).
- Funding-news RSS and the YC directory.
- LinkedIn boolean-search URL builder.
- Matching the user's LinkedIn connections export for referrals.

## 5. Testing

- **Unit tests:** `bun test` in `wrapper/tests/` and in each new CLI's `cli/tests/`, network-free with recorded fixtures.
- **Contract tests:** each new source CLI runs the same checks `/scrape health` applies: one search and one `detail` that decodes to readable text.
- **Compatibility:** the upstream CI set (`lint_skills.py`, `check_framework_version.py`, `security_guards.py`, `python -m unittest discover -s tests`) runs on every change and must stay green with no edits to upstream files.
- **Real-path proof:** following upstream's contribution norm, every fix is demonstrated on the path the code actually runs, using real tracker and seen-jobs files, not hand-made inputs.

## 6. Risks

| Risk | Mitigation |
|------|------------|
| Reddit or Telegram change or throttle their public feeds | Each source is isolated, one failure never blocks a scan, and `/scrape health`-style probes show a degraded source. |
| A Claude Code plugin can't grant the permissions a source CLI needs without settings edits | Check in W1.1 first. The fallback is a documented one-time `/permissions` step for the user, with no edits to tracked settings. |
| Windows path and encoding quirks | UTF-8 everywhere, `python` instead of `python3` in spawned commands, and CI on Windows as well as Linux. |
| Upstream later adds a feature that overlaps ours (a dashboard or a source) | We only read upstream data, so we can switch to the upstream feature without migrating anything. |
| The X oEmbed endpoint changes or needs authentication | Paste-a-link degrades to "open the link and paste the text", which the guard still checks. |
