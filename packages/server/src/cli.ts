#!/usr/bin/env node
import { createServer, SERVER_INFO } from "./server.js";
import { resolvePreviewLocality, resolveTransport, startTransport } from "./transport.js";
import { runTokenCli } from "./auth/token-cli.js";
import type { Logger } from "pino";

import { createRedactingLogger } from "./config/redact.js";
import { applyLoadedSecrets, auditLoadedSecrets, loadSecrets } from "./config/secrets.js";

/** Minimal flag parser — no dependency needed for M0's tiny surface. */
function parseArgs(argv: string[]): {
  transport?: string;
  port?: number;
  host?: string;
  previewLocality?: string;
  requireBearerAuth?: boolean;
  secretsFrom?: string;
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
      case "--secrets-from": {
        const value = argv[++i];
        if (value === undefined || value.trim() === "" || value.startsWith("-")) {
          throw new Error("--secrets-from requires a path, e.g. a mounted Docker secret.");
        }
        out.secretsFrom = value;
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
  --secrets-from <path>      Read secrets from an owner-only KEY=VALUE file
                             (e.g. a mounted container secret), overriding env
  -v, --version              Print version and exit
  -h, --help                 Show this help

Env:
  MCP_TRANSPORT              Same as --transport
  GENIE_PREVIEW_LOCALITY     Same as --preview-locality
  GENIE_REQUIRE_BEARER_AUTH  Same as --require-bearer-auth ("1"/"true")
  GENIE_HOME                 Root for persisted state, incl. auth/tokens.json
  GENIE_KITS_ROOT            Directory where kit tools read/write UI kits
  GENIE_PROJECTS_ROOT        Directory where create_project writes project roots
  GENIE_LLM_BASE_URL         OpenAI-compatible /v1 endpoint for conjure/refine
  GENIE_LLM_API_KEY          Required secret — LLM endpoint API key
  OAUTH_HS256_KEY            Optional HTTP OAuth signing key (32+ characters)
  GENIE_GIT_TOKEN            Optional secret — git host API token
  OAUTH_CLIENT_SECRET        Optional secret — OAuth confidential client secret

This scaffold build boots, speaks MCP, and registers ping plus M1 tools:
kit listing, kit creation, file listing, file reading, validation, and project
create/list/get/delete.`;

function resolveRequireBearerAuth(flag?: boolean): boolean {
  if (flag) return true;
  const env = (process.env.GENIE_REQUIRE_BEARER_AUTH ?? "").trim().toLowerCase();
  return env === "1" || env === "true";
}

let logger: Logger | undefined;

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

  const loadedSecrets = loadSecrets({ secretsFromPath: args.secretsFrom });
  applyLoadedSecrets(loadedSecrets);
  logger = createRedactingLogger(loadedSecrets);
  auditLoadedSecrets(loadedSecrets, (line) => logger?.info(JSON.parse(line)));

  const transportKind = resolveTransport(args.transport);
  const host = args.host ?? "127.0.0.1";
  const previewLocality = resolvePreviewLocality(transportKind, args.previewLocality);
  const requireBearerAuth = resolveRequireBearerAuth(args.requireBearerAuth);
  const createConfiguredServer = () => createServer({ transportKind, previewLocality });
  const server = createConfiguredServer();

  // Test-only hook (M5-13 / DRO-285 AC4): when set, register N additional
  // no-op tools on the SAME server instance this CLI starts over its real
  // transport, so the harness smoke suites can probe `tools/list` over the
  // exact transport a harness config launches — not an in-memory stand-in.
  // Never set in production; intentionally undocumented outside test code.
  const extraToolCount = Number(process.env.GENIE_TEST_EXTRA_TOOLS ?? "0");
  if (Number.isFinite(extraToolCount) && extraToolCount > 0) {
    for (let i = 0; i < extraToolCount; i++) {
      server.registerTool(
        `dummy_tool_${i}`,
        { title: `Dummy ${i}`, description: "Harness smoke-test filler tool.", inputSchema: {} },
        () => ({ content: [{ type: "text", text: "dummy" }] }),
      );
    }
  }
  await startTransport(server, {
    kind: transportKind,
    port: args.port,
    host,
    ...(transportKind === "http"
      ? { serverFactory: createConfiguredServer, requireBearerAuth }
      : {}),
  });
}

main().catch((err: unknown) => {
  if (logger) {
    logger.fatal({ err }, "genie fatal");
  } else {
    process.stderr.write(`genie: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
});
