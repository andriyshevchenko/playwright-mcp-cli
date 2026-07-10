import { describe, it, expect, vi } from "vitest";
import { run, type RunDeps } from "../src/cli.js";
import {
  collectVaultValues,
  redactResult,
  runSecureCommand,
  runVaultCommand,
} from "../src/secure.js";
import type { ConnectedClient } from "../src/mcp.js";
import type { ToolResult } from "../src/render.js";
import type { Vault } from "../src/vault.js";

function fakeVault(over: Partial<Vault> = {}): Vault {
  return {
    getSecretByTitle: async (t) => `secret-for-${t}`,
    resolveProfile: async () => ({
      EMAIL: { value: "user@corp.com", label: "Email" },
      PASSWORD: { value: "hunter2", label: "Password" },
    }),
    listSecrets: async () => [
      { title: "NICE_EMAIL", category: "email" },
      { title: "NICE_PASSWORD", category: "password" },
    ],
    listProfiles: async () => [
      { name: "NICE", mappings: [{ envVar: "EMAIL", secretTitle: "NICE_EMAIL" }] },
    ],
    ...over,
  };
}

interface Rec {
  stdout: string[];
  stderr: string[];
  calls: { name: string; arguments: Record<string, unknown> }[];
  render: RunDeps["render"];
  client: ConnectedClient;
}

function rec(callResults: Record<string, ToolResult> = {}): Rec {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const client: ConnectedClient = {
    listTools: async () => ({ tools: [] }),
    callTool: async (p) => {
      calls.push(p);
      return callResults[p.name] ?? { content: [] };
    },
    close: async () => {},
  };
  return {
    stdout,
    stderr,
    calls,
    client,
    render: {
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
      writeFile: () => {},
      tmpPath: (ext) => `/tmp/x.${ext}`,
    },
  };
}

describe("vault commands", () => {
  it("vault-secrets lists titles with categories", async () => {
    const r = rec();
    const code = await runVaultCommand("vault-secrets", fakeVault(), r.render);
    expect(code).toBe(0);
    expect(r.stdout).toEqual(["NICE_EMAIL [email]", "NICE_PASSWORD [password]"]);
  });

  it("vault-profiles lists env var mappings", async () => {
    const r = rec();
    const code = await runVaultCommand("vault-profiles", fakeVault(), r.render);
    expect(code).toBe(0);
    expect(r.stdout).toEqual(["NICE", '  EMAIL -> "NICE_EMAIL"']);
  });

  it("reports empty vault", async () => {
    const r = rec();
    const code = await runVaultCommand("vault-secrets", fakeVault({ listSecrets: async () => [] }), r.render);
    expect(code).toBe(0);
    expect(r.stdout).toEqual(["No secrets found in SecureVault"]);
  });
});

describe("secure-fill", () => {
  it("resolves the secret and injects it via browser_evaluate without leaking the value", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-fill",
      { secret: "NICE_EMAIL", selector: "input[name='loginfmt']" },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe("browser_evaluate");
    const fn = String(r.calls[0].arguments.function);
    expect(fn).toContain("input[name='loginfmt']");
    expect(fn).toContain("secret-for-NICE_EMAIL");
    expect(r.stdout.join("\n")).not.toContain("secret-for-NICE_EMAIL");
    expect(r.stdout[0]).toContain("(value hidden)");
  });

  it("errors when selector is missing", async () => {
    const r = rec();
    const code = await runSecureCommand("secure-fill", { secret: "X" }, r.client, fakeVault(), r.render);
    expect(code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.stderr[0]).toContain("--secret and --selector");
  });

  it("surfaces a browser tool error as exit 1", async () => {
    const r = rec({ browser_evaluate: { isError: true, content: [{ type: "text", text: "boom" }] } });
    const code = await runSecureCommand(
      "secure-fill",
      { secret: "X", selector: "#a" },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(1);
    expect(r.stderr[0]).toContain("boom");
  });
});

describe("secure-fill", () => {
  it("redacts the secret value if the daemon echoes it back in an error", async () => {
    const r = rec({
      browser_evaluate: {
        isError: true,
        content: [{ type: "text", text: "eval failed on function: () => { const value = \"secret-for-NICE_EMAIL\"; }" }],
      },
    });
    const code = await runSecureCommand(
      "secure-fill",
      { secret: "NICE_EMAIL", selector: "#e" },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(1);
    expect(r.stderr.join("\n")).not.toContain("secret-for-NICE_EMAIL");
    expect(r.stderr.join("\n")).toContain("[REDACTED]");
  });
});

describe("secure-type", () => {
  it("does not corrupt injected JS when the value contains the marker text", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-type",
      { secret: "TRICKY", selector: "#p" },
      r.client,
      fakeVault({ getSecretByTitle: async () => "abc'filled'xyz" }),
      r.render,
    );
    expect(code).toBe(0);
    const fn = String(r.calls[0].arguments.function);
    expect(fn).toContain("return 'typed';");
    expect(fn).toContain(JSON.stringify("abc'filled'xyz"));
  });

  it("types then presses Enter when --enter is set", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-type",
      { secret: "NICE_PASSWORD", selector: "#p", enter: true },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(0);
    expect(r.calls.map((c) => c.name)).toEqual(["browser_evaluate", "browser_press_key"]);
    expect(r.calls[1].arguments).toEqual({ key: "Enter" });
  });
});

