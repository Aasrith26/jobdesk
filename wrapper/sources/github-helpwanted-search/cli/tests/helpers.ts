import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "../src/cli.ts");

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCLI(args: string[], env: Record<string, string> = {}): Promise<CLIResult> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export function parseJSON<T = unknown>(result: CLIResult): T {
  if (result.exitCode !== 0) {
    throw new Error(`CLI exited with code ${result.exitCode}. stderr: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as T;
}

/** A fresh, empty rate-limit/cache state dir for one test. */
export function freshStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-helpwanted-test-"));
  process.env.GH_HELPWANTED_STATE_DIR = dir;
  return dir;
}

/** Run fn with stdout/stderr captured. */
export async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  let out = "";
  let err = "";
  process.stdout.write = ((c: string | Uint8Array) => ((out += c.toString()), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((err += c.toString()), true)) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
}

const originalSetTimeout = globalThis.setTimeout;
/** Make every sleep fire immediately, recording the requested delays. */
export function instantTimers(): number[] {
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return originalSetTimeout(fn, 0);
  }) as unknown as typeof setTimeout;
  return delays;
}

export function restoreTimers() {
  globalThis.setTimeout = originalSetTimeout;
}
