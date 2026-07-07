export interface ResourceContent {
  uri?: string;
  text?: string;
  mimeType?: string;
  blob?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: ResourceContent;
  [key: string]: unknown;
}

export interface ToolResult {
  content?: ContentBlock[];
  isError?: boolean;
}

export interface RenderDeps {
  stdout(line: string): void;
  stderr(line: string): void;
  writeFile(path: string, data: Buffer): void;
  tmpPath(ext: string): string;
}

export interface RenderOptions {
  out?: string;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "application/pdf": "pdf",
};

export function extFromMime(mimeType: string | undefined): string {
  if (!mimeType) return "bin";
  return MIME_EXT[mimeType] ?? "bin";
}

function isBinaryBlock(block: ContentBlock): boolean {
  if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
    return true;
  }
  return block.type === "resource" && typeof block.resource?.blob === "string";
}

/** Insert `-<index>` before the file extension: shot.png -> shot-2.png. */
function withIndexSuffix(path: string, index: number): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot > slash) return `${path.slice(0, dot)}-${index}${path.slice(dot)}`;
  return `${path}-${index}`;
}

/** Render a tool result. Returns the process exit code (0 ok, 1 tool error). */
export function renderResult(
  result: ToolResult,
  options: RenderOptions,
  deps: RenderDeps,
): number {
  const content = result.content ?? [];

  if (result.isError) {
    const text = content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    deps.stderr(text || "Tool returned an error.");
    return 1;
  }

  const totalBinary = content.filter(isBinaryBlock).length;
  let binaryIndex = 0;

  const saveBinary = (label: string, base64: string, mimeType: string | undefined): void => {
    let path: string;
    if (options.out) {
      binaryIndex += 1;
      path = totalBinary > 1 ? withIndexSuffix(options.out, binaryIndex) : options.out;
    } else {
      path = deps.tmpPath(extFromMime(mimeType));
    }
    deps.writeFile(path, Buffer.from(base64, "base64"));
    deps.stdout(`Saved ${label} to ${path}`);
  };

  for (const block of content) {
    if (block.type === "text") {
      deps.stdout(block.text ?? "");
    } else if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      saveBinary(block.type, block.data, block.mimeType);
    } else if (block.type === "resource" && block.resource) {
      const res = block.resource;
      if (typeof res.blob === "string") {
        saveBinary("resource", res.blob, res.mimeType);
      } else if (typeof res.text === "string") {
        deps.stdout(res.text);
      } else {
        deps.stdout(`Resource: ${res.uri ?? "(no uri)"}`);
      }
    } else {
      deps.stdout(JSON.stringify(block));
    }
  }

  return 0;
}
