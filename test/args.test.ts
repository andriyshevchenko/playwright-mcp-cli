import { describe, it, expect } from "vitest";
import { parseCli, parseValue, CliError } from "../src/args.js";

describe("parseValue", () => {
  it("parses integers and floats as numbers", () => {
    expect(parseValue("42")).toBe(42);
    expect(parseValue("-3.5")).toBe(-3.5);
    expect(parseValue("1e3")).toBe(1000);
  });

  it("parses booleans", () => {
    expect(parseValue("true")).toBe(true);
    expect(parseValue("false")).toBe(false);
  });

  it("keeps non-numeric, non-boolean values as strings", () => {
    expect(parseValue("https://example.com")).toBe("https://example.com");
    expect(parseValue("123abc")).toBe("123abc");
    expect(parseValue("")).toBe("");
  });
});

describe("parseCli — flag/arg parsing", () => {
  it("auto-parses numbers, booleans and strings from flags", () => {
    const { command } = parseCli(["call", "t", "--count", "5", "--flag", "--name", "bob"]);
    expect(command).toEqual({
      kind: "call",
      toolName: "t",
      args: { count: 5, flag: true, name: "bob" },
    });
  });

  it("merges a raw JSON object via --json", () => {
    const { command } = parseCli([
      "call",
      "t",
      "--a",
      "1",
      "--json",
      '{"url":"https://x.com","nested":{"k":1}}',
    ]);
    expect(command).toMatchObject({
      kind: "call",
      toolName: "t",
      args: { a: 1, url: "https://x.com", nested: { k: 1 } },
    });
  });

  it("rejects invalid or non-object --json", () => {
    expect(() => parseCli(["call", "t", "--json", "not json"])).toThrow(CliError);
    expect(() => parseCli(["call", "t", "--json", "[1,2]"])).toThrow(CliError);
  });
});

describe("parseCli — dispatch (shorthand vs call vs list vs help)", () => {
  it("dispatches list", () => {
    expect(parseCli(["list"]).command).toEqual({ kind: "list" });
  });

  it("dispatches explicit call form", () => {
    expect(parseCli(["call", "browser_navigate"]).command).toEqual({
      kind: "call",
      toolName: "browser_navigate",
      args: {},
    });
  });

  it("dispatches shorthand form identically to call", () => {
    const shorthand = parseCli(["browser_navigate", "--foo", "bar"]).command;
    const explicit = parseCli(["call", "browser_navigate", "--foo", "bar"]).command;
    expect(shorthand).toEqual(explicit);
  });

  it("errors when `call` has no tool name", () => {
    expect(() => parseCli(["call"])).toThrow(CliError);
  });

  it("returns help for empty argv and help as the command token", () => {
    expect(parseCli([]).command).toEqual({ kind: "help" });
    expect(parseCli(["help"]).command).toEqual({ kind: "help" });
    expect(parseCli(["--help"]).command).toEqual({ kind: "help" });
    expect(parseCli(["-h"]).command).toEqual({ kind: "help" });
  });

  it("does NOT treat a flag value of help/-h as a help request", () => {
    expect(parseCli(["browser_type", "--text", "help"]).command).toEqual({
      kind: "call",
      toolName: "browser_type",
      args: { text: "help" },
    });
    expect(parseCli(["some_tool", "--query", "-h"]).command).toMatchObject({
      kind: "call",
      toolName: "some_tool",
    });
  });
});

describe("parseCli — reserved global flags", () => {
  it("extracts --url and --out into global, not tool args", () => {
    const { command, global } = parseCli([
      "call",
      "t",
      "--url",
      "http://host:1/mcp",
      "--out",
      "shot.png",
      "--real",
      "arg",
    ]);
    expect(global).toEqual({ url: "http://host:1/mcp", out: "shot.png" });
    expect(command).toEqual({ kind: "call", toolName: "t", args: { real: "arg" } });
  });

  it("treats --safe as a boolean global without consuming the next token", () => {
    const { command, global } = parseCli(["browser_snapshot", "--safe", "--foo", "bar"]);
    expect(global).toEqual({ safe: true });
    expect(command).toEqual({ kind: "call", toolName: "browser_snapshot", args: { foo: "bar" } });
  });

  it("treats --no-keepalive as a boolean global without consuming the next token", () => {
    const { command, global } = parseCli(["browser_snapshot", "--no-keepalive", "--foo", "bar"]);
    expect(global).toEqual({ noKeepalive: true });
    expect(command).toEqual({ kind: "call", toolName: "browser_snapshot", args: { foo: "bar" } });
  });
});

describe("parseCli — keepalive commands", () => {
  it("dispatches keepalive start/stop/status", () => {
    expect(parseCli(["keepalive", "start"]).command).toEqual({ kind: "keepalive", action: "start" });
    expect(parseCli(["keepalive", "stop"]).command).toEqual({ kind: "keepalive", action: "stop" });
    expect(parseCli(["keepalive", "status"]).command).toEqual({ kind: "keepalive", action: "status" });
  });

  it("defaults keepalive with no action to status", () => {
    expect(parseCli(["keepalive"]).command).toEqual({ kind: "keepalive", action: "status" });
  });

  it("rejects an unknown keepalive action", () => {
    expect(() => parseCli(["keepalive", "bogus"])).toThrow(CliError);
  });

  it("dispatches the internal __keepalive daemon command", () => {
    expect(parseCli(["__keepalive"]).command).toEqual({ kind: "keepalive-daemon" });
  });
});
