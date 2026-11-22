# jobdesk

jobdesk works on top of [ai-job-search](../README.md). Everything runs on your own computer. It adds:

- **A live dashboard** of your applications, jobs and leads, and anything that needs you.
- **More places to find work:** public Telegram job channels, startup funding news, YC companies that are hiring, any link you paste (including X posts), and GitHub help-wanted issues (opt-in).
- **Your phone:** a Telegram bot for the daily digest, application kits, drafts and approvals. WhatsApp is optional, through OpenClaw.
- **Application filling:** the form is filled in your own browser, and nothing is sent until you approve it.
- **One "needs you" list:** new form questions, CAPTCHAs, recruiter replies, deadlines and warnings.
- **Safety checks:** scam and discrimination warnings, plus a daily application limit.

It never changes the original framework. It reads its files and writes new data only through the framework's own tools.

## Start

Install what jobdesk needs (bun, Python, pypdf) with one command. It only installs what's missing, using each tool's official installer:

```
sh wrapper/install.sh                                         # macOS / Linux
powershell -ExecutionPolicy Bypass -File wrapper\install.ps1  # Windows
```

On a brand-new Linux machine with 4 GB of RAM, that took 35 seconds and downloaded 150 MB. A first real shortlist came 3 seconds later.

For the AI features you also need [Claude Code](https://claude.com/claude-code), installed and signed in once. Then, from this folder, one command starts everything:

```
bun run wrapper/bin/jobdesk.ts start
```

That opens the dashboard: Overview, Jobs, Applications, Assistant, Needs you, Insights and Settings, in a sidebar. The first time, it opens on **Settings**:

1. **Your resume.** Upload it, and jobdesk drafts your profile from it. You read the draft, fix anything wrong, and save. Nothing is added that your resume doesn't say: anything missing is marked "pending". Your old profile is kept as a backup.
2. **What you're looking for.** Kinds of jobs, places, and the lowest fit score you want to see (60 by default).
3. **Your phone (optional).** Make a bot with @BotFather, paste its token, then tap **Open in Telegram** and **Start** on your phone. That pairs it. No codes to copy from a terminal.
4. **Daily search (optional).** A time, and what to do with jobs that fit.

`start` runs the dashboard, the bot and the daily search in one process. Only one copy can run at a time. To have it start by itself when you log in (macOS, Linux):

```
bun run wrapper/bin/jobdesk.ts autostart on     # and "autostart off" to undo
```

Prefer Claude Code? `claude --plugin-dir wrapper`, then `/jobdesk:onboard` still works.

No Claude, or no budget for it? These work without any AI:
- `bun run wrapper/bin/jobdesk.ts doctor` checks your computer.
- In the dashboard, "copy it in word for word" puts your resume into your profile as written.
- Search, the dashboard, tracking, kits and reminders. Without scoring, a strong keyword match stands in for a fit score.

## Only new jobs, only ones that fit

After every search, each new job gets a quick fit score against your profile, from the text the search already fetched. That uses the small model and costs about a cent per ten jobs. The score uses the framework's weights (skills 30%, experience 25%, work style 15%, career 30%). A job outside your places, or one that hits a deal-breaker in your profile, is ruled out. A job with only a title can't score above 65.

jobdesk remembers every job it has shown you, where, and whether you skipped it. So:
- "anything new?" or `/jobs` gives the next jobs that fit and that you haven't seen. Asking again never repeats a list.
- `/jobs all` brings back ones shown before. A job you skipped never comes back.
- Jobs you've applied to or drafted live in the Pipeline, not here.

The **Jobs** page shows the same list, with each score, the reason, and the main gap. Older jobs with no score: tap **Score them** there, or run `jobdesk rank` (`--all` for the whole backlog). A full score from `/rank` in Claude Code reads the whole posting and always takes priority over a quick one. Quick scores are kept separately in `wrapper-data/scores.json`, so they never stop `/rank` from scoring a job properly.

Settings: `config min-fit 60`, `config auto-rank on|off`.

## Applying: you see what changed before anything goes out

Press **Apply** on a job (in the dashboard, on Telegram, or just say "apply to the Bolt one"):

1. **jobdesk writes the CV and cover letter** with the framework's own `/apply`. That takes 5 to 15 minutes and about $0.60. If the fit is weak or the posting looks wrong, it stops and tells you why instead.
2. **You get a review.** Nothing has been sent at this point. The review shows:
   - **What changed in your CV**, line by line against your own resume: added, reworded (with the old wording crossed out), and left out.
   - **A fact check.** Every changed line and the whole cover letter are checked against your profile on the small model, and anything your profile doesn't say is listed at the top.
   - **The cover letter.**
   - **Every value that will go into the form**, and where it came from.
3. **You confirm ("Looks good, apply").** What happens next depends on the site:
   - **Sites that need your login** (LinkedIn, Naukri, hirist, Instahyre, Cutshort, Shine and most others): one tap opens the application page. Your files and answers are ready to copy, and you send it yourself. Tap **I have applied** afterwards.
   - **Greenhouse, Lever and Ashby, if you chose "Fill forms, I confirm each" in Settings:** jobdesk fills the form in your browser and shows every field. Nothing is sent until you press **Send**.

"Not now" keeps the CV and letter for later. Prepared applications are listed under **Applications**.

## The assistant

One assistant, on Telegram and on the dashboard's **Assistant** page, with one shared conversation. It has its own tools:
- It looks up your jobs, applications, profile and settings rather than guessing.
- It chooses which jobs are worth showing you, and they appear with Apply and Skip buttons.
- It **remembers what you tell it** ("no sales roles", "I'm on a 30-day notice"). Those notes appear under Settings, where you can remove any of them.

Anything that writes, spends or changes a setting comes back as a Yes/No, and nothing happens until you say yes. Its only tools are read-only file access and jobdesk's own: no shell, no web, and no writing outside `wrapper-data/`.

A message costs about half a cent on the standard plan and takes 5 to 10 seconds.

## Everyday use

| You want to... | Run (from this folder) | Or on Telegram |
|---|---|---|
| See everything | `bun run wrapper/bin/jobdesk.ts dashboard --open` | |
| Find new jobs | `... scan` | `/scan` |
| Check one link | `... lead <link>` | paste the link |
| Get ready to apply | `... kit <link or company>` | `/kit 1` |
| Write a CV and letter | `/apply <link>` in Claude Code | `/draft 1` |
| Fill a form | `... fill <link> --dry`, then `--level L1` | `/fill 1` |
| Message a poster | `... dm <key>` | `/dm 1` |
| See what needs you | `... attention` | `/attention` |
| Teach a form answer | `... answers set "notice period" "30 days"` | `/answer notice period = 30 days` |
| Mark a job as applied | | `/applied 1` (works even if you applied by hand with the kit) |
| Record what happened next | `/outcome` in Claude Code | `/update Acme interview` (or offer, rejected, no reply, withdrawn) |
| Sort recruiter email | save emails to `wrapper-data/inbox/`, then `... inbox` | automatic |

Phone setup is in the dashboard's Setup tab (see Start). From a terminal instead: `bridge --token <token>`, then `bridge`, and open the pairing link it prints. Only the paired chat can use the bot.

The bot runs only while `jobdesk start` (or `bridge`) is running on your computer. Its menu (type `/`) has five items: `/jobs`, `/scan`, `/attention`, `/status` and `/help`. Everything else is plain words. The older commands in the table above still work if you type them. Buttons on older messages keep working after the bot restarts, and each button always acts on the job it was shown with.

## If something isn't found

`bun run wrapper/bin/jobdesk.ts doctor` shows which Python and which Claude Code jobdesk will use.

- **Python must be 3.10 or newer.** A Mac's own `python3` is 3.9, so jobdesk looks past it for a newer one (Homebrew, uv, conda). To choose one yourself, set `JOBDESK_PYTHON=/path/to/python3`.
- **Claude Code** is looked for on your PATH, in its usual install folders, and inside the Claude Code editor extension. To choose one yourself, set `JOBDESK_CLAUDE=/path/to/claude`.

## Talking to the bot

You don't need the commands. Tell the bot what you want in plain words, in any language:

- "anything good today?"
- "apply to the second one"
- "Acme called me for an interview"
- "write a follow-up to Bolt"
- "search every morning at 8"

It answers like a mentor: short, with an opinion, using only facts from your files (see "The assistant" above). Anything that writes a CV, changes your tracker, spends money or changes a setting comes back as a Yes/No button first.

## The daily search

Off until you turn it on. Say "search every morning at 8", or:

```
bun run wrapper/bin/jobdesk.ts config daily on 08:00
```

Once a day, while the computer is on, jobdesk searches and sends you only the strong matches (up to 3). What happens to those is your choice:

| Setting | What happens to a strong match |
|---|---|
| `config daily apply ask` (default) | It is shown with an Apply button. |
| `config daily apply auto` | The CV and letter are written without asking. |
| `config daily apply off` | It is only listed. |

`auto` does not change what may be sent. That is still decided by the level in "How sending works" below: at L0 you send everything yourself, at L1 you tap Send on each form, and only L2 on a site you trust goes out without a tap. Job boards that need a login (LinkedIn, Naukri, hirist, Instahyre, Cutshort) are never filled for you. The daily application limit and the monthly budget still apply.

## Follow-ups

When an application has been quiet for 10 days (`config followup-days`), the bot reminds you, with a **Write follow-up** button. The note is short and plain, every statement about you is checked against your profile, and with no AI budget a simple note built from your tracker is used. At most two follow-ups per application.

jobdesk does not send email. If the posting gave an email address, **Open in Gmail** opens the note ready to send. Tap **I sent it** afterwards so the count and the next reminder are right. To get the note without asking, say "write follow-ups for me" or run `config daily followups on`.

## How sending works

| Level | What jobdesk does | Set with |
|---|---|---|
| **L0 Kit** (default) | Prepares files, your saved answers and the link. You apply yourself. | `config level L0` |
| **L1 Fill and review** | Fills the form and shows you every field with where its value came from, plus a screenshot. It sends only when you type SEND or tap Send. | `config level L1` |
| **L2 Fill and send** | Sends without a second tap, but only for a job you approved, on a site you put on your trusted list, and with nothing flagged. Anything unusual drops back to L1. | `config level L2` and `config trust Greenhouse` |

Some things always stop and wait for you:
- CAPTCHAs, logins and account creation
- "I certify / I agree / arbitration" statements
- questions that aren't in your answer bank
- uploads other than this job's CV and cover letter

jobdesk never makes up an answer. If it can't put a value into a field correctly, it marks the field FAILED and clears it.

Which sites can be filled automatically: public application forms on Greenhouse, Lever, Ashby, SmartRecruiters and Workable. LinkedIn, Naukri, hirist, Instahyre, Cutshort, Workday and unknown sites get the kit only. See `src/fill/policy.ts`.

## Costs

- **Free:** searching, the dashboard, tracking, reminders, kits and the rule-based safety checks.
- **Paid, on your Claude plan:** drafting CVs and letters, chat answers, DM drafts, and the model safety check (about a fifth of a cent per posting or email).

Commands:
- `config tier lite|standard|max`: how much each paid feature uses
- `config budget <usd>`: monthly limit. When it's reached, paid features stop.
- `cost`: what you've spent

## Settings

`bun run wrapper/bin/jobdesk.ts config` shows them all. They're stored in `wrapper-data/config.json`. The `wrapper-data/` folder holds all of jobdesk's personal data and is never committed.

## For contributors

- `bun install` (inside `wrapper/`), then `bun test` and `bunx tsc --noEmit`.
- `fill.e2e.test.ts` drives a real headless Chrome or Edge against a local form, and is skipped when neither is installed.
- `tests/eval-llm.ts` re-measures the model safety check on the unseen sets. It costs about $0.40.
- `tests/dryrun-real.ts <url>` dry-runs the filler on a real form with a test identity. Nothing is submitted.
- `bun run wrapper/bin/jobdesk.ts compat --merge` checks the original framework is untouched and still merges cleanly.

Requirements: [docs/wrapper-requirements.md](../docs/wrapper-requirements.md). Build plan: [docs/wrapper-plan.md](../docs/wrapper-plan.md).
