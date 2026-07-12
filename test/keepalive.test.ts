import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureKeeper,
  keeperStatus,
  logFile,
  readState,
  runKeeper,
  stateFile,
  stopKeeper,
} from "../src/keepalive.js";
import type { ConnectedClient } from "../src/mcp.js";

const DEAD_PID = 2147483646; // absurdly high pid: guaranteed to not exist

const endpoints: string[] = [];
const kids: ChildProcess[] = [];

function endpoint(name: string): string {
  const url = `http://127.0.0.1:9/${name}-${Math.random().toString(36).slice(2)}`;
  endpoints.push(url);
  return url;
}

function writeStateFile(url: string, pid: number): void {
  writeFileSync(stateFile(url), JSON.stringify({ pid, endpoint: url, startedAt: "t" }), "utf8");
}

/** Spawn a real, idle node child so we have a genuinely-alive foreign pid. */
function spawnLiveChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  kids.push(child);
  return child;
}

afterEach(() => {
  for (const child of kids.splice(0)) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  for (const url of endpoints.splice(0)) {
    rmSync(stateFile(url), { force: true });
    rmSync(logFile(url), { force: true });
  }
});

describe("keeperStatus", () => {
  it("reports running for a live pid", () => {
    const url = endpoint("status-live");
    writeStateFile(url, process.pid);
    expect(keeperStatus(url)).toMatchObject({ running: true, pid: process.pid });
  });

  it("reports not running for a stale pid", () => {
    const url = endpoint("status-stale");
    writeStateFile(url, DEAD_PID);
    expect(keeperStatus(url)).toEqual({ running: false });
  });

  it("reports not running when there is no state file", () => {
    const url = endpoint("status-missing");
    expect(keeperStatus(url)).toEqual({ running: false });
  });
});

describe("ensureKeeper", () => {
  it("is a no-op when a keeper is already running (no spawn)", () => {
    const url = endpoint("ensure-noop");
    writeStateFile(url, process.pid); // pretend a live keeper already owns it
    ensureKeeper(url, "unused-self-script");
    // A spawn would overwrite the state with a fresh child pid; assert it didn't.
    expect(readState(url)?.pid).toBe(process.pid);
  });
});

describe("stopKeeper", () => {
  it("returns not-stopped and clears state when nothing is running", () => {
    const url = endpoint("stop-none");
    writeStateFile(url, DEAD_PID);
    expect(stopKeeper(url)).toEqual({ stopped: false });
    expect(readState(url)).toBeUndefined();
  });

  it("kills a running keeper and clears state", async () => {
    const url = endpoint("stop-live");
    const child = spawnLiveChild();
    writeStateFile(url, child.pid!);

    const result = stopKeeper(url);
    expect(result).toEqual({ stopped: true, pid: child.pid });
    expect(readState(url)).toBeUndefined();

    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});

describe("runKeeper — duplicate guard", () => {
  it("exits immediately without connecting when another live keeper owns the endpoint", async () => {
    const url = endpoint("dup-guard");
    const child = spawnLiveChild();
    writeStateFile(url, child.pid!); // a different, live keeper already owns it

    const connect = vi.fn(async () => ({}) as unknown as ConnectedClient);
    const log = vi.fn();

    await runKeeper(url, { connect, log });

    expect(connect).not.toHaveBeenCalled();
    expect(readState(url)?.pid).toBe(child.pid); // guard did not overwrite state
    expect(log).toHaveBeenCalledWith(expect.stringContaining("already owns"));
  });
});
