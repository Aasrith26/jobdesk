# Wrapper Requirements, Constraints and Acceptance Criteria

Status: v1.0 (2026-11-13). Decisions, both made and still open, are in section 11. The build plan is in [wrapper-plan.md](wrapper-plan.md). The test suite (`wrapper/tests/`, including the end-to-end `journey.test.ts`) checks the acceptance criteria.

## 1. Purpose

The wrapper is an open-source layer on top of `ai-job-search`. It adds the following:

- A live dashboard.
- A three-question onboarding.
- Phone control through Telegram (and WhatsApp later).
- Job leads from social and community sources, alongside the existing portals.
- Filling in application forms once the user approves, wherever a site allows it.
- One attention queue for everything that needs a human decision.
- An inbox that sorts recruiter replies and tracks deadlines.

**Mission:** anyone with genuine talent gets a measurable return on their time and money, whatever their field, language, budget, hardware or starting point. The project works by presenting people's real abilities well. It never invents abilities they don't have.

**Definition of ROI** (per user):

```
ROI = (interviews + offers + hours saved) / (money spent + hours of user attention)
```

Every feature must improve one side of this ratio, and the wrapper must measure it (section 8). A feature that cannot show which side it improves does not ship.

## 2. Principles (non-negotiable)

| ID | Principle | What it means in practice |
|----|-----------|---------------------------|
| P1 | **Additive only** | The current framework keeps working exactly as it does today. The wrapper extends it and never changes or replaces its behavior. |
| P2 | **Truth over polish** | Every claim in a CV, letter or message comes from the candidate's own sources. The upstream grounding audit applies everywhere. |
| P3 | **Human approves every send** | Nothing goes out (an application, DM or email) without the user's approval of that specific item. The wrapper may fill a form and click Submit, but only after that approval. Running unattended, or approving "apply to everything", is never possible. |
| P4 | **Local first** | Personal data stays on the user's machine. There is no hosted backend and no default telemetry. |
| P5 | **No one left behind** | Every feature has to work for the most constrained user in section 3, or it has a fallback that does. |
| P6 | **Quality over volume** | The wrapper helps people make fewer, better applications. It never sprays applications, which harms the candidate, recruiters and every other applicant. |

## 3. Users the design must serve

The design is tested against the most constrained users, not the average one.

| Persona | Constraint the design must handle |
|---------|-----------------------------------|
| Fresher / student | No work history and no resume yet |
| Career returner | A gap of 1+ years that has to be explained honestly |
| Non-tech professional (nurse, accountant, warehouse supervisor, teacher) | Not targeting tech roles, and their job boards aren't the tech ones |
| Regional-language speaker | More comfortable chatting in Hindi, Telugu or another language than in English |
| Budget-constrained user | Can't afford heavy model usage |
| Low-spec / low-bandwidth user | 4 GB RAM Windows laptop on a slow mobile connection |
| Low digital literacy | Has never used a terminal |
| User with a disability | Relies on a screen reader or keyboard-only navigation |
| Experienced engineer (current user) | Wants speed, control and depth |

## 4. Functional requirements and acceptance criteria

Each acceptance criterion (AC) must be verifiable by a test, a script or a written manual check.

### 4.1 Onboarding (ONB)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| ONB-1 | One-command start after Claude Code is installed | Starting on a clean Windows 11, macOS or Ubuntu machine that has only Claude Code, one pasted command plus a resume reaches a ranked shortlist in **≤ 20 min** on a 10 Mbps connection. |
| ONB-2 | At most 3 required questions: resume, roles and locations, chat channel | A scripted run counts the prompts that need an answer: **≤ 3**. Every other field is inferred from the resume or asked later, when a posting needs it. |
| ONB-3 | Resume intake from PDF, DOCX or a photo/scan | The profile is populated from each format with no fabricated fields. Any field it can't extract is marked unknown, never guessed. |
| ONB-4 | **No-resume path:** build the profile from a conversation, typed or voice note | A user with no file finishes onboarding. The resulting profile contains only facts the user stated, and each fact can be traced to a message. |
| ONB-5 | Dependencies install automatically on first run (bun, Python via `uv`, Tectonic for LaTeX) | Nothing needs a manual install apart from Claude Code. The total download is **≤ 250 MB**. The first run on a second machine with cached files works offline. |
| ONB-6 | Plain-language errors | Every failure message says what happened and the single next step to take. A sample of all error strings shows no stack traces to the user. |
| ONB-7 | Everything can be skipped or redone later | Skipping the chat channel or any optional question still produces a working setup. Re-running onboarding never deletes data without confirmation. |

