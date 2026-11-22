# jobdesk

A job search assistant that runs on your own computer. It finds jobs, scores them against your profile, shows you only new ones that fit, writes a tailored CV and cover letter, and shows you exactly what it changed before anything is sent.

You use it from a local dashboard in your browser, or from your phone through a Telegram bot.

jobdesk is built on [ai-job-search](https://github.com/ai-job-search-dev/ai-job-search) by Mads Lorentzen (MIT). That framework does the CV and cover-letter work inside [Claude Code](https://claude.com/claude-code), and it is included here unchanged. jobdesk adds everything around it: the dashboard, the bot, more job sources, fit scoring and the review step. It lives in [`wrapper/`](wrapper/).

> This is an independent open-source project. It is not affiliated with Anthropic or with the ai-job-search project.

## What it does

- **Finds jobs** on company career boards (Greenhouse, Lever, Ashby, SmartRecruiters, Workable), remote job boards, Hacker News "Who is hiring", YC companies, LinkedIn, Shine, funding news, Reddit and public Telegram channels.
- **Scores every new job** against your profile: skills, experience level, work style and career direction. A job in a place you can't work, or one that hits a deal-breaker, is ruled out.
- **Shows only new jobs that fit.** It remembers what it has already shown you, so you never see the same job twice.
- **Writes the CV and cover letter** with the framework's `/apply`. Then it shows you a review:
  - what changed against your own resume, line by line;
  - a fact check of every new line and the letter against your profile;
  - every value that will go into the application form.

  Nothing goes out until you confirm.
- **Helps you send it.** On sites that need your login, one tap opens the application page with everything ready to copy. On Greenhouse, Lever and Ashby, it can fill the form in your browser and wait for you to press Send.
- **Has an assistant you can talk to** in plain words, on the dashboard or on Telegram. It looks things up, picks jobs for you and remembers your preferences ("no sales roles"). It asks before doing anything that writes, spends or sends.
- **Keeps track.** It covers applications, follow-up reminders, deadlines and recruiter replies, and shows which sources lead to replies.

## Quick start

You need macOS or Linux (for Windows, see [Limits](#limits)), [Claude Code](https://claude.com/claude-code) installed and signed in, and about 5 minutes.

```sh
git clone https://github.com/Aasrith26/jobdesk.git
cd jobdesk
sh wrapper/install.sh --latex        # installs bun, Python 3.10+, pypdf and Tectonic (for PDFs), only if missing
bun run wrapper/bin/jobdesk.ts start
```

The dashboard opens at `http://127.0.0.1:4317`. The first time, it opens on **Settings**:

1. Upload your resume. jobdesk drafts your profile from it, and you check and correct the draft before it is saved.
2. Say what you're looking for: kinds of jobs, places, and the lowest fit score to show.
3. Optional: connect Telegram. Create a bot with @BotFather, paste its token, then tap **Open in Telegram** and **Start**.
4. Optional: turn on the daily search.

Press **Search now**, then look at **Jobs**.

To keep it running after a restart (macOS and Linux): `bun run wrapper/bin/jobdesk.ts autostart on`.

## How applying works

1. Press **Apply** on a job, or tell the assistant "apply to the Bolt one" and say yes.
2. jobdesk writes the CV and cover letter. This takes 5 to 15 minutes. If the job turns out to be a weak fit, it stops and tells you why.
3. You read the review: what changed, the fact check and the form values. If anything is wrong, edit the files or leave the job.
4. Press **Looks good, apply**:
   - **Kit only (the default):** the application page opens, with your files and answers ready. You send it yourself and press **I have applied**.
   - **Fill forms, I confirm each** (set in Settings): on Greenhouse, Lever and Ashby, the form is filled in your browser. You see every field and press **Send**.

jobdesk never logs into job sites, never creates accounts, never answers a CAPTCHA, and never sends without your click.

## What it costs

The searching, the dashboard, tracking and kits are free. The AI features run through your own Claude Code login:

| Feature | Approximate cost |
|---|---|
| Scoring new jobs | about 1 cent per 10 jobs |
| One message to the assistant | about half a cent |
| Writing one CV and cover letter | $0.30 to $0.60 |

On a Claude subscription, these count against your plan's usage limits. On an API-billed account, they cost about what is shown. jobdesk also has its own monthly cap ($10 by default), and paid features stop when it is reached. Run `jobdesk cost` to see what you've spent, and `jobdesk config budget <usd>` to change the cap.

## Your data

Everything stays on your computer:
- Your profile is in `.claude/skills/job-application-assistant/`.
- Your applications are in `job_search_tracker.csv`.
- jobdesk's own data, including your bot token, is in `wrapper-data/`.

These are ignored by git, so they are not committed by accident. The dashboard only listens on `127.0.0.1`. The Telegram bot answers only the one chat you pair with it.

## Limits

- **PDFs need LaTeX.** Without it, the CV and letter are written as `.tex` files but no PDF is made. `sh wrapper/install.sh --latex` installs Tectonic.
- **Windows:** the installer exists (`wrapper\install.ps1`), but start-at-login is not built and has had less testing.
- **Sites that need a login** (LinkedIn, Naukri, Shine and others) always get the kit, never automated filling.
- **Fit scores come from the text a search finds.** A full `/rank` in Claude Code reads the whole posting and takes priority.

## Using the framework directly

Everything from ai-job-search still works in Claude Code. Run `claude` in this folder, then:

- `/setup` builds your profile;
- `/scrape` and `/rank` find and shortlist jobs;
- `/apply <link>` writes a CV and letter;
- `/interview` prepares you for a round;
- `/outcome` records what happened.

See the [ai-job-search README](https://github.com/ai-job-search-dev/ai-job-search#readme) and [SETUP.md](SETUP.md).

## For developers

- jobdesk is TypeScript on [bun](https://bun.sh), with no runtime dependencies. The code is in `wrapper/src`, and the command line is `wrapper/bin/jobdesk.ts`.
- Tests: `cd wrapper && bun install && bun test`. `tests/journey.test.ts` walks one user from a fresh checkout to an application sent. Model calls in the tests are stand-ins, so the suite costs nothing to run.
- The assistant's tools are a small MCP server (`wrapper/bin/jobdesk-mcp.ts`) that Claude Code starts for each message.
- `bun run wrapper/bin/jobdesk.ts compat` checks that the framework underneath is unchanged.
- More detail: [wrapper/README.md](wrapper/README.md), [docs/wrapper-requirements.md](docs/wrapper-requirements.md) and [docs/wrapper-plan.md](docs/wrapper-plan.md).

## License

MIT, the same as ai-job-search. See [LICENSE](LICENSE). The original copyright notice is kept.
