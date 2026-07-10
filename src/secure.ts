import type { ConnectedClient } from "./mcp.js";
import type { ContentBlock, RenderDeps, ToolResult } from "./render.js";
import type { Vault } from "./vault.js";

/** Local commands that resolve credentials from the vault and drive the browser
 * via the daemon. They never appear as MCP tools and never render secret values. */
export const SECURE_COMMANDS = new Set([
  "vault-secrets",
  "vault-profiles",
  "secure-fill",
  "secure-type",
  "secure-navigate",
  "secure-auth",
  "redacted-snapshot",
]);

/** Secure commands that only read the vault and need no browser/daemon connection. */
export const VAULT_ONLY_COMMANDS = new Set(["vault-secrets", "vault-profiles"]);

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Call an MCP tool and throw on tool-level errors. The daemon may echo the request
 * (which embeds the injected secret) in its error text, so `redact` scrubs the secret
 * value from the message before it can ever reach stderr. */
async function call(
  client: ConnectedClient,
  name: string,
  args: Record<string, unknown>,
  redact?: string,
): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    let message = textOf(result) || "unknown error";
    if (redact && redact.length > 0) {
      message = message.split(redact).join("[REDACTED]");
    }
    throw new Error(`${name} failed: ${message}`);
  }
  return result;
}

function fillJs(selector: string, value: string): string {
  return `() => {
      const selector = ${JSON.stringify(selector)};
      const value    = ${JSON.stringify(value)};
      const el = document.querySelector(selector);
      if (!el) throw new Error('Element not found: ' + selector);
      el.focus();
      el.click();
      el.select();
      document.execCommand('delete', false);
      document.execCommand('insertText', false, value);
      return 'filled';
    }`;
}

function typeJs(selector: string | undefined, value: string): string {
  if (selector) {
    return `() => {
      const selector = ${JSON.stringify(selector)};
      const value    = ${JSON.stringify(value)};
      const el = document.querySelector(selector);
      if (!el) throw new Error('Element not found: ' + selector);
      el.focus();
      el.click();
      el.select();
      document.execCommand('delete', false);
      document.execCommand('insertText', false, value);
      return 'typed';
    }`;
  }
  return `() => {
      const el = document.activeElement;
      if (!el) throw new Error('No focused element to type into');
      const value = ${JSON.stringify(value)};
      el.select();
      document.execCommand('delete', false);
      document.execCommand('insertText', false, value);
      return 'typed';
    }`;
}

async function fillField(client: ConnectedClient, selector: string, value: string): Promise<void> {
  await call(client, "browser_evaluate", { function: fillJs(selector, value) }, value);
}

async function typeIntoField(
  client: ConnectedClient,
  selector: string | undefined,
  value: string,
): Promise<void> {
  await call(client, "browser_evaluate", { function: typeJs(selector, value) }, value);
}

async function pressEnter(client: ConnectedClient): Promise<void> {
  await call(client, "browser_press_key", { key: "Enter" });
}

/** Navigate to a URL pulled from the vault. The URL never reaches stdout, and if
 * the daemon echoes it back in an error the value is scrubbed before it surfaces. */
async function navigateTo(client: ConnectedClient, url: string): Promise<void> {
  await call(client, "browser_navigate", { url }, url);
}

/** Snapshot the page, then replace every known vault value with [REDACTED]. */
async function redactedSnapshot(
  client: ConnectedClient,
  secretValues: string[],
): Promise<string> {
  const result = await call(client, "browser_snapshot", {});
  let text = JSON.stringify(result);
  for (const secret of secretValues) {
    if (secret && secret.length > 0) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(escaped, "g"), "[REDACTED]");
    }
  }
  const parsed = JSON.parse(text) as ToolResult;
  return textOf(parsed) || text;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Resolve every vault secret value (best-effort; unresolvable secrets are skipped). */
export async function collectVaultValues(vault: Vault): Promise<string[]> {
  const summaries = await vault.listSecrets();
  const values: string[] = [];
  for (const s of summaries) {
    try {
      const v = await vault.getSecretByTitle(s.title);
      if (v) values.push(v);
    } catch {
      /* skip unresolvable secrets */
    }
  }
  return values;
}

/** Binary payload fields are base64 blobs written to a file, never printed as
 * text — scrubbing them would corrupt the image/resource without preventing any
 * leak, so redaction skips them. */
const BINARY_FIELDS = new Set(["data", "blob"]);

/** Return a copy of `result` with every provided secret value scrubbed from ALL
 * of its string fields (recursively), except binary payloads. Operates on raw
 * (unescaped) text so it matches actual vault values. This must cover every path
 * renderResult can print — text blocks, resource.text, resource.uri, and the
 * JSON.stringify fallback for unknown block shapes — or a value could still leak.
 * Used by --safe mode to guard against leaks via raw snapshots/evaluate. */
export function redactResult(result: ToolResult, values: string[]): ToolResult {
  const active = values.filter((v) => v.length > 0);
  if (!result.content || active.length === 0) return result;
  const scrub = (t: string): string => {
    let out = t;
    for (const s of active) out = out.split(s).join("[REDACTED]");
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        o[k] = BINARY_FIELDS.has(k) ? val : walk(val);
      }
      return o;
    }
    return v;
  };
  return { ...result, content: result.content.map((b) => walk(b) as ContentBlock) };
}

interface AuthStep {
  selector: string;
  envVar: string;
  action?: "fill" | "type";
  pressEnterAfter?: boolean;
  waitMs?: number;
}

