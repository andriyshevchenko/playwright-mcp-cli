# playwright-mcp-cli

A small, **stateless** command-line wrapper around a [Playwright MCP](https://github.com/microsoft/playwright-mcp) server running as a long-lived HTTP daemon.

Each `pw` invocation opens **one** MCP connection, runs a single request, and exits. Because the daemon is started with a shared browser context, the live page/tab state survives across separate `pw` calls — so you can script a browser one command at a time from a shell.

The CLI talks to the daemon with the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) over `StreamableHTTPClientTransport`. Tools are discovered dynamically via `listTools` — nothing is hard-coded, so any tool the daemon exposes is callable.

## 1. Start the daemon

Run the Playwright MCP server separately, with a shared browser context so state persists between CLI calls:

```bash
npx @playwright/mcp@latest --port 8931 --shared-browser-context
```

This listens at `http://127.0.0.1:8931/mcp` (the CLI's default endpoint).

## 2. Install & build

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest
```

Link it for local use so the `pw` command is on your PATH:

```bash
npm link          # exposes `pw`
# or run directly:
node dist/cli.js <args>
```

## 3. Usage

```
pw list                          List available tools (name + one-line description).
pw call <tool> [--k v ...]       Call a tool with named arguments.
pw <tool> [--k v ...]            Shorthand for `pw call <tool>`.
pw help | --help | -h            Show usage.
```

### Arguments

- `--key value` — adds `{ key: value }` to the tool's arguments. Values are auto-parsed: `42` → number, `true`/`false` → boolean, everything else → string.
- `--key` — a bare flag adds `{ key: true }`.
- `--json '<object>'` — merges a raw JSON object into the arguments, for nested/complex values.

> **Note on numeric coercion.** Any value that looks like a number (e.g. `007`, `12345678901234567890`, `1e3`) is coerced with JavaScript's `Number`, which drops leading zeros and loses precision on very large integers. When you need the exact string preserved (zip codes, IDs, phone numbers), pass it via `--json` — e.g. `--json '{"zip":"007"}'`.

### Global options

These are **reserved**, so they can't be used as tool argument names — pass such args via `--json` instead.

- `--url <url>` — MCP endpoint. Also settable via the `PW_MCP_URL` env var. Precedence: `--url` > `PW_MCP_URL` > `http://127.0.0.1:8931/mcp`.
- `--out <path>` — write an image/binary result to this path instead of a generated temp file.

### Examples

```bash
# Discover what the daemon can do
pw list

# Navigate (url is a reserved flag, so pass it via --json)
pw browser_navigate --json '{"url":"https://example.com"}'

# Named args are auto-typed
pw browser_resize --width 1280 --height 800

# Save a screenshot to a chosen path
pw browser_take_screenshot --out shot.png

# Point at a different daemon
pw list --url http://127.0.0.1:9000/mcp
PW_MCP_URL=http://127.0.0.1:9000/mcp pw list
```

### Output & exit codes

- Text results are printed to stdout.
- Image/binary results are written to a file (temp path, or `--out`), and the saved path is printed.
- If a tool reports an error, its message goes to stderr and the process exits non-zero.
- Exit codes: `0` success, `1` error.
