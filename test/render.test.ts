import { describe, it, expect } from "vitest";
import { renderResult, extFromMime, type RenderDeps } from "../src/render.js";

interface Captured {
  deps: RenderDeps;
  stdout: string[];
  stderr: string[];
  files: { path: string; data: Buffer }[];
}

function capture(): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files: { path: string; data: Buffer }[] = [];
  return {
    stdout,
    stderr,
    files,
    deps: {
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
      writeFile: (path, data) => files.push({ path, data }),
      tmpPath: (ext) => `/tmp/generated.${ext}`,
    },
  };
}

describe("extFromMime", () => {
  it("maps known mime types and falls back to bin", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("application/octet-stream")).toBe("bin");
    expect(extFromMime(undefined)).toBe("bin");
  });
});

describe("renderResult — text content", () => {
  it("prints text blocks to stdout and returns 0", () => {
    const c = capture();
    const code = renderResult(
      { content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] },
      {},
      c.deps,
    );
    expect(code).toBe(0);
    expect(c.stdout).toEqual(["hello", "world"]);
    expect(c.stderr).toEqual([]);
  });
});

describe("renderResult — image content saved to file", () => {
  it("writes image to a temp path and prints the saved path", () => {
    const c = capture();
    const b64 = Buffer.from("PNGDATA").toString("base64");
    const code = renderResult(
      { content: [{ type: "image", data: b64, mimeType: "image/png" }] },
      {},
      c.deps,
    );
    expect(code).toBe(0);
    expect(c.files).toHaveLength(1);
    expect(c.files[0].path).toBe("/tmp/generated.png");
    expect(c.files[0].data.toString()).toBe("PNGDATA");
    expect(c.stdout).toEqual(["Saved image to /tmp/generated.png"]);
  });

  it("honors --out override path", () => {
    const c = capture();
    const b64 = Buffer.from("X").toString("base64");
    renderResult(
      { content: [{ type: "image", data: b64, mimeType: "image/png" }] },
      { out: "custom.png" },
      c.deps,
    );
    expect(c.files[0].path).toBe("custom.png");
    expect(c.stdout).toEqual(["Saved image to custom.png"]);
  });
});

describe("renderResult — tool error", () => {
  it("prints error text to stderr and returns 1", () => {
    const c = capture();
    const code = renderResult(
      { isError: true, content: [{ type: "text", text: "boom" }] },
      {},
      c.deps,
    );
    expect(code).toBe(1);
    expect(c.stderr).toEqual(["boom"]);
    expect(c.stdout).toEqual([]);
  });

  it("falls back to a generic message when an error has no text", () => {
    const c = capture();
    const code = renderResult({ isError: true, content: [] }, {}, c.deps);
    expect(code).toBe(1);
    expect(c.stderr).toEqual(["Tool returned an error."]);
  });
});

describe("renderResult — audio content", () => {
  it("saves audio blocks to a file", () => {
    const c = capture();
    const b64 = Buffer.from("AUDIO").toString("base64");
    renderResult(
      { content: [{ type: "audio", data: b64, mimeType: "audio/wav" }] },
      {},
      c.deps,
    );
    expect(c.files[0].path).toBe("/tmp/generated.wav");
    expect(c.files[0].data.toString()).toBe("AUDIO");
    expect(c.stdout).toEqual(["Saved audio to /tmp/generated.wav"]);
  });
});

describe("renderResult — resource content", () => {
  it("prints text resources to stdout", () => {
    const c = capture();
    renderResult(
      { content: [{ type: "resource", resource: { uri: "file:///a", text: "body" } }] },
      {},
      c.deps,
    );
    expect(c.stdout).toEqual(["body"]);
    expect(c.files).toHaveLength(0);
  });

  it("prints the uri when a resource has neither text nor blob", () => {
    const c = capture();
    renderResult(
      { content: [{ type: "resource", resource: { uri: "file:///a" } }] },
      {},
      c.deps,
    );
    expect(c.stdout).toEqual(["Resource: file:///a"]);
  });

  it("saves binary resource blobs to a file", () => {
    const c = capture();
    const b64 = Buffer.from("PDFBYTES").toString("base64");
    renderResult(
      {
        content: [
          { type: "resource", resource: { uri: "file:///a.pdf", mimeType: "application/pdf", blob: b64 } },
        ],
      },
      {},
      c.deps,
    );
    expect(c.files[0].path).toBe("/tmp/generated.pdf");
    expect(c.files[0].data.toString()).toBe("PDFBYTES");
    expect(c.stdout).toEqual(["Saved resource to /tmp/generated.pdf"]);
  });
});

describe("renderResult — empty and unknown content", () => {
  it("returns 0 and prints nothing for empty content", () => {
    const c = capture();
    const code = renderResult({ content: [] }, {}, c.deps);
    expect(code).toBe(0);
    expect(c.stdout).toEqual([]);
    expect(c.files).toEqual([]);
  });

  it("returns 0 when content is entirely absent", () => {
    const c = capture();
    expect(renderResult({}, {}, c.deps)).toBe(0);
  });

  it("JSON-stringifies unknown block types", () => {
    const c = capture();
    renderResult({ content: [{ type: "mystery", foo: 1 }]  }, {}, c.deps);
    expect(c.stdout).toEqual(['{"type":"mystery","foo":1}']);
  });
});

describe("renderResult — multiple binaries with --out", () => {
  it("index-suffixes the out path so blocks do not overwrite each other", () => {
    const c = capture();
    const a = Buffer.from("A").toString("base64");
    const b = Buffer.from("B").toString("base64");
    renderResult(
      {
        content: [
          { type: "image", data: a, mimeType: "image/png" },
          { type: "image", data: b, mimeType: "image/png" },
        ],
      },
      { out: "shot.png" },
      c.deps,
    );
    expect(c.files.map((f) => f.path)).toEqual(["shot-1.png", "shot-2.png"]);
    expect(c.files.map((f) => f.data.toString())).toEqual(["A", "B"]);
  });

  it("uses the plain out path when there is a single binary block", () => {
    const c = capture();
    const a = Buffer.from("A").toString("base64");
    renderResult(
      { content: [{ type: "image", data: a, mimeType: "image/png" }] },
      { out: "shot.png" },
      c.deps,
    );
    expect(c.files.map((f) => f.path)).toEqual(["shot.png"]);
  });
});