/** Validate one untrusted step object from `--json`. Throws a debuggable error on bad shape. */
function parseAuthStep(raw: unknown, index: number): AuthStep {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`secure-auth step ${index} must be an object`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.selector !== "string" || s.selector.length === 0) {
    throw new Error(`secure-auth step ${index}: "selector" must be a non-empty string`);
  }
  if (typeof s.envVar !== "string" || s.envVar.length === 0) {
    throw new Error(`secure-auth step ${index}: "envVar" must be a non-empty string`);
  }
  if (s.action !== undefined && s.action !== "fill" && s.action !== "type") {
    throw new Error(`secure-auth step ${index}: "action" must be "fill" or "type"`);
  }
  if (s.pressEnterAfter !== undefined && typeof s.pressEnterAfter !== "boolean") {
    throw new Error(`secure-auth step ${index}: "pressEnterAfter" must be a boolean`);
  }
  if (
    s.waitMs !== undefined &&
    (typeof s.waitMs !== "number" || !Number.isFinite(s.waitMs) || s.waitMs < 0)
  ) {
    throw new Error(`secure-auth step ${index}: "waitMs" must be a non-negative number`);
  }
  return {
    selector: s.selector,
    envVar: s.envVar,
    action: s.action as AuthStep["action"],
    pressEnterAfter: s.pressEnterAfter as boolean | undefined,
    waitMs: s.waitMs as number | undefined,
  };
}

/** Handle a vault-only command (no browser). Returns process exit code. */
export async function runVaultCommand(
  name: string,
  vault: Vault,
  render: RenderDeps,
): Promise<number> {
  try {
    if (name === "vault-secrets") {
      const secrets = await vault.listSecrets();
      if (secrets.length === 0) {
        render.stdout("No secrets found in SecureVault");
        return 0;
      }
      for (const s of secrets) {
        render.stdout(`${s.title}${s.category ? ` [${s.category}]` : ""}`);
      }
      return 0;
    }
    // vault-profiles
    const profiles = await vault.listProfiles();
    if (profiles.length === 0) {
      render.stdout("No profiles found in SecureVault");
      return 0;
    }
    for (const p of profiles) {
      render.stdout(p.name);
      for (const m of p.mappings) {
        render.stdout(`  ${m.envVar} -> "${m.secretTitle}"`);
      }
    }
    return 0;
  } catch (e) {
    render.stderr(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/** Handle a secure browser command. Returns process exit code. */
export async function runSecureCommand(
  name: string,
  args: Record<string, unknown>,
  client: ConnectedClient,
  vault: Vault,
  render: RenderDeps,
): Promise<number> {
  try {
    if (name === "secure-fill") {
      const secret = asString(args.secret);
      const selector = asString(args.selector);
      if (!secret || !selector) throw new Error("secure-fill requires --secret and --selector");
      const value = await vault.getSecretByTitle(secret);
      await fillField(client, selector, value);
      render.stdout(`Filled "${selector}" with secret "${secret}" (value hidden)`);
      return 0;
    }

    if (name === "secure-type") {
      const secret = asString(args.secret);
      if (!secret) throw new Error("secure-type requires --secret");
      const selector = asString(args.selector);
      const value = await vault.getSecretByTitle(secret);
      await typeIntoField(client, selector, value);
      if (args.enter === true) await pressEnter(client);
      const where = selector ? `into "${selector}"` : "into focused element";
      render.stdout(`Typed secret "${secret}" ${where}${args.enter === true ? " and pressed Enter" : ""} (value hidden)`);
      return 0;
    }

    if (name === "secure-auth") {
      const profile = asString(args.profile);
      if (!profile) throw new Error("secure-auth requires --profile");
      if (!Array.isArray(args.steps) || args.steps.length === 0) {
        throw new Error('secure-auth requires --json \'{"steps":[...]}\' with at least one step');
      }
      const steps = args.steps.map((s, i) => parseAuthStep(s, i));
      const resolved = await vault.resolveProfile(profile);
      for (const step of steps) {
        const entry = resolved[step.envVar];
        if (!entry) {
          render.stdout(`Skipped "${step.envVar}" — not found in profile "${profile}"`);
          continue;
        }
        if (step.action === "type") {
          await typeIntoField(client, step.selector, entry.value);
        } else {
          await fillField(client, step.selector, entry.value);
        }
        if (step.pressEnterAfter) await pressEnter(client);
        if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
        render.stdout(`${step.action === "type" ? "Typed" : "Filled"} "${step.envVar}" -> "${step.selector}" (value hidden)`);
      }
      return 0;
    }

    if (name === "secure-navigate") {
      const secret = asString(args.secret);
      const profile = asString(args.profile);
      if (secret && profile) {
        throw new Error("secure-navigate: use --secret OR --profile, not both");
      }
      if (secret) {
        const url = await vault.getSecretByTitle(secret);
        await navigateTo(client, url);
        render.stdout(`Navigated to secret "${secret}" (URL hidden)`);
        return 0;
      }
      if (profile) {
        const envVar = asString(args.envVar) ?? "URL";
        const resolved = await vault.resolveProfile(profile);
        const entry = resolved[envVar];
        if (!entry) {
          throw new Error(`secure-navigate: "${envVar}" not found in profile "${profile}"`);
        }
        await navigateTo(client, entry.value);
        render.stdout(`Navigated to "${envVar}" from profile "${profile}" (URL hidden)`);
        return 0;
      }
      throw new Error("secure-navigate requires --secret <title> or --profile <name> [--envVar <var>]");
    }

    // redacted-snapshot
    const values = await collectVaultValues(vault);
    render.stdout(await redactedSnapshot(client, values));
    return 0;
  } catch (e) {
    render.stderr(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
