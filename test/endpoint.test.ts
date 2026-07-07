import { describe, it, expect } from "vitest";
import { resolveEndpoint, DEFAULT_ENDPOINT } from "../src/endpoint.js";

describe("resolveEndpoint — precedence flag > env > default", () => {
  it("uses the flag when present", () => {
    expect(resolveEndpoint("http://flag/mcp", { PW_MCP_URL: "http://env/mcp" })).toBe(
      "http://flag/mcp",
    );
  });

  it("falls back to env when no flag", () => {
    expect(resolveEndpoint(undefined, { PW_MCP_URL: "http://env/mcp" })).toBe("http://env/mcp");
  });

  it("falls back to the default when neither is set", () => {
    expect(resolveEndpoint(undefined, {})).toBe(DEFAULT_ENDPOINT);
    expect(DEFAULT_ENDPOINT).toBe("http://127.0.0.1:8931/mcp");
  });
});
