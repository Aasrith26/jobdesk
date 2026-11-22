---
description: Fill an application form in your browser. Nothing is sent until you type SEND.
argument-hint: <application link> [--dry]
allowed-tools: Bash(bun run wrapper/bin/jobdesk.ts fill:*), Bash(bun run wrapper/bin/jobdesk.ts kit:*), Bash(bun run wrapper/bin/jobdesk.ts attention:*), Read
---

# /jobdesk:fill - approval-gated form filling

1. Run `bun run wrapper/bin/jobdesk.ts fill $ARGUMENTS --dry`. The browser fills the form and **nothing is sent**.
2. Show the user the card it prints:
   - every field, with the value and the source it came from
   - any questions it couldn't answer
   - any steps only they can do (CAPTCHA, login, "I certify..." boxes)
   - the screenshot path, which you can open with the Read tool to show them
3. If there are unanswered questions, ask the user for each answer. Save them with `bun run wrapper/bin/jobdesk.ts answers set "<question>" "<answer>"`, then repeat step 1.
4. If the site is "kit only" (LinkedIn, job boards, unknown sites), run `bun run wrapper/bin/jobdesk.ts kit <link>` instead and give them the kit.
5. Sending happens only in the user's own terminal. Tell them to run `bun run wrapper/bin/jobdesk.ts fill <link> --level L1` themselves: it fills the form again, shows the card, and submits only when **they** type SEND. Never type SEND for them, and never run the submit step yourself.
