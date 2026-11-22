#!/bin/sh
# The only program OpenClaw's agent should be allowed to run for jobdesk. It starts the
# allowlisted gateway and nothing else; the gateway itself refuses any command not on its list.
cd "$(dirname "$0")/../.." || exit 1
exec bun run wrapper/bin/jobdesk-gateway.ts "$@"
