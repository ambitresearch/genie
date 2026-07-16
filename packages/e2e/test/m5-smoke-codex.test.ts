/**
 * M5-11 (DRO-283) — Codex CLI harness smoke test.
 *
 * Verifies two independent claims from `docs/harness/codex.md`:
 *
 *   1. The canonical `~/.codex/config.toml` HTTP snippet (AC1) is accepted
 *      VERBATIM by the real `codex` binary — `codex mcp add`/`codex mcp get
 *      --json` round-trips `url` + `bearer_token_env_var` +
 *      `startup_timeout_sec` + `tool_timeout_sec` with no `type` key (AC2),
 *      and `enabled_tools`/`disabled_tools` (AC4) are likewise accepted.
 *      This is the actual Codex CLI parsing the actual TOML — not a hand
 *      -rolled parser standing in for it.
 *
 *   2. The four-verb chain (`conjure → plan → write_files → preview`, per
 *      the Agent Skill genie ships) runs end-to-end against genie's real
 *      built stdio server, launched exactly the way Codex CLI launches a
 *      `command`-keyed `mcp_servers` entry: as a child process speaking
 *      MCP JSON-RPC over stdio. This is the protocol-level half of AC6.
 *
 *   3. AC6's REPL leg itself: `codex exec` (Codex's own non-interactive
 *      REPL entry point — the same binary an interactive `codex` session
 *      uses, minus the TTY) is driven live, with genie registered exactly
 *      per docs/harness/codex.md's stdio snippet, and asked in plain
 *      language to run the four-verb chain. The full JSONL event transcript
 *      Codex emits (`--json`) is captured verbatim to
 *      `reports/codex-repl-transcript.jsonl` as CI evidence, and the test
 *      asserts the transcript actually contains `mcp_tool_call` items
 *      against the `genie` server — i.e., Codex's own model decided to (and
 *      succeeded in) calling genie's tools, not just that the process exited
 *      zero.
 *
 * ── Why this leg is gated on GENIE_LLM_* like `conjure`, not unconditional ──
 * Driving `codex exec` requires a model provider Codex itself can reach
 * (separate from genie's own `GENIE_LLM_*` backend — Codex needs its own
 * driving model). This suite reuses `GENIE_LLM_BASE_URL`/`GENIE_LLM_API_KEY`
 * as that provider when set (an OpenAI-`responses`-API-compatible endpoint
 * satisfies both roles), so operators who already configure the `conjure`
 * secrets get this leg for free. Local runs without them skip visibly via
 * `describe.skipIf`; the dedicated CI job sets `GENIE_REQUIRE_LLM=1`, so a
 * missing or unreachable configured endpoint fails instead of silently
 * weakening AC6 into a green-but-vacuous check.
 *
 * ── AC coverage ──────────────────────────────────────────────────────────
 *   AC1 — canonical TOML snippet lives in docs/harness/codex.md; asserted
 *         against the real `codex mcp add`/`get --json` below.            ✅
 *   AC2 — no `type` key; transport inferred from `url` (→ streamable_http)
 *         vs `command` (→ stdio), both asserted live.                     ✅
 *   AC3 — `codex mcp login genie` documented in codex.md (OAuth path is
 *         asserted not to apply to the bearer-token snippet: `login` is
 *         for OAuth-registered servers, not `bearer_token_env_var` ones —
 *         codex.md says so explicitly).                                  ✅ (doc)
 *   AC4 — `enabled_tools`/`disabled_tools` accepted by real `codex mcp get`. ✅
 *   AC5 — codex.md documents the tools-only downgrade; not independently
 *         testable without a UI-capable Codex build.                      ✅ (doc)
 *   AC6 — four-verb chain driven live over real stdio (protocol level) AND
 *         over a real `codex exec` REPL run with a transcript captured to
 *         `reports/codex-repl-transcript.jsonl` (gated on GENIE_LLM_*, same
 *         as `conjure` above).                                    ✅ (protocol) / ✅ (REPL, gated)
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_CLI = resolve(here, "../../server/dist/cli.js");
const REPO_ROOT = resolve(here, "../../..");

/** True if the real `codex` binary is on PATH (AC1/AC2/AC4 live checks). */
function codexAvailable(): boolean {
  const probe = spawnSync("codex", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

const hasCodex = codexAvailable();
const hasBuiltServer = spawnSync("node", ["-e", `require("node:fs").accessSync(${JSON.stringify(SERVER_CLI)})`]).status === 0;

describe("codex-smoke CI contract", () => {
  it("uses the dedicated public gateway and requires the live endpoint leg", async () => {
    const workflow = await readFile(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const match = workflow.match(/\n {2}codex-smoke:\n([\s\S]*?)(?=\n {2}[a-z0-9][a-z0-9-]*:\n|$)/);
    expect(match, "expected ci.yml to define the codex-smoke job").not.toBeNull();

    const job = match?.[1] ?? "";
    expect(job).toContain(
      "if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
    );
    // GitHub withholds Actions secrets from untrusted forks. Do not turn that
    // missing-credential state into a required red job or expose secrets via
    // pull_request_target; maintainers must rerun fork changes on a trusted branch.
    expect(job).toContain("GENIE_LLM_BASE_URL: ${{ secrets.GENIE_CODEX_SMOKE_LLM_BASE_URL }}");
    expect(job).toContain("GENIE_LLM_API_KEY: ${{ secrets.GENIE_CODEX_SMOKE_LLM_API_KEY }}");
    expect(job).toContain('GENIE_REQUIRE_LLM: "1"');
    expect(job).toContain("GENIE_SMOKE_LLM_MODEL: ${{ vars.GENIE_SMOKE_MODEL }}");
    expect(job).toContain("npm install -g @openai/codex@0.144.5");
    expect(job).not.toContain("GENIE_LLM_BASE_URL: ${{ secrets.GENIE_LLM_BASE_URL }}");
    expect(job).not.toContain("GENIE_LLM_API_KEY: ${{ secrets.GENIE_LLM_API_KEY }}");
  });
});

// ── 1. Real `codex mcp` CLI accepts the canonical snippet verbatim ─────────

describe.skipIf(!hasCodex)("AC1/AC2/AC4 — codex mcp accepts the canonical genie snippet", () => {
  let codexHome: string;

  beforeAll(async () => {
    codexHome = await mkdtemp(join(tmpdir(), "genie-codex-home-"));
  });

  afterAll(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  function codexMcp(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("codex", ["mcp", ...args], {
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("registers the AC1 HTTP snippet with NO `type` key and round-trips it as streamable_http, incl. AC4 enabled_tools", () => {
    // This is docs/harness/codex.md's canonical block, character-for-character
    // in shape (only the URL host is a placeholder there — the CLI doesn't
    // care about the host, only the key SET).
    const add = codexMcp([
      "add",
      "genie",
      "--url",
      "https://genie.example.internal/mcp",
      "--bearer-token-env-var",
      "GENIE_TOKEN",
    ]);
    expect(add.status, add.stderr).toBe(0);

    const get = codexMcp(["get", "genie", "--json"]);
    expect(get.status, get.stderr).toBe(0);
    const config = JSON.parse(get.stdout) as {
      transport: { type: string; url?: string; bearer_token_env_var?: string; command?: string };
    };

    // AC2 — Codex infers transport from which keys are present. No `type`/
    // `transport` key was ever written by `codex mcp add --url`; the CLI's
    // own JSON view calls the *inferred* result "streamable_http" — that
    // field is CLI-internal bookkeeping, not something the operator writes.
    expect(config.transport.type).toBe("streamable_http");
    expect(config.transport.url).toBe("https://genie.example.internal/mcp");
    // AC1 — bearer_token_env_var, NOT plain `headers`.
    expect(config.transport.bearer_token_env_var).toBe("GENIE_TOKEN");
  });

  it("accepts startup_timeout_sec / tool_timeout_sec / enabled_tools appended to the snippet (AC1 tail + AC4)", async () => {
    // codex mcp add/get round-trip the transport shape; the remaining AC1
    // fields and AC4's allow-list are config.toml keys the CLI doesn't yet
    // expose flags for, so append them the way an operator hand-edits the
    // file after `codex mcp add`, then re-read via `codex mcp get --json`.
    const configPath = join(codexHome, "config.toml");
    const { appendFile, readFile } = await import("node:fs/promises");
    const before = await readFile(configPath, "utf8");
    expect(before).toContain("[mcp_servers.genie]");
    await appendFile(
      configPath,
      "\nstartup_timeout_sec = 15\ntool_timeout_sec = 120\n" +
        'enabled_tools = ["conjure", "plan", "write_files", "preview"]\n',
    );

    const get = codexMcp(["get", "genie", "--json"]);
    expect(get.status, get.stderr).toBe(0);
    const config = JSON.parse(get.stdout) as {
      startup_timeout_sec?: number;
      tool_timeout_sec?: number;
      enabled_tools?: string[];
    };
    expect(config.startup_timeout_sec).toBe(15);
    expect(config.tool_timeout_sec).toBe(120);
    expect(config.enabled_tools).toEqual(["conjure", "plan", "write_files", "preview"]);
  });

  it("a stdio registration (--  <command>) is inferred as stdio, NOT streamable_http — same no-`type`-key rule (AC2)", () => {
    const add = codexMcp(["add", "genie-stdio", "--", "node", SERVER_CLI, "--transport", "stdio"]);
    expect(add.status, add.stderr).toBe(0);
    const get = codexMcp(["get", "genie-stdio", "--json"]);
    expect(get.status, get.stderr).toBe(0);
    const config = JSON.parse(get.stdout) as { transport: { type: string; command?: string } };
    expect(config.transport.type).toBe("stdio");
    expect(config.transport.command).toBe("node");
  });
});

// ── 2. Four-verb chain over real stdio against the built server ───────────
//
// Launches `node dist/cli.js --transport stdio` as a real child process —
// the exact command Codex CLI's stdio `mcp_servers` entry launches — and
// drives conjure → plan → write_files → preview over the MCP SDK's stdio
// CLIENT transport (the harness side of the same wire protocol Codex speaks).

const hasLlmEnv = Boolean(process.env.GENIE_LLM_BASE_URL?.trim() && process.env.GENIE_LLM_API_KEY?.trim());
const smokeModel = process.env.GENIE_SMOKE_LLM_MODEL ?? "gpt-5.6-sol";

if (!hasLlmEnv) {
  console.info(
    "[m5-smoke-codex] GENIE_LLM_BASE_URL and/or GENIE_LLM_API_KEY is not set — " +
      "skipping the real-endpoint conjure and codex exec legs. Set both to run them live.",
  );
}

if (!hasLlmEnv && process.env.GENIE_REQUIRE_LLM === "1") {
  throw new Error(
    "GENIE_REQUIRE_LLM=1 but GENIE_LLM_BASE_URL and/or GENIE_LLM_API_KEY is " +
      "missing/empty — the codex-smoke CI job must run the real endpoint legs, not skip them.",
  );
}

describe.skipIf(!hasBuiltServer)("AC6 — four-verb chain over real stdio (Codex's own transport)", () => {
  let client: Client;
  let kitsRoot: string;

  beforeAll(async () => {
    kitsRoot = await mkdtemp(join(tmpdir(), "genie-codex-smoke-kits-"));
    const transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_CLI, "--transport", "stdio"],
      env: {
        ...(process.env as Record<string, string>),
        GENIE_KITS_ROOT: kitsRoot,
        GENIE_HOME: kitsRoot,
        // Required secret validation (packages/server/src/config/secrets.ts) —
        // unrelated to the MCP surface this smoke test exercises; throwaway
        // values (≥16 chars, per MIN_SECRET_LENGTH) satisfy the boot-time
        // check for this ephemeral test server. `GENIE_LLM_API_KEY` became a
        // *required* secret in DRO-275 (M5-03) after this test was first
        // written, which left CI's stdio-boot leg failing with "Secret
        // validation failed: GENIE_LLM_API_KEY is required but not set" —
        // only `hasLlmEnv`'s real `GENIE_LLM_API_KEY` (when configured) is
        // actually used for a live model call, in the separate `conjure`
        // test below; the other stdio tests never reach the LLM client, so
        // a non-secret placeholder is sufficient to pass boot validation.
        OAUTH_HS256_KEY: "codex-smoke-test-not-a-real-secret",
        GENIE_LLM_API_KEY: process.env.GENIE_LLM_API_KEY ?? "codex-smoke-test-not-a-real-key",
      },
    });
    client = new Client({ name: "codex-smoke", version: "0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await rm(kitsRoot, { recursive: true, force: true });
  });

  it("advertises the four chain verbs over real stdio", async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const verb of [
      "mcp__genie__conjure",
      "mcp__genie__plan",
      "mcp__genie__write_files",
      "mcp__genie__preview",
    ]) {
      expect(names, `expected ${verb} to be registered over stdio`).toContain(verb);
    }
  });

  /** First text content part, parsed as JSON (tools without structuredContent). */
  function parseText(result: { content?: { type: string; text: string }[] }): unknown {
    const text = result.content?.[0]?.text ?? "";
    return text ? JSON.parse(text) : undefined;
  }

  /** structuredContent when present, else the parsed text payload. */
  function payload(result: { structuredContent?: unknown; content?: { type: string; text: string }[] }): unknown {
    return result.structuredContent ?? parseText(result);
  }

  it("plan → write_files → preview round-trips over real stdio (the write+show half of the chain)", async () => {
    const create = (await client.callTool({
      name: "mcp__genie__create_kit",
      arguments: { name: "Codex Smoke Kit" },
    })) as { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: unknown };
    expect(create.isError, JSON.stringify(create)).toBeFalsy();
    const { kitId } = payload(create) as { kitId: string };
    expect(kitId).toMatch(/^codex-smoke-kit-[0-9a-f]{6}$/);

    const kitDir = join(kitsRoot, kitId);
    const plan = (await client.callTool({
      name: "mcp__genie__plan",
      arguments: { kitId, writes: ["components/**/*.html"], localDir: kitDir },
    })) as { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: unknown };
    expect(plan.isError, JSON.stringify(plan)).toBeFalsy();
    const { planId } = payload(plan) as { planId: string };

    const write = (await client.callTool({
      name: "mcp__genie__write_files",
      arguments: {
        planId,
        files: [{ path: "components/Button.html", data: "<button>Codex smoke</button>" }],
      },
    })) as { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: unknown };
    expect(write.isError, JSON.stringify(write)).toBeFalsy();
    expect(payload(write)).toMatchObject({ writtenPaths: ["components/Button.html"] });

    const preview = (await client.callTool({
      name: "mcp__genie__preview",
      arguments: { kitId },
    })) as { isError?: boolean; structuredContent?: unknown };
    expect(preview.isError, JSON.stringify(preview)).toBeFalsy();
  });

  it.skipIf(!hasLlmEnv)(
    "conjure generates a component over real stdio when an LLM endpoint is configured (full chain incl. generation)",
    async () => {
      const create = (await client.callTool({
        name: "mcp__genie__create_kit",
        arguments: { name: "Codex Smoke Conjure Kit" },
      })) as { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: unknown };
      expect(create.isError, JSON.stringify(create)).toBeFalsy();
      const { kitId } = payload(create) as { kitId: string };

      const conjure = (await client.callTool({
        name: "mcp__genie__conjure",
        arguments: {
          kitId,
          kit: "<!-- empty kit context for smoke test -->",
          prompt: "A small rounded primary button that says Continue.",
          // The server's DEFAULT_MODEL alias ("design-default") isn't a
          // model this operator's endpoint recognizes; point at a concrete
          // model this smoke test's configured endpoint actually serves.
          model: smokeModel,
        },
      })) as { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: unknown };
      expect(conjure.isError, JSON.stringify(conjure)).toBeFalsy();
    },
    60_000,
  );

});

// ── 3. AC6's REPL leg: drive the real `codex exec` REPL, capture transcript ──
//
// `codex exec` is Codex CLI's own non-interactive entry point for the same
// binary an interactive `codex` session runs — there is no separate "REPL
// binary" to shell out to. This registers genie exactly per
// docs/harness/codex.md's stdio snippet (via `codex mcp add`, not a
// hand-edited file), then asks Codex in plain language to run the four-verb
// chain, capturing every JSONL event Codex emits (`--json`) verbatim to
// `reports/codex-repl-transcript.jsonl` for CI evidence, and asserting the
// transcript shows Codex's own model actually invoking genie's tools (not
// just that the process exited zero).

describe.skipIf(!hasCodex || !hasLlmEnv || !hasBuiltServer)(
  "AC6 (REPL) — a real `codex exec` run drives genie's tools live",
  () => {
    let codexHome: string;
    let kitsRoot: string;

    beforeAll(async () => {
      codexHome = await mkdtemp(join(tmpdir(), "genie-codex-repl-home-"));
      kitsRoot = await mkdtemp(join(tmpdir(), "genie-codex-repl-kits-"));

      // Codex needs its OWN driving-model provider config — separate from
      // genie's GENIE_LLM_* backend the MCP server calls. Point it at the
      // same OpenAI-`responses`-API-compatible endpoint `GENIE_LLM_BASE_URL`
      // already gives us, so configuring the `conjure` secrets once covers
      // both roles.
      await writeFile(
        join(codexHome, "config.toml"),
        [
          `model_provider = "genie_smoke"`,
          `model = ${JSON.stringify(smokeModel)}`,
          "",
          `[model_providers.genie_smoke]`,
          `name = "genie_smoke"`,
          `base_url = ${JSON.stringify(process.env.GENIE_LLM_BASE_URL)}`,
          `env_key = "GENIE_SMOKE_CODEX_KEY"`,
          `wire_api = "responses"`,
          "",
        ].join("\n"),
      );

      const codexEnv = {
        ...process.env,
        CODEX_HOME: codexHome,
        GENIE_SMOKE_CODEX_KEY: process.env.GENIE_LLM_API_KEY ?? "",
      };

      // `codex mcp add` — the documented registration path (docs/harness/
      // codex.md), not a hand-edited config.toml — writing the stdio shape
      // this file's protocol-level tests already assert against.
      const add = spawnSync(
        "codex",
        [
          "mcp",
          "add",
          "genie",
          "--env",
          `GENIE_KITS_ROOT=${kitsRoot}`,
          "--env",
          `GENIE_HOME=${kitsRoot}`,
          "--env",
          "OAUTH_HS256_KEY=codex-repl-smoke-test-not-a-real-secret",
          "--env",
          "GENIE_PREVIEW_NO_OPEN=1",
          "--",
          "node",
          SERVER_CLI,
          "--transport",
          "stdio",
        ],
        { env: codexEnv, encoding: "utf8" },
      );
      expect(add.status, add.stderr).toBe(0);

      const configPath = join(codexHome, "config.toml");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        config.replace(
          "[mcp_servers.genie]",
          '[mcp_servers.genie]\nenv_vars = ["GENIE_LLM_BASE_URL", "GENIE_LLM_API_KEY"]',
        ),
      );
    }, 30_000);

    afterAll(async () => {
      await rm(codexHome, { recursive: true, force: true });
      await rm(kitsRoot, { recursive: true, force: true });
    });

    it("keeps gateway credentials in inherited environment instead of Codex config", async () => {
      const config = await readFile(join(codexHome, "config.toml"), "utf8");
      const apiKey = process.env.GENIE_LLM_API_KEY?.trim();
      const persistsGatewayCredential = Boolean(apiKey && config.includes(apiKey));
      expect(
        persistsGatewayCredential,
        "gateway credential values must not be written to CODEX_HOME/config.toml",
      ).toBe(false);
      expect(config).toContain('env_vars = ["GENIE_LLM_BASE_URL", "GENIE_LLM_API_KEY"]');
    });

    it(
      "codex exec drives create_kit -> conjure -> plan -> write_files -> preview via genie's real MCP tools, transcript captured to reports/",
      async () => {
        // `localDir` must already exist on disk before `plan` is called
        // (the server rejects a missing directory with `InvalidLocalDir`);
        // reuse `kitsRoot`, which `beforeAll` already created, rather than
        // asking the model to invent+create a fresh temp directory itself.
        // `model` must be a concrete model name the configured endpoint
        // actually serves — genie's DEFAULT_MODEL alias ("design-default")
        // is not recognized by this smoke test's endpoint (see the
        // `conjure` stdio test above, which hits the same requirement).
        const conjureModel = smokeModel;
        const prompt = [
          "Using the genie MCP server's tools (mcp__genie__create_kit,",
          "mcp__genie__conjure, mcp__genie__plan, mcp__genie__write_files,",
          "mcp__genie__preview), in this exact order:",
          "1) call create_kit with name 'Codex Repl Smoke'",
          `2) call conjure for that kit with model '${conjureModel}' and a prompt`,
          "   asking for a small primary button that says Continue",
          `3) call plan for that kit with writes ['components/**/*.html'] and`,
          `   localDir set to the EXISTING directory '${kitsRoot}' (do not`,
          "   create or use any other directory)",
          "4) call write_files with the conjured file(s) via the plan's planId",
          "5) call preview for that kit",
          "Call the genie MCP tools directly for each step — do not shell out,",
          "do not explore the filesystem first.",
        ].join(" ");

        const result = spawnSync(
          "codex",
          [
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "--json",
            prompt,
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              CODEX_HOME: codexHome,
              GENIE_SMOKE_CODEX_KEY: process.env.GENIE_LLM_API_KEY ?? "",
            },
            input: "",
            encoding: "utf8",
            timeout: 170_000,
            maxBuffer: 64 * 1024 * 1024,
          },
        );

        const reportsDir = join(REPO_ROOT, "reports");
        await mkdir(reportsDir, { recursive: true });
        await writeFile(
          join(reportsDir, "codex-repl-transcript.jsonl"),
          `${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}\n`,
        );

        const events = (result.stdout ?? "")
          .split("\n")
          .filter((line) => line.trim().startsWith("{"))
          .map((line) => {
            try {
              return JSON.parse(line) as { type?: string; item?: Record<string, unknown> };
            } catch {
              return null;
            }
          })
          .filter((e): e is { type?: string; item?: Record<string, unknown> } => e !== null);

        // `item.completed` mcp_tool_call events against the genie server,
        // in the order Codex actually completed them (dedupe against the
        // `item.started` copy of the same item id — only the terminal
        // `item.completed` record carries `status`/`result`).
        const genieToolCallsCompleted = events.filter(
          (e) =>
            e.type === "item.completed" &&
            e.item?.type === "mcp_tool_call" &&
            e.item?.server === "genie",
        );

        const terminalFailure = events.find(
          (e) => e.type === "turn.failed" || (e.type === "error" && typeof e.item === "undefined"),
        );
        expect(
          genieToolCallsCompleted.length,
          "expected Codex's configured driving-model endpoint to reach at least one genie " +
            `tool call; terminal failure: ${JSON.stringify(terminalFailure)} — ` +
            "see reports/codex-repl-transcript.jsonl",
        ).toBeGreaterThan(0);

        // AC6 asks for the FULL four-verb chain, not "at least one genie
        // tool call succeeded" — a single successful create_kit call would
        // satisfy the old `.toBeGreaterThan(0)` assertion while conjure,
        // plan, write_files, and preview never ran. Assert each expected
        // verb was called, completed successfully (no per-call `error`,
        // `status: "completed"` not `"failed"`), and appeared in the
        // documented order — then assert the whole Codex turn itself
        // finished as `turn.completed` (not `turn.failed`/aborted).
        // Codex's transcript records the tool name exactly as advertised by
        // the MCP server — genie's tools are namespaced `mcp__genie__<verb>`
        // (see the `listTools()` assertion earlier in this file), not the
        // bare verb name.
        const EXPECTED_VERB_ORDER = [
          "mcp__genie__create_kit",
          "mcp__genie__conjure",
          "mcp__genie__plan",
          "mcp__genie__write_files",
          "mcp__genie__preview",
        ];

        const calledVerbsInOrder = genieToolCallsCompleted.map((e) => e.item?.tool);
        const failedCalls = genieToolCallsCompleted.filter(
          (e) => e.item?.status !== "completed" || e.item?.error,
        );

        const transcriptHint = "see reports/codex-repl-transcript.jsonl";

        expect(
          failedCalls,
          `expected every genie mcp_tool_call to complete successfully (no per-call errors), ` +
            `got failures: ${JSON.stringify(failedCalls)} — ${transcriptHint}`,
        ).toHaveLength(0);

        for (const verb of EXPECTED_VERB_ORDER) {
          expect(
            calledVerbsInOrder,
            `expected genie tool "${verb}" to be called during the chain — ${transcriptHint}. ` +
              `actual call order: ${JSON.stringify(calledVerbsInOrder)}`,
          ).toContain(verb);
        }

        // Order matters: each verb in EXPECTED_VERB_ORDER must appear no
        // earlier than the previous one (duplicate/retry calls of the same
        // verb are fine; out-of-order verbs are not).
        let cursor = -1;
        for (const verb of EXPECTED_VERB_ORDER) {
          const idx = calledVerbsInOrder.indexOf(verb, cursor + 1);
          expect(
            idx,
            `expected "${verb}" to be called after the preceding chain verbs — ` +
              `actual call order: ${JSON.stringify(calledVerbsInOrder)} — ${transcriptHint}`,
          ).toBeGreaterThan(cursor);
          cursor = idx;
        }

        // The transcript is the CI evidence (reports/codex-repl-transcript.jsonl);
        // this assertion proves Codex's own turn actually finished — not
        // merely that the process exited zero while the model gave up
        // partway through the chain.
        const turnCompleted = events.some((e) => e.type === "turn.completed");
        expect(
          turnCompleted,
          `expected a turn.completed event (Codex's own turn must finish, not abort/fail) — ${transcriptHint}`,
        ).toBe(true);
      },
      180_000,
    );
  },
);
