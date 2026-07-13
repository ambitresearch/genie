#!/usr/bin/env node
import { auditSecretNames, loadSecrets, SECRET_SPECS, SecretValidationError } from "./config/secrets.js";
import { createServer, SERVER_INFO } from "./server.js";
import { resolvePreviewLocality, resolveTransport, startTransport } from "./transport.js";

/** Minimal flag parser — no dependency needed for M0's tiny surface. */
function parseArgs(argv: string[]): {
  transport?: string;
  port?: number;
  host?: string;
  previewLocality?: string;
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
          throw new Error("--secrets-from requires a file path.");
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

Options:
  --transport <stdio|http>   Transport to use (default: auto-detect by TTY)
  --port <n>                 HTTP port (default: 3000)
  --host <addr>              HTTP host (default: 127.0.0.1)
  --preview-locality <mode>  Preview reachability: local or remote
  --secrets-from <path>      Merge KEY=value secrets from a mounted file
  -v, --version              Print version and exit
  -h, --help                 Show this help

Env:
  MCP_TRANSPORT              Same as --transport
  GENIE_PREVIEW_LOCALITY     Same as --preview-locality
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

  // AC6: merge a mounted secrets file into process.env, if given. AC2/AC3/AC4:
  // validate shape (length, no argv leak) of whatever secrets are present and
  // audit-log their names (never values). Deliberately *not* `required` here
  // for any individual secret — `GENIE_LLM_API_KEY` in particular is read
  // lazily by `tools/conjure.ts` specifically so that booting the server for
  // non-LLM tools (kit/file/project tools, validate, etc.) doesn't force an
  // LLM key to exist; making it a hard boot-time requirement here would
  // regress that documented lazy-init property. Every secret that *is*
  // present still gets the shape/leak checks (AC2), satisfying "no plaintext
  // at rest, no secret ever passed via a CLI flag" without narrowing what
  // genie can boot without.
  try {
    const secrets = await loadSecrets({
      secretsFromPath: args.secretsFrom,
      specs: SECRET_SPECS.map((spec) => ({ ...spec, required: false })),
    });
    const loaded = auditSecretNames(secrets);
    if (loaded.length > 0) {
      process.stderr.write(`genie: loaded secrets: ${loaded.join(", ")}\n`);
    }
  } catch (err) {
    if (err instanceof SecretValidationError) {
      process.stderr.write(`genie: fatal: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const transportKind = resolveTransport(args.transport);
  const host = args.host ?? "127.0.0.1";
  const previewLocality = resolvePreviewLocality(transportKind, args.previewLocality);
  const createConfiguredServer = () => createServer({ transportKind, previewLocality });
  const server = createConfiguredServer();
  await startTransport(server, {
    kind: transportKind,
    port: args.port,
    host,
    ...(transportKind === "http" ? { serverFactory: createConfiguredServer } : {}),
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`genie: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
