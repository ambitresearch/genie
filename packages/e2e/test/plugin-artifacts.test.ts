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
  });

  it("keeps local stdio registration scoped to hosts that can launch it", () => {
    const cursor = readFileSync(resolve(ROOT, "docs/harness/cursor.md"), "utf8");
    const claude = readFileSync(resolve(ROOT, "docs/harness/claude-code.md"), "utf8");

    expect(cursor).toContain("ChatGPT cannot launch a command from your local filesystem");
    expect(cursor).toContain("ChatGPT requires a remote connector");
    expect(claude).toContain("Claude Code only");
    expect(claude).toContain("Claude Desktop uses `claude_desktop_config.json`");
    expect(claude).toMatch(/claude\.ai cannot launch a\s+local stdio command/);
  });
});
