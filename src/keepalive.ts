import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type ClientFactory } from "./mcp.js";

// Read-only tool with no navigation / snapshot / file side effects. Calling any
// tool once makes the upstream server create a backend, which increments its
// per-client refcount and keeps the shared browser alive. See README / the
// "close browser" teardown this defends against.
const WARMUP_TOOL = "browser_console_messages";
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;
const HEALTH_INTERVAL_MS = 20000;

export interface KeeperState {
  pid: number;
  endpoint: string;
  startedAt: string;
}

const slug = (endpoint: string): string =>
  createHash("sha1").update(endpoint).digest("hex").slice(0, 12);

export function stateFile(endpoint: string): string {
  return join(tmpdir(), `pw-keepalive-${slug(endpoint)}.json`);
}

export function logFile(endpoint: string): string {
  return join(tmpdir(), `pw-keepalive-${slug(endpoint)}.log`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH => no such process. EPERM => exists but not ours (still alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readState(endpoint: string): KeeperState | undefined {
  try {
    const raw = readFileSync(stateFile(endpoint), "utf8");
    const parsed = JSON.parse(raw) as KeeperState;
    return typeof parsed.pid === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface KeeperStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
}

export function keeperStatus(endpoint: string): KeeperStatus {
  const state = readState(endpoint);
  if (state && pidAlive(state.pid)) {
    return { running: true, pid: state.pid, startedAt: state.startedAt };
  }
  return { running: false };
}

function writeState(endpoint: string, pid: number): void {
  const state: KeeperState = { pid, endpoint, startedAt: new Date().toISOString() };
  writeFileSync(stateFile(endpoint), JSON.stringify(state), "utf8");
}

function removeState(endpoint: string): void {
  rmSync(stateFile(endpoint), { force: true });
}

/**
 * Ensure a background session-keeper is running for `endpoint`. Cheap no-op if
 * one is already alive. Spawns a detached child that outlives this process.
 * `selfScript` is the path to this CLI's entry file (process.argv[1]).
 */
export function ensureKeeper(endpoint: string, selfScript: string): void {
  if (keeperStatus(endpoint).running) return;

  // Truncate on each fresh keeper start so the log can't grow unbounded across
  // restarts. Close our copy of the fd after spawn — the child keeps its own dup.
  const log = openSync(logFile(endpoint), "w");
  try {
    const child = spawn(process.execPath, [selfScript, "__keepalive", "--url", endpoint], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    if (child.pid !== undefined) writeState(endpoint, child.pid);
    child.unref();
  } finally {
    closeSync(log);
  }
}

export function stopKeeper(endpoint: string): { stopped: boolean; pid?: number } {
  const state = readState(endpoint);
  if (state && pidAlive(state.pid)) {
    try {
      process.kill(state.pid);
    } catch {
      /* already gone */
    }
    removeState(endpoint);
    return { stopped: true, pid: state.pid };
  }
  removeState(endpoint);
  return { stopped: false };
}

/**
 * The long-lived keeper loop (runs in the detached child). Connects one MCP
 * client, calls the warm-up tool once to pin the upstream browser alive, then
 * holds the session open — reconnecting if the daemon restarts. Never resolves.
 */
export async function runKeeper(
  endpoint: string,
  deps: { connect: ClientFactory; log: (msg: string) => void } = {
    connect,
    log: (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`),
  },
): Promise<void> {
  // Duplicate-keeper guard: two near-simultaneous `pw` calls can each spawn a
  // detached keeper. If another live keeper already owns this endpoint, exit so
  // only one survives instead of leaking an orphan.
  const existing = readState(endpoint);
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    deps.log(`another keeper (pid ${existing.pid}) already owns ${endpoint}, exiting`);
    return;
  }
  writeState(endpoint, process.pid);

  const cleanup = () => {
    removeState(endpoint);
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  // The reconnect loop always has a pending timer or in-flight request, so the
  // event loop stays alive on its own — no extra keep-alive handle needed.
  let backoff = RECONNECT_DELAY_MS;
  for (;;) {
    let client;
    try {
      client = await deps.connect(endpoint);
      await client.callTool({ name: WARMUP_TOOL, arguments: {} });
      backoff = RECONNECT_DELAY_MS;
      deps.log(`keeper connected to ${endpoint}, holding session open`);
      await holdUntilDropped(client);
    } catch (e) {
      deps.log(`keeper connection lost: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await client?.close().catch(() => {});
    }
    await delay(backoff);
    backoff = Math.min(backoff * 2, MAX_RECONNECT_DELAY_MS);
    deps.log("keeper reconnecting…");
  }
}

/** Poll a cheap request until it throws (session dropped / daemon restarted). */
async function holdUntilDropped(client: { listTools(): Promise<unknown> }): Promise<void> {
  for (;;) {
    await delay(HEALTH_INTERVAL_MS);
    await client.listTools();
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
