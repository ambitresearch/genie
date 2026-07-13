/**
 * `genie token` admin CLI (M5-02, DRO-274).
 *
 * Subcommands:
 *   genie token create [--sub <id>] [--scope read] [--scope write]
 *   genie token list
 *   genie token revoke <prefix>
 *
 * Kept a plain argv-in/stdout-out module (no process.exit calls) so cli.ts
 * can unit-test it and control the process lifecycle itself.
 */
import { createToken, listTokens, revokeToken, type TokenScope } from "./bearer.js";

export interface TokenCliResult {
  /** Text to print to stdout. */
  output: string;
  /** Process exit code the caller should use. */
  exitCode: number;
}

const TOKEN_HELP = `genie token — manage static Bearer tokens (M5-02)

Usage:
  genie token create [--sub <id>] [--scope read] [--scope write]
  genie token list
  genie token revoke <prefix>

Notes:
  - "create" prints the plaintext token exactly once. It is not recoverable
    afterward — only its SHA-256 hash is stored.
  - "--scope" may be passed multiple times; defaults to "read" if omitted.
  - "revoke <prefix>" matches any token whose printed prefix starts with
    <prefix> (the value shown by "genie token list").`;

function parseScopes(argv: string[]): { scopes: TokenScope[]; sub?: string; rest: string[] } {
  const scopes: TokenScope[] = [];
  let sub: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--scope") {
      const value = argv[++i];
      if (value !== "read" && value !== "write") {
        throw new Error(`--scope must be "read" or "write", got: ${value ?? "<missing>"}`);
      }
      scopes.push(value);
    } else if (arg === "--sub") {
      sub = argv[++i];
    } else {
      rest.push(arg);
    }
  }
  return { scopes, sub, rest };
}

/** Run `genie token <subcommand> ...args`. Never calls process.exit. */
export async function runTokenCli(argv: string[]): Promise<TokenCliResult> {
  const [subcommand, ...rest] = argv;

  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help") {
    return { output: TOKEN_HELP + "\n", exitCode: 0 };
  }

  if (subcommand === "create") {
    const { scopes, sub } = parseScopes(rest);
    const { token, record } = await createToken({
      sub: sub ?? "default",
      scopes: scopes.length > 0 ? scopes : undefined,
    });
    const lines = [
      `Token created (shown once — copy it now, it cannot be displayed again):`,
      "",
      `  ${token}`,
      "",
      `  sub:    ${record.sub}`,
      `  scopes: ${record.scopes.join(", ")}`,
      `  prefix: ${record.prefix}`,
      "",
    ];
    return { output: lines.join("\n"), exitCode: 0 };
  }

  if (subcommand === "list") {
    const tokens = await listTokens();
    if (tokens.length === 0) {
      return { output: "No tokens.\n", exitCode: 0 };
    }
    const lines = tokens.map(
      (t) =>
        `${t.prefix}...  sub=${t.sub}  scopes=${t.scopes.join(",")}  createdAt=${t.createdAt}  lastUsedAt=${
          t.lastUsedAt ?? "never"
        }`,
    );
    return { output: lines.join("\n") + "\n", exitCode: 0 };
  }

  if (subcommand === "revoke") {
    const prefix = rest[0];
    if (prefix === undefined || prefix.trim() === "") {
      return { output: "genie token revoke: missing <prefix> argument.\n", exitCode: 1 };
    }
    const removed = await revokeToken(prefix);
    if (removed === 0) {
      return { output: `No token found matching prefix "${prefix}".\n`, exitCode: 1 };
    }
    return { output: `Revoked ${removed} token(s) matching prefix "${prefix}".\n`, exitCode: 0 };
  }

  return { output: `genie token: unknown subcommand "${subcommand}".\n\n${TOKEN_HELP}\n`, exitCode: 1 };
}
