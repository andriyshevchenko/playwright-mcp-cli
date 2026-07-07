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

export const HELP = `pw — stateless CLI for a Playwright MCP daemon

Usage:
  pw list                          List available tools.
  pw call <tool> [--key value ...] Call a tool with named arguments.
  pw <tool> [--key value ...]      Shorthand for \`pw call <tool>\`.
  pw help | --help | -h            Show this help.

Arguments:
  --key value    Adds { key: value } to the tool arguments. Values are
                 auto-parsed as number / boolean / string.
  --key          Boolean flag; adds { key: true }.
  --json '<obj>' Merge a raw JSON object into the tool arguments.

Global options (reserved — cannot be used as tool argument names):
  --url <url>    MCP endpoint. Also PW_MCP_URL env. Default ${DEFAULT_ENDPOINT}.
  --out <path>   Write image/binary result to this path instead of a temp file.

Examples:
  pw list
  pw browser_navigate --json '{"url":"https://example.com"}'
  pw browser_take_screenshot --out shot.png
`;

export interface RunDeps {
  connect: ClientFactory;
  render: RenderDeps;
  env: Record<string, string | undefined>;
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

  let client;
  try {
    client = await deps.connect(endpoint);
  } catch (e) {
    deps.render.stderr(`Failed to connect to ${endpoint}: ${errMessage(e)}`);
    return 1;
  }

  try {
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
    return renderResult(result, { out: parsed.global.out }, deps.render);
  } catch (e) {
    deps.render.stderr(errMessage(e));
    return 1;
  } finally {
    await client.close().catch(() => {});
  }
}

function main(): void {
  const render: RenderDeps = {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
    writeFile: (path, data) => writeFileSync(path, data),
    tmpPath: (ext) => join(tmpdir(), `pw-mcp-${randomUUID()}.${ext}`),
  };

  run(process.argv.slice(2), { connect, render, env: process.env })
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
