---
description: Set up jobdesk in three questions - resume, roles, phone channel
allowed-tools: Bash(bun run wrapper/bin/jobdesk.ts:*), Read, Edit(.claude/skills/job-application-assistant/01-candidate-profile.md), AskUserQuestion
---

# /jobdesk:onboard - three-question setup

Get the user from nothing to a ranked shortlist with **at most three questions** (ONB-2). Use short sentences and plain words: many users have never used a terminal. Everything else is asked later, only when a posting or form needs it.

**Never invent facts.** The profile gets only what the resume says or what the user tells you. Anything unknown is written as `pending` (the upstream convention), never guessed. That includes splitting a full name into first and last name: name order varies across cultures, so leave it for the user to answer once.

## Step 0: Check the computer

Run `bun run wrapper/bin/jobdesk.ts doctor`. If a **required** item is missing, show the one "Fix" line and stop until it's fixed. Optional items (LaTeX, a browser) are fine to skip: tell the user what they'd unlock.

## Question 1: Your resume

Ask: "Where is your resume? You can paste the file path. If you don't have one, say so and we'll make one together."

- **A file:** run `bun run wrapper/bin/jobdesk.ts intake "<path>"`.
  - If it prints text, use that text.
  - If it says Claude needs to read it (a photo or a scan), open the copied file with the Read tool and read it yourself.
- **No resume:** have a short conversation instead: what they do or did, where, for how long, what they're good at, their education. One question at a time, at most eight. Record **only** what they say. Mark each fact `(stated in onboarding, <today's date>)`.

Then fill `.claude/skills/job-application-assistant/01-candidate-profile.md` with what you have: Identity, Education, Experience, Skills. Keep the user's own words for their achievements. Write `pending` for everything you don't know.

Never add a detail the user didn't give, even an obvious-seeming one:
- A language listed with no level gets "level pending", never "Native" or "Fluent".
- A city stays a city. Don't add a country or state.
- Add no years, team sizes, tools or responsibilities they didn't state.

Before saving, re-read your draft line by line against what they gave you, and delete anything they didn't say. Show the user a short summary and ask "Anything wrong?" Fix only what they correct.

Run `bun run wrapper/bin/jobdesk.ts answers seed` so forms can use their name, email and phone.

## Question 2: What you're looking for

Ask: "Which kinds of jobs, and where? For example: 'Nurse, Staff Nurse in Hyderabad or Bengaluru' or 'AI Engineer, remote'."

Save their answer:
- `bun run wrapper/bin/jobdesk.ts config queries "<role 1>, <role 2>"`
- `bun run wrapper/bin/jobdesk.ts config locations "<place 1>, <place 2>"`

## Question 3: Your phone

Use AskUserQuestion with these options:

1. **Telegram (recommended):** free, works with nothing else installed.
2. **WhatsApp:** optional, through OpenClaw. Say plainly that it needs extra software and an Anthropic API key (which costs money), and that WhatsApp may ban numbers that use unofficial connections. Point them to `wrapper/openclaw/README.md` and set it up only if they still want it.
3. **Not now:** the dashboard works on its own.

For Telegram, tell them to:
1. Open Telegram, search for **@BotFather**, send `/newbot`, and follow the two prompts.
2. Copy the token it gives them. Then you run `bun run wrapper/bin/jobdesk.ts bridge --token <token>` for them.
3. Start the bot (`bun run wrapper/bin/jobdesk.ts bridge`, run in the background) and send the `/pair` code it prints to their new bot.

## Finish

1. Run the first scan (free, no AI): `bun run wrapper/bin/jobdesk.ts scan`.
2. Start the dashboard in the background: `bun run wrapper/bin/jobdesk.ts dashboard --open`.
3. Tell them, in three short lines:
   - what was found
   - where the dashboard is
   - that `/rank` in Claude Code scores the new jobs against their profile

Finally, mention that the default setting is **Kit only**: jobdesk prepares everything and they apply themselves. They can later allow form filling with `bun run wrapper/bin/jobdesk.ts config level L1`, and nothing is ever sent without their tap.
