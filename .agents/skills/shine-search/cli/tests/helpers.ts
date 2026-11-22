import { join } from "path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI_PATH = join(import.meta.dir, "../src/cli.ts");

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCLI(args: string[]): Promise<CLIResult> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
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
    throw new Error(
      `CLI exited with code ${result.exitCode}. stderr: ${result.stderr}`
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `Failed to parse JSON. stdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
}

// --- shine-search additions -------------------------------------------------
// Offline runs: a --preload script replaces globalThis.fetch so the real CLI
// parses a saved fixture instead of hitting shine.com, and records each URL it
// was asked for so tests can assert on the request the flags produced.

export interface FixtureRoute {
  /** Response body (HTML) or a numeric HTTP status for an empty response. */
  body?: string;
  status?: number;
}

export async function runCLIWithFixture(
  args: string[],
  route: FixtureRoute,
): Promise<{ result: CLIResult; requests: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "shine-cli-test-"));
  const log = join(dir, "requests.log");
  const routes = join(dir, "routes.json");
  const preload = join(dir, "fetch.ts");
  writeFileSync(routes, JSON.stringify(route));
  writeFileSync(
    preload,
    `
    import { appendFileSync, readFileSync } from "node:fs";
    const route = JSON.parse(readFileSync(${JSON.stringify(routes)}, "utf8"));
    globalThis.fetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      appendFileSync(${JSON.stringify(log)}, url + String.fromCharCode(10));
      if (!url.startsWith("https://www.shine.com/")) throw new Error("Unexpected fixture request: " + url);
      return new Response(route.body ?? "", { status: route.status ?? 200, headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;
  `,
  );
  try {
    const proc = Bun.spawn(["bun", "run", "--preload", preload, CLI_PATH, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const requests = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { result: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }, requests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

export function parsedStderr(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr);
  } catch {
    return {};
  }
}