describe("secure-navigate", () => {
  it("resolves a --secret URL and navigates without leaking it", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-navigate",
      { secret: "GL_URL" },
      r.client,
      fakeVault({ getSecretByTitle: async () => "https://portal.example.com/secret-path" }),
      r.render,
    );
    expect(code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe("browser_navigate");
    expect(r.calls[0].arguments).toEqual({ url: "https://portal.example.com/secret-path" });
    expect(r.stdout.join("\n")).not.toContain("secret-path");
    expect(r.stdout[0]).toContain("(URL hidden)");
  });

  it("resolves a URL from a profile envVar (default URL)", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-navigate",
      { profile: "GL" },
      r.client,
      fakeVault({
        resolveProfile: async () => ({ URL: { value: "https://secret.example.com", label: "Portal" } }),
      }),
      r.render,
    );
    expect(code).toBe(0);
    expect(r.calls[0].arguments).toEqual({ url: "https://secret.example.com" });
    expect(r.stdout[0]).toContain('from profile "GL"');
  });

  it("resolves an explicit --envVar override from a profile", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-navigate",
      { profile: "GL", envVar: "PORTAL" },
      r.client,
      fakeVault({
        resolveProfile: async () => ({ PORTAL: { value: "https://portal.example.com", label: "P" } }),
      }),
      r.render,
    );
    expect(code).toBe(0);
    expect(r.calls[0].arguments).toEqual({ url: "https://portal.example.com" });
    expect(r.stdout[0]).toContain('"PORTAL"');
  });

  it("errors when both --secret and --profile are given", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-navigate",
      { secret: "GL_URL", profile: "GL" },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.stderr[0]).toContain("not both");
  });

  it("errors when the profile lacks the requested envVar", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-navigate",
      { profile: "GL", envVar: "HOME" },
      r.client,
      fakeVault({ resolveProfile: async () => ({}) }),
      r.render,
    );
    expect(code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.stderr[0]).toContain("HOME");
  });

  it("errors when neither --secret nor --profile is given", async () => {
    const r = rec();
    const code = await runSecureCommand("secure-navigate", {}, r.client, fakeVault(), r.render);
    expect(code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.stderr[0]).toContain("--secret");
  });

  it("redacts the URL if the daemon echoes it back in an error", async () => {
    const r = rec({
      browser_navigate: {
        isError: true,
        content: [{ type: "text", text: "navigation failed for https://portal.example.com/secret-path" }],
      },
    });
    const code = await runSecureCommand(
      "secure-navigate",
      { secret: "GL_URL" },
      r.client,
      fakeVault({ getSecretByTitle: async () => "https://portal.example.com/secret-path" }),
      r.render,
    );
    expect(code).toBe(1);
    expect(r.stderr.join("\n")).not.toContain("secret-path");
    expect(r.stderr.join("\n")).toContain("[REDACTED]");
  });
});

describe("secure-auth", () => {
  it("runs each step, filling/typing resolved values and pressing Enter", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-auth",
      {
        profile: "NICE",
        steps: [
          { selector: "#email", envVar: "EMAIL", action: "fill", pressEnterAfter: true },
          { selector: "#pass", envVar: "PASSWORD", action: "type" },
        ],
      },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(0);
    expect(r.calls.map((c) => c.name)).toEqual([
      "browser_evaluate",
      "browser_press_key",
      "browser_evaluate",
    ]);
    expect(r.stdout.join("\n")).not.toContain("user@corp.com");
  });

  it("skips env vars not present in the profile", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-auth",
      { profile: "NICE", steps: [{ selector: "#x", envVar: "MISSING" }] },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(r.stdout[0]).toContain("Skipped");
  });

  it("errors without steps", async () => {
    const r = rec();
    const code = await runSecureCommand("secure-auth", { profile: "NICE" }, r.client, fakeVault(), r.render);
    expect(code).toBe(1);
    expect(r.stderr[0]).toContain("steps");
  });

  it("rejects a step with a non-string selector without touching the browser", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-auth",
      { profile: "NICE", steps: [{ selector: 123, envVar: "EMAIL" }] },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.stderr[0]).toContain("selector");
  });

  it("rejects a step with an invalid action", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-auth",
      { profile: "NICE", steps: [{ selector: "#e", envVar: "EMAIL", action: "paste" }] },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(1);
    expect(r.stderr[0]).toContain("action");
  });

  it("rejects a step with a negative waitMs", async () => {
    const r = rec();
    const code = await runSecureCommand(
      "secure-auth",
      { profile: "NICE", steps: [{ selector: "#e", envVar: "EMAIL", waitMs: -5 }] },
      r.client,
      fakeVault(),
      r.render,
    );
    expect(code).toBe(1);
    expect(r.stderr[0]).toContain("waitMs");
  });
});

