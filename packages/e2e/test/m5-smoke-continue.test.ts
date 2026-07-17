/**
 * M5-15 (DRO-287) - Continue.dev harness smoke test.
 *
 * AC1/AC3/AC4 parse the canonical config and pin its documented behavior.
 * AC2's original "type is required" premise is stale: Continue CLI 1.5.47
 * accepts command- and URL-keyed entries without it. The snippets still set an
 * explicit type for clarity, while this suite asserts the honest optionality.
 *
 * AC5 runs the published `cn -p` agent, not a generic MCP client. Continue
 * loads a temp config containing genie's documented stdio registration and a
 * deterministic local OpenAI-compatible model. That model issues the complete
 * create_kit -> conjure -> plan -> write_files -> preview sequence through
 * Continue's own agent loop. Genie's conjure call uses a separate local model
 * response, and its generated file is carried unchanged into plan/write_files.
 * The final response quotes preview's plain-text fallback; no Continue IDE
 * rendering claim is made because `cn` is a separate, headless surface whose
 * MCP client initializes with no UI capability.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yaml from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_CLI = resolve(here, "../../server/dist/cli.js");
const CONTINUE_CLI = resolve(here, "../node_modules/@continuedev/cli/dist/cn.js");
const DOC_PATH = resolve(here, "../../../docs/harness/continue.md");

const hasBuiltServer =
  spawnSync(process.execPath, [
    "-e",
    `require("node:fs").accessSync(${JSON.stringify(SERVER_CLI)})`,
  ]).status === 0;
const hasContinueCli =
  spawnSync(process.execPath, [CONTINUE_CLI, "--version"], { encoding: "utf8" }).stdout.trim() ===
  "1.5.47";

if (process.env.GENIE_REQUIRE_CONTINUE === "1" && !hasBuiltServer) {
  throw new Error(
    "GENIE_REQUIRE_CONTINUE=1 but packages/server/dist/cli.js is missing; " +
      "test:e2e:continue must build @genie/viewer and @genie/server before Vitest.",
  );
}
if (process.env.GENIE_REQUIRE_CONTINUE === "1" && !hasContinueCli) {
  throw new Error(
    "GENIE_REQUIRE_CONTINUE=1 but @continuedev/cli@1.5.47 is unavailable; " +
      "install dependencies before running the Continue smoke.",
  );
}

interface ContinueConfig {
  name: string;
  version: string;
  schema: string;
  mcpServers: Array<{
    name: string;
    type?: "stdio" | "sse" | "streamable-http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    requestOptions?: { headers?: Record<string, string> };
  }>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

interface ChatRequest {
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}

interface RecordedRequest {
  body: ChatRequest;
  toolNames: string[];
}

/** Extract fenced yaml blocks from the markdown doc, in document order. */
function extractYamlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

function findToolResult(messages: ChatMessage[], callId: string): string {
  const result = messages.find(
    (message) => message.role === "tool" && message.tool_call_id === callId,
  );
  if (typeof result?.content !== "string") {
    throw new Error(`Continue did not return a tool result for ${callId}`);
  }
  return result.content;
}

function parseMcpContent(content: string): unknown {
  const parts = JSON.parse(content) as Array<{ type?: string; text?: string }>;
  const text = parts.find((part) => part.type === "text")?.text;
  if (!text) throw new Error(`Expected MCP text content, got ${content}`);
  return JSON.parse(text);
}

function sendSse(
  response: import("node:http").ServerResponse,
  delta: Record<string, unknown>,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function sendChatCompletion(response: import("node:http").ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chatcmpl-continue-smoke",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "continue-smoke-model",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  );
}

function toolCallDelta(id: string, name: string, args: Record<string, unknown>) {
  return {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

async function listen(server: Server): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind deterministic Continue model server"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
    server.closeAllConnections?.();
  });
}

function isolatedContinueEnv(
  source: NodeJS.ProcessEnv,
  home: string,
  continueHome: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const excluded = new Set([
    "GENIE_LLM_API_KEY",
    "GENIE_LLM_BASE_URL",
    "GENIE_PREVIEWS_BASE_URL",
    "OAUTH_HS256_KEY",
  ]);
  for (const [name, value] of Object.entries(source)) {
    const normalizedName = name.toUpperCase();
    if (
      value === undefined ||
      normalizedName.startsWith("CONTINUE_") ||
      excluded.has(normalizedName)
    ) {
      continue;
    }
    env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CONTINUE_GLOBAL_DIR: continueHome,
    CONTINUE_METRICS_ENABLED: "0",
    CONTINUE_CLI_ENABLE_TELEMETRY: "0",
    FORCE_NO_TTY: "true",
    CI: "true",
  };
}

