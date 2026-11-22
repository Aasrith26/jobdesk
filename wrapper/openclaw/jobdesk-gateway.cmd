@echo off
rem The only program OpenClaw's agent should be allowed to run for jobdesk. It starts the
rem allowlisted gateway and nothing else; the gateway itself refuses any command not on its list.
cd /d "%~dp0..\.."
bun run wrapper\bin\jobdesk-gateway.ts %*
