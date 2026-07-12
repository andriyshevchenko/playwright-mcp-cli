#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli, CliError } from "./args.js";
import { resolveEndpoint, DEFAULT_ENDPOINT } from "./endpoint.js";
import { renderResult, type RenderDeps } from "./render.js";
import { connect, type ClientFactory } from "./mcp.js";
import { ensureKeeper, keeperStatus, runKeeper, stopKeeper } from "./keepalive.js";
import {
  SECURE_COMMANDS,
  VAULT_ONLY_COMMANDS,
  collectVaultValues,
  redactResult,
  runSecureCommand,
  runVaultCommand,
} from "./secure.js";
import { createKeytarVault, type Vault } from "./vault.js";

export const HELP = `pw — stateless CLI for a Playwright MCP daemon

Usage:
  pw list                          List available tools.
  pw call <tool> [--key value ...] Call a tool with named arguments.
  pw <tool> [--key value ...]      Shorthand for \`pw call <tool>\`.
  pw keepalive start|stop|status   Manage the background session-keeper.
  pw help | --help | -h            Show this help.

Arguments:
  --key value    Adds { key: value } to the tool arguments. Values are
                 auto-parsed as number / boolean / string.
  --key          Boolean flag; adds { key: true }.
  --json '<obj>' Merge a raw JSON object into the tool arguments.

Global options (reserved — cannot be used as tool argument names):
  --url <url>    MCP endpoint. Also PW_MCP_URL env. Default ${DEFAULT_ENDPOINT}.
  --out <path>   Write image/binary result to this path instead of a temp file.
  --safe         Scrub every known vault value from text output (also PW_SAFE_MODE=1).
                 Use in corporate / personal-account contexts so a raw
                 browser_snapshot or browser_evaluate can never leak a credential.
  --no-keepalive Do not auto-start the background session-keeper for this call
                 (also PW_NO_KEEPALIVE=1). The keeper holds one MCP session open
                 so the daemon's page/login state survives between \`pw\` calls
                 instead of resetting to about:blank.

Secure vault commands (credentials from SecureVault OS keychain — values never shown):
  pw vault-secrets                 List available secret titles.
  pw vault-profiles                List auth profiles and their env var mappings.
  pw secure-fill --secret <title> --selector <css>
                                   Fill a field with a vault secret.
  pw secure-type --secret <title> [--selector <css>] [--enter]
                                   Type a secret keystroke-by-keystroke.
  pw secure-navigate --secret <title>
  pw secure-navigate --profile <name> [--envVar <var>]
                                   Navigate to a URL stored in the vault (URL never shown).
  pw secure-auth --profile <name> --json '{"steps":[{"selector":"..","envVar":".."}]}'
                                   Run a multi-step login from a profile.
  pw redacted-snapshot             Snapshot the page with vault values redacted.

Examples:
  pw list
  pw browser_navigate --json '{"url":"https://example.com"}'
  pw browser_take_screenshot --out shot.png
  pw secure-fill --secret "NICE_EMAIL" --selector "input[name='loginfmt']"
`;

export interface KeepaliveDeps {
  ensure(endpoint: string): void;
  status(endpoint: string): { running: boolean; pid?: number; startedAt?: string };
  stop(endpoint: string): { stopped: boolean; pid?: number };
}

export interface RunDeps {
  connect: ClientFactory;
  render: RenderDeps;
  env: Record<string, string | undefined>;
  vault: Vault;
  keepalive?: KeepaliveDeps;
}

