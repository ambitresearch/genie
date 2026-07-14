#!/usr/bin/env node
import { createServer, SERVER_INFO } from "./server.js";
import { resolvePreviewLocality, resolveTransport, startTransport } from "./transport.js";
import { runTokenCli } from "./auth/token-cli.js";

/** Minimal flag parser — no dependency needed for M0's tiny surface. */
function parseArgs(argv: string[]): {
  transport?: string;
  port?: number;
  host?: string;
  previewLocality?: string;
  requireBearerAuth?: boolean;
  help: boolean;
  version: boolean;
} {
  const out: ReturnType<typeof parseArgs> = { help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--transport":
        out.transport = argv[++i];
        break;
      case "--port":
        out.port = Number(argv[++i]);
        break;
      case "--host":
        out.host = argv[++i];
        break;
      case "--require-bearer-auth":
        out.requireBearerAuth = true;
        break;
      case "--preview-locality": {
        const value = argv[++i];
        if (value === undefined || value.trim() === "" || value.startsWith("-")) {
          throw new Error("--preview-locality requires a value: local or remote.");
        }
        out.previewLocality = value;
        break;
      }
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      default:
        // ignore unknown flags for forward-compat
        break;
    }
  }
  return out;
}

const HELP = `genie — harness-agnostic MCP server for AI UI-component generation

Usage: genie [options]
       genie token <create|list|revoke> [args]   Manage static Bearer tokens

Options:
  --transport <stdio|http>   Transport to use (default: auto-detect by TTY)
  --port <n>                 HTTP port (default: 3000)
  --host <addr>              HTTP host (default: 127.0.0.1)
  --preview-locality <mode>  Preview reachability: local or remote
  --require-bearer-auth      Require Authorization: Bearer <token> on /mcp (HTTP only)
  -v, --version              Print version and exit
  -h, --help                 Show this help

Env:
  MCP_TRANSPORT              Same as --transport
  GENIE_PREVIEW_LOCALITY     Same as --preview-locality
  GENIE_REQUIRE_BEARER_AUTH  Same as --require-bearer-auth ("1"/"true")
  GENIE_HOME                 Root for persisted state, incl. auth/tokens.json
  GENIE_KITS_ROOT            Directory where kit tools read/write UI kits
  GENIE_PROJECTS_ROOT        Directory where create_project writes project roots

This scaffold build boots, speaks MCP, and registers ping plus M1 tools:
kit listing, kit creation, file listing, file reading, validation, and project
create/list/get/delete.`;

function resolveRequireBearerAuth(flag?: boolean): boolean {
  if (flag) return true;
  const env = (process.env.GENIE_REQUIRE_BEARER_AUTH ?? "").trim().toLowerCase();
  return env === "1" || env === "true";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "token") {
    const result = await runTokenCli(argv.slice(1));
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
    return;
  }

  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (args.version) {
    process.stdout.write(`${SERVER_INFO.name} ${SERVER_INFO.version}\n`);
    return;
  }

  const transportKind = resolveTransport(args.transport);
  const host = args.host ?? "127.0.0.1";
  const previewLocality = resolvePreviewLocality(transportKind, args.previewLocality);
  const requireBearerAuth = resolveRequireBearerAuth(args.requireBearerAuth);
  const createConfiguredServer = () => createServer({ transportKind, previewLocality });
  const server = createConfiguredServer();
  await startTransport(server, {
    kind: transportKind,
    port: args.port,
    host,
    ...(transportKind === "http" ? { serverFactory: createConfiguredServer, requireBearerAuth } : {}),
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`genie: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
