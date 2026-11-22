#!/usr/bin/env bun
// Restricted entry point for chat adapters (OpenClaw). Only allowlisted commands run.
//   bun run wrapper/bin/jobdesk-gateway.ts <command> [argument]

import { paths, ensureDataDir } from "../src/lib/paths.ts"
import { gateway } from "../src/gateway.ts"

const [cmd = "help", ...rest] = process.argv.slice(2)
const p = paths()
ensureDataDir(p)
gateway(p, cmd, rest.join(" ")).then(
  (out) => {
    console.log(out)
    process.exit(0)
  },
  (e) => {
    console.log((e as Error).message)
    process.exit(1)
  },
)