/** Real keeper wiring, bound to this CLI's own entry script for spawning. */
export function defaultKeepalive(selfScript: string): KeepaliveDeps {
  return {
    ensure: (endpoint) => ensureKeeper(endpoint, selfScript),
    status: keeperStatus,
    stop: stopKeeper,
  };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function run(argv: string[], deps: RunDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (e) {
    if (e instanceof CliError) {
      deps.render.stderr(e.message);
      return 1;
    }
    throw e;
  }

  if (parsed.command.kind === "help") {
    deps.render.stdout(HELP);
    return 0;
  }

  const endpoint = resolveEndpoint(parsed.global.url, deps.env);

  // Internal: become the long-lived background session-keeper (never returns).
  if (parsed.command.kind === "keepalive-daemon") {
    await runKeeper(endpoint);
    return 0;
  }

  const keepalive = deps.keepalive ?? defaultKeepalive(process.argv[1] ?? "");

  if (parsed.command.kind === "keepalive") {
    return runKeepaliveCommand(parsed.command.action, endpoint, keepalive, deps.render);
  }

  // Vault-only commands read the OS keychain and need no daemon connection.
  if (parsed.command.kind === "call" && VAULT_ONLY_COMMANDS.has(parsed.command.toolName)) {
    return runVaultCommand(parsed.command.toolName, deps.vault, deps.render);
  }

  // Keep one MCP session permanently connected so the daemon never tears the
  // browser down between stateless invocations (upstream closes the browser
  // when its client refcount hits zero → page resets to about:blank).
  const optedOut = parsed.global.noKeepalive === true || deps.env.PW_NO_KEEPALIVE === "1";
  if (!optedOut && parsed.command.kind === "call") {
    try {
      keepalive.ensure(endpoint);
    } catch {
      /* best-effort: never fail a real call because the keeper couldn't start */
    }
  }

  let client;
  try {
    client = await deps.connect(endpoint);
  } catch (e) {
    deps.render.stderr(`Failed to connect to ${endpoint}: ${errMessage(e)}`);
    return 1;
  }

  try {
    if (parsed.command.kind === "call" && SECURE_COMMANDS.has(parsed.command.toolName)) {
      return await runSecureCommand(
        parsed.command.toolName,
        parsed.command.args,
        client,
        deps.vault,
        deps.render,
      );
    }

    if (parsed.command.kind === "list") {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const desc = (tool.description ?? "").split("\n")[0].trim();
        deps.render.stdout(desc ? `${tool.name} — ${desc}` : tool.name);
      }
      return 0;
    }

    const result = await client.callTool({
      name: parsed.command.toolName,
      arguments: parsed.command.args,
    });
    // Safe mode: scrub every known vault value from text output so a raw
    // snapshot/evaluate can never leak a corporate/personal credential.
    const safe = parsed.global.safe === true || deps.env.PW_SAFE_MODE === "1";
    const rendered = safe ? redactResult(result, await collectVaultValues(deps.vault)) : result;
    return renderResult(rendered, { out: parsed.global.out }, deps.render);
  } catch (e) {
    deps.render.stderr(errMessage(e));
    return 1;
  } finally {
    await client.close().catch(() => {});
  }
}

function runKeepaliveCommand(
  action: "start" | "stop" | "status",
  endpoint: string,
  keepalive: KeepaliveDeps,
  render: RenderDeps,
): number {
  if (action === "start") {
    keepalive.ensure(endpoint);
    const s = keepalive.status(endpoint);
    render.stdout(
      s.running ? `keepalive running for ${endpoint} (pid ${s.pid})` : "keepalive starting…",
    );
    return 0;
  }
  if (action === "stop") {
    const r = keepalive.stop(endpoint);
    render.stdout(r.stopped ? `keepalive stopped (pid ${r.pid})` : "keepalive not running");
    return 0;
  }
  const s = keepalive.status(endpoint);
  render.stdout(
    s.running
      ? `keepalive running for ${endpoint} (pid ${s.pid}, since ${s.startedAt})`
      : "keepalive not running",
  );
  return 0;
}

function main(): void {
  const render: RenderDeps = {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
    writeFile: (path, data) => writeFileSync(path, data),
    tmpPath: (ext) => join(tmpdir(), `pw-mcp-${randomUUID()}.${ext}`),
  };

  run(process.argv.slice(2), {
    connect,
    render,
    env: process.env,
    vault: createKeytarVault(),
    keepalive: defaultKeepalive(process.argv[1] ?? ""),
  })
    .then((code) => {
      // Set exitCode rather than calling process.exit(), which can truncate
      // async stdout/file writes on large results. Let the event loop drain.
      process.exitCode = code;
    })
    .catch((e) => {
      process.stderr.write(String(e) + "\n");
      process.exitCode = 1;
    });
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedUrl === import.meta.url) main();
