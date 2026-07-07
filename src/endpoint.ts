export const DEFAULT_ENDPOINT = "http://127.0.0.1:8931/mcp";

const clean = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim() !== "" ? v : undefined;

/** Resolve the MCP endpoint. Precedence: --url flag > PW_MCP_URL env > default.
 * Empty / whitespace-only values are treated as unset. */
export function resolveEndpoint(
  flagUrl: string | undefined,
  env: Record<string, string | undefined>,
): string {
  return clean(flagUrl) ?? clean(env.PW_MCP_URL) ?? DEFAULT_ENDPOINT;
}