describe("redacted-snapshot", () => {
  it("replaces every vault value with [REDACTED]", async () => {
    const snapshot: ToolResult = {
      content: [{ type: "text", text: "email: secret-for-NICE_EMAIL, pass: secret-for-NICE_PASSWORD" }],
    };
    const r = rec({ browser_snapshot: snapshot });
    const code = await runSecureCommand("redacted-snapshot", {}, r.client, fakeVault(), r.render);
    expect(code).toBe(0);
    const out = r.stdout.join("\n");
    expect(out).not.toContain("secret-for-NICE_EMAIL");
    expect(out).toContain("[REDACTED]");
  });
});

describe("run — secure command routing", () => {
  function runDeps(over: Partial<RunDeps>): { deps: RunDeps; connect: ReturnType<typeof vi.fn>; r: Rec } {
    const r = rec();
    const connect = vi.fn(async () => r.client);
    return {
      r,
      connect,
      deps: { connect, env: {}, vault: fakeVault(), render: r.render, ...over },
    };
  }

  it("vault-secrets does not open a daemon connection", async () => {
    const { deps, connect } = runDeps({});
    const code = await run(["vault-secrets"], deps);
    expect(code).toBe(0);
    expect(connect).not.toHaveBeenCalled();
  });

  it("secure-fill connects and dispatches to the secure handler", async () => {
    const { deps, connect, r } = runDeps({});
    const code = await run(
      ["secure-fill", "--secret", "NICE_EMAIL", "--selector", "#e"],
      deps,
    );
    expect(code).toBe(0);
    expect(connect).toHaveBeenCalledOnce();
    expect(r.calls[0].name).toBe("browser_evaluate");
  });

  it("--safe scrubs vault values from a raw tool result", async () => {
    const r = rec({
      browser_snapshot: {
        content: [{ type: "text", text: "email field: secret-for-NICE_EMAIL" }],
      },
    });
    const deps: RunDeps = { connect: async () => r.client, env: {}, vault: fakeVault(), render: r.render };
    const code = await run(["browser_snapshot", "--safe"], deps);
    expect(code).toBe(0);
    const out = r.stdout.join("\n");
    expect(out).not.toContain("secret-for-NICE_EMAIL");
    expect(out).toContain("[REDACTED]");
  });

  it("does NOT scrub without --safe (opt-in)", async () => {
    const r = rec({
      browser_snapshot: { content: [{ type: "text", text: "secret-for-NICE_EMAIL" }] },
    });
    const deps: RunDeps = { connect: async () => r.client, env: {}, vault: fakeVault(), render: r.render };
    await run(["browser_snapshot"], deps);
    expect(r.stdout.join("\n")).toContain("secret-for-NICE_EMAIL");
  });

  it("enables safe mode via PW_SAFE_MODE=1 env", async () => {
    const r = rec({
      browser_snapshot: { content: [{ type: "text", text: "secret-for-NICE_EMAIL" }] },
    });
    const deps: RunDeps = {
      connect: async () => r.client,
      env: { PW_SAFE_MODE: "1" },
      vault: fakeVault(),
      render: r.render,
    };
    await run(["browser_snapshot"], deps);
    expect(r.stdout.join("\n")).not.toContain("secret-for-NICE_EMAIL");
  });
});

describe("redactResult / collectVaultValues", () => {
  it("collects every resolvable secret value", async () => {
    const values = await collectVaultValues(fakeVault());
    expect(values.sort()).toEqual(["secret-for-NICE_EMAIL", "secret-for-NICE_PASSWORD"]);
  });

  it("scrubs text and resource.text fields, leaving binary blocks untouched", () => {
    const out = redactResult(
      {
        content: [
          { type: "text", text: "a secret-for-X b" },
          { type: "resource", resource: { text: "secret-for-X in resource" } },
          { type: "image", data: "secret-for-X-lookalike-base64" },
        ],
      },
      ["secret-for-X"],
    );
    expect(out.content?.[0].text).toBe("a [REDACTED] b");
    expect(out.content?.[1].resource?.text).toBe("[REDACTED] in resource");
    // binary data is not text and must be left as-is
    expect(out.content?.[2].data).toBe("secret-for-X-lookalike-base64");
  });

  it("scrubs unknown block fields (the JSON.stringify render fallback) and resource.uri", () => {
    const out = redactResult(
      {
        content: [
          { type: "data", value: "leaked secret-for-X here", nested: { deep: "secret-for-X" } },
          { type: "resource", resource: { uri: "https://x/?email=secret-for-X" } },
        ],
      },
      ["secret-for-X"],
    );
    expect(out.content?.[0].value).toBe("leaked [REDACTED] here");
    expect((out.content?.[0].nested as { deep: string }).deep).toBe("[REDACTED]");
    expect(out.content?.[1].resource?.uri).toBe("https://x/?email=[REDACTED]");
  });

  it("returns the result unchanged when there are no values", () => {
    const input = { content: [{ type: "text", text: "nothing to hide" }] };
    expect(redactResult(input, [])).toBe(input);
  });
});
