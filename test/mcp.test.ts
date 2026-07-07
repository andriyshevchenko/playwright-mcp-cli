import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  transportClose: vi.fn(),
  transportCtor: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(() => ({
    connect: mocks.connect,
    close: mocks.close,
    listTools: mocks.listTools,
    callTool: mocks.callTool,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn((url: URL) => {
    mocks.transportCtor(url);
    return { close: mocks.transportClose };
  }),
}));

import { connect } from "../src/mcp.js";

describe("connect — real factory over mocked SDK", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.transportClose.mockResolvedValue(undefined);
  });

  it("builds the transport from new URL(endpoint) and connects", async () => {
    await connect("http://host:8931/mcp");
    expect(mocks.transportCtor).toHaveBeenCalledOnce();
    const urlArg = mocks.transportCtor.mock.calls[0][0];
    expect(urlArg).toBeInstanceOf(URL);
    expect((urlArg as URL).href).toBe("http://host:8931/mcp");
    expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it("delegates listTools/callTool and close to the client", async () => {
    mocks.listTools.mockResolvedValue({ tools: [{ name: "t" }] });
    mocks.callTool.mockResolvedValue({ content: [] });

    const client = await connect("http://x/mcp");
    const tools = await client.listTools();
    await client.callTool({ name: "t", arguments: { a: 1 } });
    await client.close();

    expect(tools).toEqual({ tools: [{ name: "t" }] });
    expect(mocks.callTool).toHaveBeenCalledWith({ name: "t", arguments: { a: 1 } });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.transportClose).not.toHaveBeenCalled();
  });

  it("closes the partially-opened transport and rethrows when connect fails", async () => {
    mocks.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(connect("http://x/mcp")).rejects.toThrow("ECONNREFUSED");
    expect(mocks.transportClose).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
