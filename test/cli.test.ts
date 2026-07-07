import { describe, it, expect, vi } from "vitest";
import { run, type RunDeps } from "../src/cli.js";
import type { ConnectedClient } from "../src/mcp.js";
import type { ToolResult } from "../src/render.js";

interface Harness {
  deps: RunDeps;
  stdout: string[];
  stderr: string[];
  files: { path: string; data: Buffer }[];
  client: {
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  tools?: { name: string; description?: string }[];
  callResult?: ToolResult;
  env?: Record<string, string | undefined>;
  connectError?: Error;
}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files: { path: string; data: Buffer }[] = [];

  const client = {
    listTools: vi.fn(async () => ({ tools: opts.tools ?? [] })),
    callTool: vi.fn(async () => opts.callResult ?? { content: [] }),
    close: vi.fn(async () => {}),
  };

  const connect = vi.fn(async (_endpoint: string): Promise<ConnectedClient> => {
    if (opts.connectError) throw opts.connectError;
    return client as unknown as ConnectedClient;
  });

  return {
    stdout,
    stderr,
    files,
    client,
    connect,
    deps: {
      connect,
      env: opts.env ?? {},
      render: {
        stdout: (l) => stdout.push(l),
        stderr: (l) => stderr.push(l),
        writeFile: (path, data) => files.push({ path, data }),
        tmpPath: (ext) => `/tmp/generated.${ext}`,
      },
    },
  };
}

describe("run — list", () => {
  it("prints each tool name with its first description line", async () => {
    const h = harness({
      tools: [
        { name: "browser_navigate", description: "Navigate to a URL\nsecond line" },
        { name: "browser_click" },
      ],
    });
    const code = await run(["list"], h.deps);
    expect(code).toBe(0);
    expect(h.stdout).toEqual(["browser_navigate — Navigate to a URL", "browser_click"]);
    expect(h.client.close).toHaveBeenCalledOnce();
  });
});

describe("run — call dispatch", () => {
  it("passes parsed name and arguments to callTool (shorthand)", async () => {
    const h = harness({ callResult: { content: [{ type: "text", text: "ok" }] } });
    const code = await run(["browser_navigate", "--width", "800", "--headless"], h.deps);
    expect(code).toBe(0);
    expect(h.client.callTool).toHaveBeenCalledWith({
      name: "browser_navigate",
      arguments: { width: 800, headless: true },
    });
    expect(h.stdout).toEqual(["ok"]);
  });

  it("renders an image result to a file", async () => {
    const b64 = Buffer.from("IMG").toString("base64");
    const h = harness({
      callResult: { content: [{ type: "image", data: b64, mimeType: "image/png" }] },
    });
    const code = await run(["call", "browser_take_screenshot"], h.deps);
    expect(code).toBe(0);
    expect(h.files[0].path).toBe("/tmp/generated.png");
    expect(h.stdout).toEqual(["Saved image to /tmp/generated.png"]);
  });

  it("returns non-zero exit on a tool error", async () => {
    const h = harness({
      callResult: { isError: true, content: [{ type: "text", text: "nope" }] },
    });
    const code = await run(["some_tool"], h.deps);
    expect(code).toBe(1);
    expect(h.stderr).toEqual(["nope"]);
    expect(h.client.close).toHaveBeenCalledOnce();
  });

  it("closes the client and exits 1 when callTool rejects", async () => {
    const h = harness({});
    h.client.callTool.mockRejectedValueOnce(new Error("kaboom"));
    const code = await run(["some_tool"], h.deps);
    expect(code).toBe(1);
    expect(h.stderr).toEqual(["kaboom"]);
    expect(h.client.close).toHaveBeenCalledOnce();
  });
});

describe("run — endpoint resolution precedence", () => {
  it("prefers --url flag over env and default", async () => {
    const h = harness({ tools: [], env: { PW_MCP_URL: "http://env/mcp" } });
    await run(["list", "--url", "http://flag/mcp"], h.deps);
    expect(h.connect).toHaveBeenCalledWith("http://flag/mcp");
  });

  it("uses env when no flag", async () => {
    const h = harness({ tools: [], env: { PW_MCP_URL: "http://env/mcp" } });
    await run(["list"], h.deps);
    expect(h.connect).toHaveBeenCalledWith("http://env/mcp");
  });

  it("uses the default when neither is set", async () => {
    const h = harness({ tools: [], env: {} });
    await run(["list"], h.deps);
    expect(h.connect).toHaveBeenCalledWith("http://127.0.0.1:8931/mcp");
  });
});

describe("run — help and connect failure", () => {
  it("prints help without connecting", async () => {
    const h = harness({});
    const code = await run([], h.deps);
    expect(code).toBe(0);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.stdout.join("\n")).toContain("Usage:");
  });

  it("reports a connect failure as exit 1", async () => {
    const h = harness({ connectError: new Error("ECONNREFUSED") });
    const code = await run(["list"], h.deps);
    expect(code).toBe(1);
    expect(h.stderr[0]).toContain("Failed to connect");
  });
});
