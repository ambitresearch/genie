import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const PLUGIN = resolve(ROOT, "packages/plugin");

describe("Claude plugin artifacts", () => {
  it("ships guidance only and does not claim a non-existent bundled MCP runtime", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(PLUGIN, ".claude-plugin/plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(String(manifest.description)).not.toContain("Bundles the genie MCP server");
  });

  it("exposes /genie:preview from commands/preview.md", () => {
    expect(existsSync(resolve(PLUGIN, "commands/preview.md"))).toBe(true);
    expect(existsSync(resolve(PLUGIN, "commands/genie-preview.md"))).toBe(false);
  });

  it("maps conjure file content to write_files data and preserves design-default", () => {
    const skill = readFileSync(resolve(PLUGIN, "skills/genie/SKILL.md"), "utf8");
    expect(skill).toContain("data: file.content");
    expect(skill).toContain("`design-default` is the valid default routing alias");
    expect(skill).not.toContain("the `design-default` alias is not a real endpoint");
    expect(skill).toContain("components/actions/GetStartedButton/GetStartedButton.html");
    expect(skill).not.toContain("components/actions/GetStartedButton/preview.html");
    expect(skill).toContain("does persist a timestamped validation report and metrics");
    expect(skill).not.toContain("No plan needed; nothing is written");
    expect(skill).toContain("## Refine: `refine → plan → write_files → preview`");
    expect(skill).toContain("refineResult.files.map");
    expect(skill).toContain("`refine` is pure with respect to kit files");
    expect(skill).toContain("encoding: file.encoding");
    expect(skill.match(/encoding: file\.encoding/g)).toHaveLength(2);
    expect(skill).toMatch(
      /`\{ path, content, mimeType, encoding \}` to\s+`\{ path, data: content, mimeType, encoding \}`/,
    );
    expect(skill).toMatch(/After\s+`delete_files`, call `preview`/);
    expect(skill).toContain("without negotiated UI support");
    expect(skill).not.toContain("**other host** (Codex, Copilot");
  });

  it("keeps local stdio registration scoped to hosts that can launch it", () => {
    const cursor = readFileSync(resolve(ROOT, "docs/harness/cursor.md"), "utf8");
    const claude = readFileSync(resolve(ROOT, "docs/harness/claude-code.md"), "utf8");

    expect(cursor).toContain("ChatGPT cannot launch a command from your local filesystem");
    expect(cursor).toContain("ChatGPT requires a remote connector");
    expect(claude).toMatch(/^# genie in Claude Code$/m);
    expect(claude).toContain("Claude Code only");
    expect(claude).toContain("Claude Desktop uses `claude_desktop_config.json`");
    expect(claude).toMatch(/claude\.ai cannot launch a\s+local stdio command/);
    expect(claude).toContain("mkdir -p ~/.claude/skills ~/.claude/commands");
  });

  it("does not promise automatic Claude Code OAuth before protected-resource discovery ships", () => {
    const claude = readFileSync(resolve(ROOT, "docs/harness/claude-code.md"), "utf8");

    expect(claude).toContain("`/.well-known/oauth-protected-resource/mcp`");
    expect(claude).toMatch(/supported Claude\s+Code setup/);
    expect(claude).not.toContain("Claude Code discovers the metadata document");
    expect(claude).not.toContain("all automatically");
  });

  it("documents apiKeyHelper and headersHelper in their default Claude Code files", () => {
    const claude = readFileSync(resolve(ROOT, "docs/harness/claude-code.md"), "utf8");

    expect(claude).toContain("`~/.claude/settings.json`");
    expect(claude).toContain("`~/.claude.json`");
    expect(claude).toContain("Do not combine these blocks into `~/.claude.json`");
    expect(claude).not.toContain("together in the same config file");
  });

  it("keeps manual paid smoke runs isolated from normal CI concurrency", () => {
    const ci = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

    expect(ci).toContain(
      "group: ci-${{ github.workflow }}-${{ github.event_name == 'push' && github.sha || github.ref }}",
    );
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    for (const job of ["check", "gitea", "viewer-a11y", "viewer-e2e", "codex-smoke"]) {
      expect(ci).toMatch(
        new RegExp(
          `^  ${job}:\\n(?:    .*\\n)*?    if: github\\.event_name != 'workflow_dispatch'$`,
          "m",
        ),
      );
    }
    expect(ci).toMatch(
      /^ {2}m5-smoke-claude-code:\n(?: {4}.*\n)*? {4}if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'$/m,
    );
  });

  it("documents portable Agent Skill installation for supported harnesses", () => {
    const cursor = readFileSync(resolve(ROOT, "docs/harness/cursor.md"), "utf8");
    const codex = readFileSync(resolve(ROOT, "docs/harness/codex.md"), "utf8");
    const copilot = readFileSync(resolve(ROOT, "docs/harness/copilot.md"), "utf8");
    const overview = readFileSync(resolve(ROOT, "docs/harness/README.md"), "utf8");
    const skill = readFileSync(resolve(ROOT, "packages/plugin/skills/genie/SKILL.md"), "utf8");
    const design = readFileSync(
      resolve(ROOT, "docs/superpowers/specs/2026-07-05-genie-chat-invocation-design.md"),
      "utf8",
    );

    expect(cursor).toContain("~/.cursor/skills/genie");
    expect(codex).toContain("~/.agents/skills/genie");
    expect(copilot).toContain("~/.copilot/skills/genie");
    expect(overview).not.toContain("Only Claude Code / Claude Desktop / claude.ai do");
    expect(design).not.toContain("Cursor, Codex CLI, and Copilot have no equivalent");
    expect(design).toContain("source checkout");
    expect(design).not.toContain("Ship `SKILL.md` + command files inside the npm/`.mcpb` package");
    expect(overview).toContain("local stdio");
    expect(overview).toContain("HTTP defaults to remote");
    expect(overview).toContain("--preview-locality local");
    expect(overview).toMatch(/remote HTTP/i);
    expect(copilot).toContain("HTTP surfaces never auto-open");
    expect(skill).toContain("writes: conjureResult.files.map(file => file.path)");
    expect(cursor).toContain("Only local Cursor / VS Code");
    expect(cursor).toContain("ChatGPT receives the inline app");
  });
});
