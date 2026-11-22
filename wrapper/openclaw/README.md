# WhatsApp, Signal and Discord through OpenClaw (optional)

jobdesk's core phone channel is the built-in Telegram bot (`jobdesk bridge`). Use this adapter only if you want WhatsApp, Signal or Discord. It is **off by default**.

## Read this first

- **Extra software:** OpenClaw is a separate program (Node.js, running all the time) that you install yourself.
- **It costs money:** OpenClaw runs its own AI agent on a model key you give it. Using a Claude subscription inside third-party tools has changed several times in 2026, so plan on a paid Anthropic API key and check Anthropic's current terms.
- **Risk to your WhatsApp number:** OpenClaw's WhatsApp connection is unofficial. WhatsApp may ban numbers that use unofficial clients. Consider a spare number.
- **Fewer commands:** only the safe, read-mostly commands work here (digest, jobs, status, attention, kit, lead, applied, answer, scan). Filling forms and writing CVs need a preview you tap, so they stay on Telegram and the dashboard.

## Setup

1. Install OpenClaw and connect WhatsApp, following OpenClaw's own docs.
2. Copy `wrapper/openclaw/skills/jobdesk/` into your OpenClaw workspace skills folder (by default `~/.openclaw/workspace/skills/jobdesk/`).
3. In the copied `SKILL.md`, replace `<JOBDESK_REPO>` with the full path to this folder.
4. **Lock down the shell.** OpenClaw's skill list does not limit which programs its agent can run, and its exec allowlist works on *programs*, not arguments. Allowlisting `bun` would allow any bun script. So allowlist only jobdesk's launcher, which can start nothing but the gateway:
   ```
   openclaw approvals allowlist add --agent "*" "<JOBDESK_REPO>/wrapper/openclaw/jobdesk-gateway.sh"     # macOS / Linux
   openclaw approvals allowlist add --agent "*" "<JOBDESK_REPO>/wrapper/openclaw/jobdesk-gateway.cmd"    # Windows
   ```
   Then check with `openclaw approvals get`. Leave every other program un-allowlisted, or OpenClaw's agent can run anything your user account can.
5. Send "status" on WhatsApp to test it.

## What protects you on jobdesk's side

`jobdesk-gateway.ts` accepts only the commands listed above and checks every argument:
- a link must be a single http(s) URL
- a job reference must be a number, a link or a name
- shell characters are refused

This is covered by `wrapper/tests/gateway.test.ts`. Still do step 4: the gateway can only refuse what reaches it, and an unrestricted OpenClaw agent could run other programs directly.

## Removing it

Delete the skill folder from OpenClaw's workspace and uninstall OpenClaw. jobdesk, Telegram and the dashboard are not affected.
