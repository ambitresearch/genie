/**
 * Tests for the M2-05 reference LiteLLM config (`deploy/litellm/config.yaml`,
 * DRO-252). This is a static reference example (no runtime code path in
 * genie consumes it — genie only ever talks to whatever `GENIE_LLM_BASE_URL`
 * fronts), so there is nothing here to unit-test in the usual sense. What
 * *can* regress silently in a YAML file with no compiler or type system
 * behind it:
 *
 *   - a typo re-introducing a placeholder/invalid model id (AC0)
 *   - a hardcoded secret or private URL replacing an `os.environ/` ref
 *     (CLAUDE.md hard rule 5 / AGENTS.md hard rule 4)
 *   - one of the three required aliases going missing or being renamed
 *   - the budget/rate-limit numbers (AC3/AC4) drifting, or a YAML quirk
 *     (see the `200_000` bug this suite caught below) silently turning a
 *     number into a string LiteLLM's loader would reject
 *
 * So this suite parses the real file and asserts its shape — the same
 * "encode the AC as a test" discipline AGENTS.md §2 asks for on code, applied
 * to a config file instead.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const configPath = resolve(repoRoot, "deploy", "litellm", "config.yaml");
const rawConfig = readFileSync(configPath, "utf-8");

/** Minimal shape this suite cares about — not the full LiteLLM config schema. */
interface LiteLLMModelEntry {
  model_name: string;
  litellm_params: {
    model: string;
    api_key?: string;
    api_base?: string;
  };
}

interface LiteLLMConfig {
  model_list: LiteLLMModelEntry[];
  litellm_settings?: {
    upperbound_key_generate_params?: {
      max_budget?: number;
      budget_duration?: string;
      rpm_limit?: number;
      tpm_limit?: number;
    };
  };
  general_settings?: {
    master_key?: string;
  };
}

describe("deploy/litellm/config.yaml (M2-05 reference config)", () => {
  it("parses as valid YAML (AC1)", () => {
    // parse() throws on malformed YAML — this alone catches the class of
    // "someone hand-edited this and broke indentation" regression.
    expect(() => parse(rawConfig)).not.toThrow();
  });

  const config = parse(rawConfig) as LiteLLMConfig;

  it("defines exactly the three genie generation aliases (AC2)", () => {
    const names = config.model_list.map((entry) => entry.model_name);
    expect(names).toEqual(["design-default", "design-best", "design-local"]);
  });

  it("routes design-default and design-best through Anthropic with a passthrough secret ref, never a literal key (AC2)", () => {
    for (const alias of ["design-default", "design-best"]) {
      const entry = config.model_list.find((e) => e.model_name === alias);
      expect(entry, `expected a ${alias} entry`).toBeTruthy();
      expect(entry!.litellm_params.api_key).toBe("os.environ/ANTHROPIC_API_KEY");
    }
  });

  it("routes design-local through a passthrough api_base ref, never a literal URL (AC2)", () => {
    const entry = config.model_list.find((e) => e.model_name === "design-local");
    expect(entry).toBeTruthy();
    expect(entry!.litellm_params.api_base).toBe("os.environ/OLLAMA_API_BASE");
  });

  it("does not route design-local to the issue's invalid placeholder tag (AC0)", () => {
    // AC0 requires confirming the real catalog and replacing placeholders.
    // The issue's own placeholder for design-local does not exist in
    // Ollama's published tags (only `30b` and `480b` are real), so this
    // asserts on the *parsed model value actually used*, not the raw file
    // text — the file's own comments legitimately discuss and reject that
    // placeholder in prose, which a raw substring check can't distinguish
    // from shipping it as a live value.
    const entry = config.model_list.find((e) => e.model_name === "design-local");
    const invalidPlaceholderTag = ["qwen3-coder", "32b"].join(":");
    expect(entry!.litellm_params.model).not.toContain(invalidPlaceholderTag);
  });

  it("sets the AC3 per-key budget: 50 USD, resetting every 30 days", () => {
    const bounds = config.litellm_settings?.upperbound_key_generate_params;
    expect(bounds?.max_budget).toBe(50);
    expect(bounds?.budget_duration).toBe("30d");
  });

  it("sets the AC4 per-key rate limit: 20 RPM / 200 KTPM", () => {
    const bounds = config.litellm_settings?.upperbound_key_generate_params;
    expect(bounds?.rpm_limit).toBe(20);
    // Regression guard: an early draft of this file wrote `200_000` (a
    // numeric-underscore literal). LiteLLM's config loader expects a plain
    // int; several YAML parsers (including the `yaml` package used by this
    // very test, checked against its default "core" schema) read
    // `200_000` back as the *string* "200_000", not the number 200000 — a
    // shape LiteLLM would reject at startup. Assert both the value and the
    // type so that regression can't reappear silently.
    expect(bounds?.tpm_limit).toBe(200_000);
    expect(typeof bounds?.tpm_limit).toBe("number");
  });

  it("never hardcodes the LiteLLM master key — always an os.environ/ passthrough ref", () => {
    expect(config.general_settings?.master_key).toBe("os.environ/LITELLM_MASTER_KEY");
  });

  it("contains no bare secret-shaped literal anywhere in the file (defense in depth)", () => {
    // Belt-and-suspenders beyond the field-level assertions above: scan the
    // raw text for common API-key prefixes so a *new* field added later
    // (not just the ones this suite already names) can't sneak a literal
    // secret past review. `os.environ/` is the only way a value referencing
    // a secret var name may appear.
    expect(rawConfig).not.toMatch(/sk-(ant|proj|litellm)-[A-Za-z0-9]/);
    expect(rawConfig).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });

  it("every litellm_params secret-shaped field (api_key/api_base) is an os.environ/ passthrough", () => {
    for (const entry of config.model_list) {
      for (const field of ["api_key", "api_base"] as const) {
        const value = entry.litellm_params[field];
        if (value !== undefined) {
          expect(value.startsWith("os.environ/")).toBe(true);
        }
      }
    }
  });
});
