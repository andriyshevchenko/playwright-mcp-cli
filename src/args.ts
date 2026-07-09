export class CliError extends Error {}

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "call"; toolName: string; args: Record<string, unknown> };

export interface GlobalOptions {
  url?: string;
  out?: string;
  safe?: boolean;
}

export interface ParsedCli {
  command: ParsedCommand;
  global: GlobalOptions;
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Auto-parse a raw flag value into number | boolean | string. */
export function parseValue(raw: string): number | boolean | string {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const trimmed = raw.trim();
  if (trimmed !== "" && NUMBER_RE.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

const RESERVED = new Set(["url", "out"]);
/** Reserved boolean globals: present => true, never consume a following token. */
const BOOL_RESERVED = new Set(["safe"]);

interface Tokenized {
  positionals: string[];
  flags: Record<string, unknown>;
  global: GlobalOptions;
}

function requireValue(hasValue: boolean, key: string): void {
  if (!hasValue) throw new CliError(`--${key} requires a value`);
}

function tokenize(argv: string[]): Tokenized {
  const positionals: string[] = [];
  const flags: Record<string, unknown> = {};
  const global: GlobalOptions = {};
  let jsonMerge: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      const hasValue = next !== undefined && !next.startsWith("--");

      if (key === "json") {
        requireValue(hasValue, key);
        let parsed: unknown;
        try {
          parsed = JSON.parse(next as string);
        } catch {
          throw new CliError("--json value is not valid JSON");
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new CliError("--json must be a JSON object");
        }
        jsonMerge = { ...jsonMerge, ...(parsed as Record<string, unknown>) };
        i++;
        continue;
      }

      if (BOOL_RESERVED.has(key)) {
        global.safe = true;
        continue;
      }

      if (RESERVED.has(key)) {
        requireValue(hasValue, key);
        (global as Record<string, string>)[key] = next as string;
        i++;
        continue;
      }

      if (hasValue) {
        flags[key] = parseValue(next as string);
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  // --json object merges over/into individual flags.
  return { positionals, flags: { ...flags, ...jsonMerge }, global };
}

/** Parse process argv (already sliced past node + script) into a command. */
export function parseCli(argv: string[]): ParsedCli {
  if (argv.length === 0) return { command: { kind: "help" }, global: {} };
  // Only the command token itself triggers help — never a flag value like `--text help`.
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { command: { kind: "help" }, global: {} };
  }

  const { positionals, flags, global } = tokenize(argv);

  if (positionals.length === 0) {
    return { command: { kind: "help" }, global };
  }

  if (positionals[0] === "list") {
    return { command: { kind: "list" }, global };
  }

  if (positionals[0] === "call") {
    const toolName = positionals[1];
    if (!toolName) throw new CliError("`call` requires a tool name");
    return { command: { kind: "call", toolName, args: flags }, global };
  }

  // Shorthand: `pw <toolName> [--flags]`.
  return { command: { kind: "call", toolName: positionals[0], args: flags }, global };
}
