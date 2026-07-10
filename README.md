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

## 2. Install

Install the published package globally so the `pw` command is on your PATH:

```bash
npm i -g playwright-mcp-cli
pw help
```

### Build from source (contributors / fallback)

```bash
npm install
npm run build     # tsc -> dist/
npm test          # vitest
npm link          # exposes `pw` from this checkout
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
- `--safe` — scrub every known vault value from text output (also settable via `PW_SAFE_MODE=1`). Use in corporate / personal-account contexts so a raw `browser_snapshot` or `browser_evaluate` can never leak a credential.

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

## 4. Secure vault commands

The CLI can drive logins using credentials stored in **SecureVault** (backed by the OS keychain via `keytar`). Secret *values* are resolved locally and injected into the page — they are **never** printed to stdout/stderr or echoed in error messages.

```
pw vault-secrets                 List available secret titles (no values).
pw vault-profiles                List auth profiles and their env-var → secret mappings.
pw secure-fill --secret <title> --selector <css>
                                 Fill a field with a vault secret.
pw secure-type --secret <title> [--selector <css>] [--enter]
                                 Type a secret keystroke-by-keystroke; --enter presses Enter after.
pw secure-navigate --secret <title>
pw secure-navigate --profile <name> [--envVar <var>]
                                 Navigate to a URL stored in the vault; the URL is never printed.
pw secure-auth --profile <name> --json '{"steps":[{"selector":"..","envVar":".."}]}'
                                 Run a multi-step login from a profile.
pw redacted-snapshot             Snapshot the page with all vault values replaced by [REDACTED].
```

`vault-secrets` and `vault-profiles` only read the keychain and need **no** running daemon. The others drive the browser, so the daemon must be up.

### secure-auth steps

Each step in `--json '{"steps":[...]}'` accepts:

- `selector` (required) — CSS selector of the target field.
- `envVar` (required) — env-var name in the profile that maps to the secret.
- `action` — `"fill"` (default) or `"type"`.
- `pressEnterAfter` — press Enter after the step (boolean).
- `waitMs` — delay after the step, in milliseconds.

Steps whose `envVar` is absent from the profile are skipped (not an error).

### secure-navigate

Treats a URL as a secret: store the target address in SecureVault (e.g. an internal portal with a token or tenant ID in the path) and navigate to it without the URL ever reaching your terminal or model context. Resolve it either directly by secret title (`--secret`) or through a profile mapping (`--profile`, defaulting to the `URL` env-var, override with `--envVar`) — pass one or the other, not both. The resolved value is scrubbed from any daemon error before it surfaces.

### Examples

```bash
# List what's in the vault (titles only)
pw vault-secrets

# Fill an email field from the vault
pw secure-fill --secret "GL_EMAIL" --selector "input[type='email']"

# Type a password into the focused field and submit
pw secure-type --secret "GL_PASSWORD" --enter

# Navigate to a URL stored in the vault (address never printed)
pw secure-navigate --secret "GL_PORTAL_URL"
pw secure-navigate --profile "GlobalLogic" --envVar "URL"

# Safely inspect the page in a corporate context (no credential can leak)
pw redacted-snapshot
pw --safe browser_snapshot
```
