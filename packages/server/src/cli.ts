#!/usr/bin/env node
import { createServer, SERVER_INFO } from "./server.js";
import { resolveTransport, startTransport } from "./transport.js";

/** Minimal flag parser — no dependency needed for M0's tiny surface. */
function parseArgs(argv: string[]): {
  transport?: string;
  port?: number;
  host?: string;
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

Options:
  --transport <stdio|http>   Transport to use (default: auto-detect by TTY)
  --port <n>                 HTTP port (default: 3000)
  --host <addr>              HTTP host (default: 127.0.0.1)
  -v, --version              Print version and exit
  -h, --help                 Show this help

Env:
  MCP_TRANSPORT              Same as --transport
  GENIE_KITS_ROOT            Directory where kit tools read/write UI kits
  GENIE_PROJECTS_ROOT        Directory where create_project writes project roots

This scaffold build boots, speaks MCP, and registers ping plus M1 tools:
kit listing, kit creation, file listing, file reading, validation, and project
create/list/get/delete.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (args.version) {
    process.stdout.write(`${SERVER_INFO.name} ${SERVER_INFO.version}\n`);
    return;
  }

  const transportKind = resolveTransport(args.transport);
  const server = createServer({ transportKind });
  await startTransport(server, {
    kind: transportKind,
    port: args.port,
    host: args.host,
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`genie: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