### 4.2 Live dashboard (DSH)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| DSH-1 | A pipeline board showing new → ranked → drafted → applied → interview → final, using the upstream status vocabulary | The counts per status match `job_search_tracker.csv` and `seen_jobs.json` exactly, in an automated comparison. |
| DSH-2 | Live updates | A change to the tracker or the applications folder shows on the page within **≤ 5 s**, without a manual refresh. |
| DSH-3 | A detail page per application: posting, fit score, CV/cover PDFs, notes, follow-up date | Every tracker row links to its files, and a missing file is shown as missing, not as an error. |
| DSH-4 | Results by source and channel: portal vs social vs referral, and reply rate per CV variant | Each figure can be recomputed by hand from the CSV. |
| DSH-5 | Private by design | The server binds to `127.0.0.1` only. The page makes **zero** external network requests (no CDN, fonts or analytics), confirmed with the browser's network log. |
| DSH-6 | Accessible | Meets WCAG 2.2 AA: axe-core reports 0 violations, the board is fully usable by keyboard, and a manual screen-reader pass completes. |
| DSH-7 | Light on resources | 500 applications render in ≤ 2 s on the low-spec reference machine, and the server stays under 100 MB of memory. |

### 4.3 Messaging bridge (MSG)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| MSG-1 | Telegram bot with no server or public URL (long polling) | Works behind home NAT or mobile hotspot with only a BotFather token. Verified for v1 against a simulated Telegram API. The live check with the owner's own bot token is run by the owner *(decision, 2026-11-13)*. |
| MSG-2 | Only the owner can use it | Messages from any chat ID other than the owner's get no reply and are logged. Covered by a test. |
| MSG-3 | Fixed command set: digest, shortlist, draft, mark applied, status, paste a link | Free text never reaches a shell. Commands go through a fixed allowlist, and a test shows that an injected command such as `; rm` is rejected. |
| MSG-4 | Inline buttons for Draft / Skip / Applied | Tapping Applied updates the tracker exactly as `/outcome` would, and the upstream readers still parse the row. |
| MSG-5 | Paste any link (X, Reddit, LinkedIn post, job page) to have it evaluated | The pasted page is fetched, run through `posting_guard`, and its evaluation returned in **≤ 2 min**. |
| MSG-6 | Morning digest and follow-up nudges | The digest arrives at the configured time ±5 min while the machine is on. If the machine was off, it arrives on next start, marked as late. |
| MSG-7 | Conversation in the user's language | A Hindi or Telugu message gets a reply in the same language. Documents stay in the CV language set in the profile. |
| MSG-8 | WhatsApp (and Signal or Discord), phase 4 and optional, through **OpenClaw** as a channel adapter. Our commands are added to it as skills, and the model runs on the user's own API key, following OpenClaw's rules at the time. | Off by default. Turning it on shows the risk of a number ban (OpenClaw's WhatsApp connection is unofficial) and the API-key cost before anything is installed. The same fixed command set and attention queue apply as on Telegram, and a test confirms an OpenClaw message can't reach a command outside that set. Uninstalling OpenClaw leaves Telegram and the dashboard untouched. |

### 4.4 Social and community leads (LEAD)

A **lead** is a post or person showing a hiring need, as opposed to a formal job listing.

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| LEAD-1 | Sources: Reddit, HN "Who is hiring", public Telegram channels (`t.me/s/`), GitHub (help-wanted issues, sponsored repos), funding-news RSS, the YC directory, and user-pasted links (X, LinkedIn) | Each source has a short note on the terms it relies on (official API, RSS or public page), checked when it is built. |
| LEAD-2 | **No fabricated leads** | 100% of stored leads carry a URL the wrapper fetched, never one a model wrote. Covered by a test that rejects any lead without a fetch record. |
| LEAD-3 | Integrity gate on everything | `posting_guard.py` runs on 100% of lead texts, and a flagged lead is never actioned without the user. |
| LEAD-4 | Deduplication against portal jobs | Uses `tools/job_key.py`, so the same role posted on Reddit and hirist shows up once. |
| LEAD-5 | Polite fetching | Respects `robots.txt` (`tools/robots_check.py`) and the documented rate limits, and backs off on 429/5xx, following the portal-skill contract. |
| LEAD-6 | Contact data minimization | Stores only contact routes the poster published in the lead itself. A test asserts there is no email guessing or enrichment code. |
| LEAD-7 | Lead-specific drafts: a short DM or email that refers to the actual post | Each draft cites one specific detail from the post and stays under the configured length (default 80 words). |
| LEAD-8 | LinkedIn assist without scraping | The wrapper generates boolean search URLs and the user opens them in their own browser. No logged-in automation. |

### 4.5 Outreach and follow-up (OUT)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| OUT-1 | **Messages are drafts only:** the user sends DMs and emails themselves. Applications follow section 4.8. | No code path sends a DM or email. The only code allowed to submit anything is the APP module's approval-gated submit. A `security_guards.py` rule or a test fails the build on a send or submit call anywhere else. |
| OUT-2 | Follow-ups follow the upstream rule (at most two, at the configured thresholds) | Matches the `/outcome` follow-up logic, and no third follow-up is ever suggested. |
| OUT-3 | Referral matching from the user's own LinkedIn connections export (CSV) | Shortlisted companies are matched to connections, offline and with no LinkedIn calls. |
| OUT-4 | Daily application cap, default 5 tailored per day and configurable | Once the cap is reached, the next request explains the quality-over-volume reason and lets the user raise the cap on purpose. |

### 4.6 Safety and fairness (SAFE)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| SAFE-1 | Scam detection: requests for fees or deposits, "task" scams, look-alike company domains, personal-email "recruiters" for large employers | On a labelled set of ≥ 50 scam and ≥ 50 legitimate postings: **recall ≥ 90%, false positives ≤ 10%**. A flag is shown and explained, never applied silently. |
| SAFE-2 | Discriminatory postings flagged (age limits, gender, caste, religion, marital status) | Detected on a labelled set, and shown to the user as a flag. |
| SAFE-3 | Ranking ignores protected attributes | The scorer prompt and rubric contain none, and a test checks the rubric text. |
| SAFE-4 | Sensitive facts (disability, health, family status) are never put in documents unless the user explicitly asks for each one | Covered by a test with a profile containing such a fact: it is absent from every draft. |
| SAFE-5 | Career gaps and fresher status get honest framing and no automatic ranking penalty | The fit score doesn't drop for a gap alone. Drafts address the gap truthfully when the posting asks about it. |

### 4.7 Inclusion and cost (INC)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| INC-1 | **Zero-model tier:** scraping, dedup, dashboard, tracking, reminders and raw digests run without any model calls | A run with no Claude access still delivers a deduplicated digest and dashboard. $0 in model cost. |
| INC-2 | Cost tiers: Lite (cheapest model for ranking, drafting on request), Standard, Max | On a fixed benchmark of 10 postings, Lite costs **≤ 50%** of Standard, and its grounding-audit pass rate drops by no more than 5 points. |
| INC-3 | Cost shown and capped | Every model-backed action shows its estimated and actual cost. A monthly budget cap stops model use and switches to the zero-model tier. |
| INC-4 | Works for non-tech roles and non-English job markets | A benchmark with ≥ 3 non-tech personas produces grounded, correctly formatted CVs. New markets are added through `/add-portal`, as upstream does today. |
| INC-5 | Plain language | Bot messages and onboarding text read at a school grade-8 level or below (automated readability check). |
| INC-6 | Runs on the low-spec reference machine (4 GB RAM, no GPU, Windows 11) | The full phase-1 flow completes there without running out of memory. |

### 4.8 Application filling (APP)

**How approval works.** The user picks a level, with L0 as the default for new users:

- **L0 Kit:** the wrapper prepares everything and the user fills the form themselves.
- **L1 Fill and review:** the wrapper fills the form and the user approves the submit.
- **L2 Fill and submit:** if the user approves before filling, and the run hits no flags on an ATS (applicant tracking system) the user has trusted, the wrapper submits.

**What a site allows.** Each site gets a policy:

- **automate:** public ATS forms such as Greenhouse, Lever, Ashby, SmartRecruiters and Workable.
- **assist:** the site's terms forbid automation, or it needs a login the wrapper must not drive. LinkedIn Easy Apply falls here.
- **manual:** the user does it.

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| APP-1 | **Application kit** for every site and every level: the files, every answer ready to copy, and the apply link, delivered on the dashboard and in chat | A kit is produced for 100% of approved applications, including assist and manual sites. Each answer can be copied with one tap on a phone. |
| APP-2 | Site policy registry, with each site's policy based on its terms and checked when the adapter is built | No site runs in automate mode without a policy entry. A test confirms an unknown site falls back to assist. |
| APP-3 | **Answer bank:** reusable answers the user has approved (notice period, current and expected CTC, relocation, work authorization, years per skill, links) | The wrapper never invents an answer. A question it can't answer goes to the attention queue (4.9). The user's answer is saved to the bank and to `01-candidate-profile.md`, following the upstream "write facts back" rule. |
| APP-4 | Provenance for every field: each filled value is traced to the answer bank, the profile or the approved documents | The review card shows the source of every field. A field with no source blocks submission. |
| APP-5 | **Review card before submit (L1):** a screenshot of the filled form, every field value, and any flagged fields | Submit only happens after the user taps Submit on that card. A test confirms no card means no submit. |
| APP-6 | L2 runs only with zero flags, on an ATS the user has trusted, with approval for that specific job | Any flag (unknown question, legal statement, new field type, CAPTCHA) drops the run back to L1 automatically. Covered by a test for each flag type. |
| APP-7 | The browser stays in the user's hands: it uses the user's installed Chrome or Edge, with a separate profile and a visible window | No separate browser download is needed, so ONB-5 still holds. The user can watch the run and take over at any point. |
| APP-8 | Hard stops that always go to a human: CAPTCHAs, account creation, logins, legal statements ("I certify…", background-check consent) and assessments | The wrapper never solves or bypasses a CAPTCHA and never creates an account by itself. A test runs each stop and checks that it lands in the attention queue. |
| APP-9 | Diversity and other voluntary questions default to "prefer not to say", unless the user has set an answer | The wrapper never guesses demographic answers. Covered by a test. |
| APP-10 | Submission guardrails: uploads are limited to this application's own CV and cover PDFs, and the browser stays on the application's own domain | Two prompt-injection tests pass: a hidden instruction on a page asking the wrapper to upload another file, and one asking it to open another site. Both are refused and the attempt is logged. |
| APP-11 | Evidence for every submission: the filled-form screenshot, the confirmation page and the time, saved in the application folder | The tracker moves to `applied` with the real submission date, only once a confirmation has been captured. Without a confirmation, the item goes to the attention queue as "unconfirmed". |
| APP-12 | Duplicate guard: no second application to the same job, and a warning when applying to the same company within the configured window | The wrapper checks `job_key` and the tracker. A test confirms duplicates are blocked. |
| APP-13 | Dry run: fill without submitting, for any site | Can be used on any automate site, and produces the review card with no submit possible. |

### 4.9 Attention queue (ATT)

The attention queue is one list of everything that needs a human, shown on the dashboard and in chat.

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| ATT-1 | What goes in the queue: unknown form questions, hard stops (APP-8), flagged postings (posting_guard, scam or discrimination flags), unconfirmed submissions, recruiter messages that need a reply, deadlines within 48 h, and failed runs | Every one of these producers writes to the queue. A test checks each producer. |
| ATT-2 | Each item says what is needed, why, and the single action that resolves it, and the user can resolve it from chat | Answering in chat resumes the paused run where it stopped, without starting over. |
| ATT-3 | Priority order: deadlines, then recruiter replies, then blocked applications, then everything else | The ordering is deterministic and covered by a test. |
| ATT-4 | Nothing is lost | A paused application keeps its filled state and kit. After a restart, items are still there with their state. |

### 4.10 Inbox and deadlines (INB)

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| INB-1 | Recruiter emails sorted into interview invite, assessment, rejection, information request or other, building on upstream `/gmail-sync` | On a labelled set of ≥ 100 emails, accuracy is ≥ 90%. Rejections update the tracker through the `/outcome` rules. |
| INB-2 | Reply drafts for invites and information requests, using the answer bank | Drafts only (OUT-1), and the user sends them. |
| INB-3 | Deadline tracking for application deadlines, take-home assessments and interview dates | A reminder at 48 h and again at 4 h before each deadline. |
| INB-4 | Interview prep pushed the evening before, built on upstream `/interview` | Arrives in chat with the company research and the talking points. |
| INB-5 | Help comparing offers, using `salary_lookup` when it's configured | A side-by-side comparison with sources. Any figure without a source is labelled as unknown. |

## 5. Non-functional requirements

| Area | Requirement |
|------|-------------|
| Privacy | All personal data lives in gitignored paths, and the upstream `test_onboarding_privacy.py` pattern is extended to the wrapper's paths. Any usage statistics are opt-in, anonymized and documented. |
| Security | Secrets such as the bot token live outside the repo, in the OS keychain or a gitignored `.env`. The wrapper never stores passwords, and logins happen in the browser profile the user controls. Bot-initiated Claude runs use a restricted tool allowlist. Text from social posts is treated as untrusted data and never as instructions (the upstream rule). |
| Reliability | A failure in one source never stops the others. Every run ends with a clear summary of what worked, what failed and why. |
| Portability | Windows, macOS and Linux are first-class. Paths and encoding follow the repo's existing Windows lessons: UTF-8 output and `python` rather than `python3`. |
| Maintainability | Python tools are tested with `unittest`, and CLIs with `bun test`. New sources follow the portal-skill contract. |
| Accessibility | WCAG 2.2 AA (DSH-6). No information is carried by color alone. |

## 6. Constraints

### 6.1 Compatibility with the current framework (protects P1)

| ID | Constraint | Acceptance criteria |
|----|------------|---------------------|
| C-1 | The wrapper owns its own paths: a wrapper directory, a Claude Code plugin namespace, and new `.agents/skills/<source>` directories. It doesn't edit files that upstream tracks. | `git diff upstream/master --stat` on upstream-tracked files shows no changes from the wrapper. |
| C-2 | Upstream updates merge cleanly | Merging the latest upstream release into a fork with the wrapper produces **0 conflicts** in wrapper-owned paths. CI repeats this weekly. |
| C-3 | Upstream CI stays green | With the wrapper installed, all of these pass unchanged: `lint_skills.py`, `check_framework_version.py`, `security_guards.py`, `python -m unittest discover -s tests`, and `bun test` and typecheck in the CLIs. |
| C-4 | Data formats are read-compatible | Tracker columns are not renamed, reordered or added to in v1, and wrapper data goes in sidecar files. Rows the wrapper writes parse with `tools/rank_state.py` and follow the `/outcome` comma-free notes rule. |
| C-5 | Clean uninstall | Removing the wrapper leaves a working upstream install, and the upstream test suite passes afterwards. |
| C-6 | Commands are namespaced | No wrapper command name collides with an upstream command, now or in the future (plugin namespace). |

### 6.2 Platform, legal and terms of service

- **Model access:** Claude Code runs under the user's own login, or uses an API key the user supplies. The wrapper never extracts or reuses a subscription login inside another product. Anthropic's current terms are checked before building.
- **Platform terms:**
  - No logged-in scraping of LinkedIn or X.
  - Reddit only through its official API or public RSS.
  - WhatsApp only through the official API, or an unofficial bridge behind an opt-in with a warning.
  - Each source records the terms it relies on (LEAD-1).
  - Form filling follows each site's policy (APP-2). Sites whose terms forbid automation get assist mode only.
  - The wrapper never bypasses a CAPTCHA, bot check or rate limit.
- **Data protection:** comply with GDPR and India's DPDP Act 2023. Minimize third-party personal data (LEAD-6), and give users export and delete for their own data.
- **License:** the upstream MIT notice (© Mads Lorentzen) is kept, and the wrapper is released under an MIT-compatible license.

### 6.3 Resources

- The default footprint fits the low-spec reference machine (INC-6) and the 250 MB first download (ONB-5).
- The wrapper is useful at $0 model spend (INC-1).

## 7. Release-level acceptance (definition of done for v1)

v1 ships when all of the following hold:

1. All phase-1 and phase-2 ACs pass (section 9).
2. C-1 to C-6 pass in CI.
3. A **persona walkthrough** is recorded for at least five personas from section 3. It must include a fresher with no resume, a non-tech professional, a regional-language user, a budget-capped user and a screen-reader user. Each reaches a ranked shortlist and one grounded draft.
4. The grounding audit finds **0 fabricated claims** across the benchmark set (10 postings × 3 personas).
5. A security review is done covering bot authorization, the command allowlist, prompt injection from social text and application pages, browser-session isolation, and secret storage.
6. **Filling benchmark:** dry runs (APP-13) on ≥ 20 real public forms across the automate ATSs.
   - ≥ 85% of *answerable* fields are filled with no user input.
   - ≥ 90% of attempted fields are correct.
   - 0 fields are filled without a source.
   - 0 submits happen without approval.

   *Answerable* excludes the questions jobdesk must never answer for the user:
   - work authorisation or sponsorship for a country other than the user's own
   - clearance, visa history and citizenship status
   - relatives and government officials
   - facts the profile doesn't contain
   - puzzles and tests

   Overall coverage is reported alongside. *(Revised 2026-11-13 by the project owner, after the benchmark showed that the original "85% of all fields" could only be met by answering those questions.)*

## 8. ROI measurement

The dashboard computes these locally, per user. Nothing is reported anywhere unless the user opts in.

| Metric | How it's measured | v1 target |
|--------|-------------------|-----------|
| Time to first value | From install to the first ranked shortlist | ≤ 20 min |
| Attention per application | User-active time from "Draft" to the final PDFs | ≤ 10 min, compared against the user's own measured manual baseline |
| Cost per application | Actual model cost per tailored application | Always shown and kept under budget. The target is set after baseline measurement. |
| Reply rate by source | Replies divided by applications, per source and channel | Reported for every source with ≥ 5 applications |
| Reply rate by CV variant | Same calculation, per CV file | Reported |
| Honesty | Grounding-audit failures that reach a final PDF | 0 |
| Fill coverage | Share of *answerable* form fields (see release item 6) filled without asking the user | ≥ 85% on the benchmark, rising as the bank grows. Overall coverage is reported too. |
| Attention load | Attention items per submitted application | Falls week over week for the same user |
| Submission integrity | Applications marked `applied` without a captured confirmation | 0 |

## 9. Phases

| Phase | Scope | Requirement IDs |
|-------|-------|-----------------|
| 1 | Dashboard, lead records, Reddit / HN / Telegram / GitHub sources, paste-a-link, zero-model tier | DSH-*, LEAD-1–7, INC-1, INC-6, SAFE-1, C-* |
| 2 | Telegram bot, digest, follow-ups, cost tiers, attention queue, application kits, answer bank, inbox | MSG-1–7, OUT-*, INC-2, INC-3, INC-5, ATT-*, APP-1–4, APP-12, INB-* |
| 3 | One-command onboarding, automatic dependency install, no-resume path, form filling (dry run, then L1, then L2) | ONB-*, INC-4, SAFE-2–5, APP-5–11, APP-13 |
| 4 | WhatsApp, funding news and YC directory, LinkedIn assist | MSG-8, LEAD-1 extensions, LEAD-8 |

## 10. Non-goals

- Unattended or mass applying, such as "apply to everything that matches".
- Sending any application, DM or email without approval of that specific item.
- Bypassing CAPTCHAs, creating accounts automatically, or storing passwords.
- Scraping behind logins.
- A hosted SaaS or cloud backend in v1.
- Promises like "hired in 30 days".
- Mobile-only use. v1 needs a computer that is switched on; a cloud runner is a later option.

## 11. Decisions

### Decided (2026-11-11)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Form | A Claude Code plugin plus local bun scripts |
| D2 | Model access | Claude Code under the user's own login, with an API key as an option |
| D3 | Chat channels | Our own Telegram bot in the core. OpenClaw is optional and used only for WhatsApp, Signal and Discord (MSG-8). |
| D4 | Where it lives | A `wrapper/` directory inside the fork for now, built so it can be lifted out into its own repo before the open-source release |
| D5 | Default approval level | L0 Kit |

### Decided (2026-11-16, by the project owner)

| # | Decision | Choice |
|---|----------|--------|
| D6 | Chat style | Plain language is the main way in. The bot answers like a mentor and proposes actions; commands stay as shortcuts. Any action that writes, spends or changes a setting needs a Yes tap (P3 unchanged). |
| D7 | Daily search | Opt-in. Once every 24 hours; only strong matches are put forward (default 3 a day, inside OUT-4's cap). |
| D8 | Daily apply mode `auto` | Opt-in. The CV and letter are drafted for strong matches without a per-job tap. This relaxes "approve each item" for **drafting** only. Submitting is unchanged: still L0/L1/L2 and APP-6. Non-goal "apply to everything that matches" still stands: `auto` is capped, limited to strong matches, and off by default. |
| D9 | Follow-ups | Drafted by jobdesk, sent by the user (OUT-1 unchanged). A compose link may open the user's own mail app. Actually sending mail from jobdesk would need the user's mail credentials and is **not** built. |

### Still open

1. **Name** and license choice (MIT-compatible).
2. **Other model providers:** upstream accepts only Claude Code. Would the wrapper allow a cheaper or local model for the Lite tier, for users who can't pay at all?
3. **Browser driver:** `playwright-core` running the user's installed Chrome or Edge, or Claude Code's own Chrome integration. To be evaluated in phase 3.
4. **Per-portal policy** for hirist, Naukri, Instahyre and Cutshort: their terms need checking before any of them goes beyond assist mode.