it("isolates Continue state and inherited credentials across platforms", () => {
  const env = isolatedContinueEnv(
    {
      PATH: "/bin",
      Continue_Global_Dir: "/real/continue",
      continue_api_key: "real-continue-key",
      Genie_Llm_Api_Key: "real-genie-key",
      genie_previews_base_url: "https://previews.example.test",
    },
    "/tmp/home",
    "/tmp/continue",
  );

  expect(env).toMatchObject({
    PATH: "/bin",
    HOME: "/tmp/home",
    USERPROFILE: "/tmp/home",
    CONTINUE_GLOBAL_DIR: "/tmp/continue",
    CONTINUE_METRICS_ENABLED: "0",
  });
  expect(env).not.toHaveProperty("Continue_Global_Dir");
  expect(env).not.toHaveProperty("continue_api_key");
  expect(env).not.toHaveProperty("Genie_Llm_Api_Key");
  expect(env).not.toHaveProperty("genie_previews_base_url");
});

async function runContinue(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return await new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [CONTINUE_CLI, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

describe("AC1/AC2/AC3/AC4 - Continue's documented configuration", () => {
  let markdown: string;
  let configs: ContinueConfig[];

  beforeAll(async () => {
    markdown = await readFile(DOC_PATH, "utf8");
    configs = extractYamlBlocks(markdown).map((block) => yaml.parse(block) as ContinueConfig);
  });

  it("keeps explicit transport types in the canonical HTTP and stdio snippets", () => {
    const http = configs.find((config) => config.mcpServers[0]?.url)?.mcpServers[0];
    const stdio = configs.find((config) => config.mcpServers[0]?.command)?.mcpServers[0];

    expect(http).toMatchObject({
      name: "genie",
      type: "streamable-http",
      url: "https://genie.<operator-domain>/mcp",
    });
    expect(http?.requestOptions?.headers?.Authorization).toBe("Bearer ${{ secrets.GENIE_TOKEN }}");
    expect(stdio).toMatchObject({
      name: "genie",
      type: "stdio",
      command: "node",
      args: ["/absolute/path/to/genie/packages/server/dist/cli.js", "--transport", "stdio"],
    });
    expect(stdio?.env?.GENIE_LLM_API_KEY).toBe("${{ secrets.GENIE_LLM_API_KEY }}");
  });

  it("states that type is optional in current Continue and MCP is agent-mode only", () => {
    expect(markdown).toMatch(/`type` is optional/i);
    expect(markdown).not.toMatch(/type.{0,40}(required|mandatory)/i);
    expect(markdown).toMatch(/MCP can only be used in agent mode/i);
  });

  it("documents current Continue CLI and IDE Agent Skills support", () => {
    expect(markdown).toContain("~/.continue/skills/genie");
    expect(markdown).toContain("core/config/markdown/loadMarkdownSkills.ts");
    expect(markdown).not.toMatch(/no (documented )?Agent Skills loader/i);
  });

  it("distinguishes Continue IDE's MCP App renderer from text-only cn", () => {
    expect(markdown).toMatch(/Current Continue IDE source.{0,180}MCP App\s+renderer/is);
    expect(markdown).toMatch(/published\s+Continue CLI 1\.5\.47.{0,160}without the MCP Apps UI/is);
  });
});

describe.skipIf(!hasBuiltServer || !hasContinueCli)(
  "AC5 - real Continue CLI headless agent smoke",
  () => {
    let tempRoot: string;
    let continueHome: string;
    let kitsRoot: string;
    let configPath: string;
    let configWithoutTypePath: string;
    let modelServer: Server;
    let modelPort: number;
    let requests: RecordedRequest[];
    let expectedFile: string;
    let expectedFilePath: string;
    let observedPreviewText: string;
    let continueEnv: NodeJS.ProcessEnv;

    beforeAll(async () => {
      tempRoot = await mkdtemp(join(tmpdir(), "genie-continue-smoke-"));
      continueHome = join(tempRoot, "continue-home");
      kitsRoot = join(tempRoot, "kits");
      configPath = join(tempRoot, "continue.yaml");
      configWithoutTypePath = join(tempRoot, "continue-without-type.yaml");
      expectedFilePath = "components/actions/Button/Button.html";
      expectedFile =
        '<!-- @genie group="actions" viewport="320x140" -->\n' +
        "<!doctype html><button>Continue smoke</button>";
      observedPreviewText = "";
      requests = [];
      continueEnv = isolatedContinueEnv(process.env, tempRoot, continueHome);
      await mkdir(continueHome, { recursive: true });
      await mkdir(kitsRoot, { recursive: true });

      modelServer = createServer((request, response) => {
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          raw += chunk;
        });
        request.on("end", () => {
          if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(404).end();
            return;
          }

          const body = JSON.parse(raw) as ChatRequest;
          const messages = body.messages ?? [];
          const toolNames = (body.tools ?? [])
            .map((tool) => tool.function?.name)
            .filter((name): name is string => Boolean(name));
          requests.push({ body, toolNames });

          const isTypeProbe = messages.some(
            (message) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.includes("CONTINUE_TYPE_OPTIONAL_PROBE"),
          );
          if (isTypeProbe) {
            sendSse(response, { content: "CONTINUE_TYPE_OPTIONAL_OK" });
            return;
          }

          // Genie's own conjure request has response_format but no tools.
          if (toolNames.length === 0) {
            sendChatCompletion(
              response,
              JSON.stringify({
                componentName: "Button",
                group: "actions",
                files: [{ path: expectedFilePath, content: expectedFile, mimeType: "text/html" }],
                manifestEntry: {
                  viewport: { width: 320, height: 140 },
                  subtitle: "Continue smoke",
                },
              }),
            );
            return;
          }

          const lastToolCall = [...messages]
            .reverse()
            .find((message) => message.role === "assistant" && message.tool_calls?.length)
            ?.tool_calls?.[0];
          const lastTool = lastToolCall?.function?.name;
          const lastCallId = lastToolCall ? messages.at(-1)?.tool_call_id : undefined;

          if (!lastTool) {
            sendSse(
              response,
              toolCallDelta("continue-create", "mcp__genie__create_kit", {
                name: "Continue Agent Smoke",
              }),
            );
            return;
          }

          if (lastTool === "mcp__genie__create_kit" && lastCallId === "continue-create") {
            const { kitId } = parseMcpContent(findToolResult(messages, "continue-create")) as {
              kitId: string;
            };
            sendSse(
              response,
              toolCallDelta("continue-conjure", "mcp__genie__conjure", {
                kitId,
                kit: "Minimal semantic HTML UI kit.",
                prompt: "A button that says Continue smoke.",
                model: "continue-smoke-model",
              }),
            );
            return;
          }

          if (lastTool === "mcp__genie__conjure" && lastCallId === "continue-conjure") {
            const conjured = parseMcpContent(findToolResult(messages, "continue-conjure")) as {
              files: Array<{ path: string; content: string; mimeType: string; encoding: string }>;
            };
            expect(conjured.files).toEqual([
              {
                path: expectedFilePath,
                content: expectedFile,
                mimeType: "text/html",
                encoding: "utf-8",
              },
            ]);
            const createArgs = JSON.parse(
              messages.find((message) =>
                message.tool_calls?.some(
                  (call) => call.function?.name === "mcp__genie__create_kit",
                ),
              )?.tool_calls?.[0]?.function?.arguments ?? "{}",
            ) as { name?: string };
            expect(createArgs.name).toBe("Continue Agent Smoke");
            const create = parseMcpContent(findToolResult(messages, "continue-create")) as {
              kitId: string;
            };
            sendSse(
              response,
              toolCallDelta("continue-plan", "mcp__genie__plan", {
                kitId: create.kitId,
                writes: conjured.files.map((file) => file.path),
                deletes: [],
                localDir: join(kitsRoot, create.kitId),
              }),
            );
            return;
          }

          if (lastTool === "mcp__genie__plan" && lastCallId === "continue-plan") {
            const { planId } = parseMcpContent(findToolResult(messages, "continue-plan")) as {
              planId: string;
            };
            const conjured = parseMcpContent(findToolResult(messages, "continue-conjure")) as {
              files: Array<{ path: string; content: string; mimeType: string; encoding: string }>;
            };
            sendSse(
              response,
              toolCallDelta("continue-write", "mcp__genie__write_files", {
                planId,
                files: conjured.files.map(({ path, content, mimeType, encoding }) => ({
                  path,
                  data: content,
                  mimeType,
                  encoding,
                })),
              }),
            );
            return;
          }

          if (lastTool === "mcp__genie__write_files" && lastCallId === "continue-write") {
            const create = parseMcpContent(findToolResult(messages, "continue-create")) as {
              kitId: string;
            };
            sendSse(
              response,
              toolCallDelta("continue-preview", "mcp__genie__preview", {
                kitId: create.kitId,
              }),
            );
            return;
          }

          if (lastTool === "mcp__genie__preview" && lastCallId === "continue-preview") {
            const previewParts = JSON.parse(findToolResult(messages, "continue-preview")) as Array<{
              type?: string;
              text?: string;
            }>;
            const previewText = previewParts.find((part) => part.type === "text")?.text;
            if (!previewText) throw new Error("Continue did not receive preview's text content");
            expect(previewParts).toEqual([{ type: "text", text: previewText }]);
            observedPreviewText = previewText;
            sendSse(response, { content: `CONTINUE_SMOKE_COMPLETE\n${previewText}` });
            return;
          }

          response.writeHead(500).end(`Unexpected Continue tool state: ${lastTool}`);
        });
      });
      modelPort = await listen(modelServer);

      const markdown = await readFile(DOC_PATH, "utf8");
      const snippets = extractYamlBlocks(markdown).map(
        (block) => yaml.parse(block) as ContinueConfig,
      );
      const documentedStdio = snippets.find((config) => config.mcpServers[0]?.command)
        ?.mcpServers[0];
      if (!documentedStdio) throw new Error("Missing documented Continue stdio snippet");

      const config = {
        name: "genie-continue-smoke",
        version: "1.0.0",
        schema: "v1",
        models: [
          {
            name: "deterministic-continue-agent",
            provider: "openai",
            model: "continue-smoke-model",
            apiKey: "continue-smoke-not-a-real-key",
            apiBase: `http://127.0.0.1:${modelPort}/v1`,
            roles: ["chat"],
            capabilities: ["tool_use"],
            defaultCompletionOptions: { contextLength: 200000, maxTokens: 4096 },
          },
        ],
        mcpServers: [
          {
            ...documentedStdio,
            args: [SERVER_CLI, "--transport", "stdio"],
            env: {
              GENIE_KITS_ROOT: kitsRoot,
              GENIE_HOME: join(tempRoot, "genie-home"),
              GENIE_LLM_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
              GENIE_LLM_API_KEY: "continue-smoke-not-a-real-key",
              OAUTH_HS256_KEY: "continue-smoke-not-a-real-oauth-key",
              GENIE_PREVIEW_NO_OPEN: "1",
            },
          },
        ],
      };
      await writeFile(configPath, yaml.stringify(config));
      const withoutType = structuredClone(config);
      delete withoutType.mcpServers[0]?.type;
      await writeFile(configWithoutTypePath, yaml.stringify(withoutType));
    }, 30_000);

    afterAll(async () => {
      if (modelServer) await close(modelServer);
      if (tempRoot) {
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });

    it("cn -p infers stdio from command when the optional type key is omitted", async () => {
      const requestStart = requests.length;
      const result = await runContinue(
        [
          "-p",
          "--config",
          configWithoutTypePath,
          "CONTINUE_TYPE_OPTIONAL_PROBE: reply with the requested marker.",
        ],
        continueEnv,
        tempRoot,
      );

      expect(result.status, `signal=${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("CONTINUE_TYPE_OPTIONAL_OK");
      const probeRequest = requests
        .slice(requestStart)
        .find((request) => request.toolNames.includes("mcp__genie__conjure"));
      expect(probeRequest, "Continue did not load genie's tools without type").toBeDefined();
    }, 30_000);

    it("cn -p loads genie, executes generated output through plan/write_files/preview, and returns text", async () => {
      const result = await runContinue(
        [
          "-p",
          "--config",
          configPath,
          "--allow",
          "*",
          "Use the genie tools to create, conjure, plan, write, and preview a button.",
        ],
        continueEnv,
        tempRoot,
      );

      expect(result.status, `signal=${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("CONTINUE_SMOKE_COMPLETE");
      expect(observedPreviewText).toMatch(/Preview (ready|running|unavailable)/);
      expect(observedPreviewText).not.toContain("ui://");
      expect(result.stdout).toContain(observedPreviewText);

      const agentRequests = requests.filter((request) => request.toolNames.length > 0);
      const advertised = new Set(agentRequests.flatMap((request) => request.toolNames));
      for (const verb of [
        "mcp__genie__conjure",
        "mcp__genie__plan",
        "mcp__genie__write_files",
        "mcp__genie__preview",
      ]) {
        expect(advertised, `Continue did not expose ${verb} to its model`).toContain(verb);
      }

      const completedCalls = (agentRequests.at(-1)?.body.messages ?? [])
        .flatMap((message) => message.tool_calls ?? [])
        .map((call) => call.function?.name)
        .filter((name): name is string => Boolean(name));
      expect(completedCalls).toEqual([
        "mcp__genie__create_kit",
        "mcp__genie__conjure",
        "mcp__genie__plan",
        "mcp__genie__write_files",
        "mcp__genie__preview",
      ]);

      const kitDirs = await readdir(kitsRoot);
      expect(kitDirs).toHaveLength(1);
      const writtenPath = join(kitsRoot, kitDirs[0]!, expectedFilePath);
      await access(writtenPath);
      expect(await readFile(writtenPath, "utf8")).toBe(expectedFile);
    }, 190_000);
  },
);
