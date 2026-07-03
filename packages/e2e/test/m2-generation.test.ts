/**
 * M2-09 (DRO-256) — M2 integration test: real LLM endpoint round-trip.
 *
 * The canary for the whole generation pipeline (M2-01..M2-08): calls the REAL
 * `conjure`/`refine` tool functions — no stubbed `chat` seam — against
 * whatever OpenAI-compatible endpoint the environment's `GENIE_LLM_BASE_URL` /
 * `GENIE_LLM_API_KEY` point at, exactly the way a genie operator's own
 * deployment would (M2-01's client; M2-05's `design-default` model alias).
 *
 * Every other M2 test (`conjure.test.ts`, `refine.test.ts`, `validate.test.ts`,
 * `schema.test.ts`, …) stubs the chat-completion seam — deliberately, so the
 * bulk of the suite runs in CI on every PR with no network and no cost. THIS
 * file is the one place that spends real dollars against a real model, which
 * is exactly why it is gated (AC2) and budget-capped (AC6): the point isn't
 * to re-prove request-shaping (the unit tests already do that exhaustively);
 * it's to prove the parts unit tests structurally cannot — that a live model,
 * talking to a live endpoint, actually returns something `COMPONENT_SCHEMA`
 * and the `@genie` marker convention accept.
 *
 * ── Gate (AC2) ────────────────────────────────────────────────────────────
 * Skipped whenever `GENIE_LLM_API_KEY` is unset — the common case for a local
 * `pnpm test` and for every PR-triggered CI run (`ci.yml`'s `check` matrix
 * never sets it). Only a dedicated CI job gated to `push` on `main` (and an
 * operator who has deliberately provisioned `GENIE_LLM_BASE_URL` /
 * `GENIE_LLM_API_KEY` as repo secrets) actually executes this suite — see
 * `.github/workflows/ci.yml`'s `m2-generation` job. Mirrors the
 * `describe.skipIf(!dockerAvailable)` pattern the Gitea conformance suites
 * (`m1-conformance.test.ts` / `gitea-conformance.test.ts`) already use for
 * their own opt-in, environment-gated leg.
 *
 * ── Why no stub, and why an in-memory RefineKitStore for AC8 ────────────────
 * `conjure` is pure generation (AC9 of M2-03) — it never touches a KitStore,
 * so AC3-AC7 need nothing beyond the real `chat` seam. AC8's refine round-trip
 * DOES need a `RefineKitStore` (refine loads the component's "current" files
 * before editing them, AC3 of M2-04) — but genie's kit/plan/write_files
 * storage layer is its own, already-covered surface (M1-14/M1-14a). Rather
 * than pull that whole chain in (out of scope for an *LLM round-trip* test),
 * this file hands `refine` a minimal in-memory `RefineKitStore` seeded
 * directly from the just-conjured files — so the "current source" `refine`
 * reads back is exactly what `conjure` really returned, live, one step
 * earlier in this same run.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { conjure, type ConjureDeps, type ConjureResult } from "../../server/src/tools/conjure.js";
import {
  refine,
  type RefineDeps,
  type RefineKitStore,
  type RefineResult,
} from "../../server/src/tools/refine.js";
import { MARKER_REGEX_M2_07, validateComponent } from "../../server/src/llm/validate.js";
import type { ValidatedComponent } from "../../server/src/llm/schema.js";

import { estimateCostUsd } from "../src/pricing.js";

// ── AC2 — gate ────────────────────────────────────────────────────────────────

const hasLlmApiKey = Boolean(process.env["GENIE_LLM_API_KEY"]);
if (!hasLlmApiKey) {
  // Visible breadcrumb, same convention as the Gitea conformance suites: a
  // green "skipped" run must never read like a green "ran and passed" one.
  console.info(
    "[m2-generation] GENIE_LLM_API_KEY is not set — skipping the real LLM endpoint " +
      "round-trip (AC2). Set GENIE_LLM_BASE_URL + GENIE_LLM_API_KEY to a real " +
      "OpenAI-compatible endpoint to run this suite for real; CI's dedicated " +
      "m2-generation job (push-to-main only) runs it when those are provisioned " +
      "as repo secrets.",
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** The exact model alias AC3 requires the 5 components be generated against.
 * Resolved by the operator's configured endpoint/gateway (M2-05's
 * `design-default` → a Sonnet-class model, `deploy/litellm/config.yaml`). */
const MODEL_ALIAS = "design-default";

/** $5 USD hard cap for one full run of this suite (AC6). */
const BUDGET_CAP_USD = 5;

/** Generous ceiling for 5 parallel `conjure` calls + 1 sequential `refine`
 * call against a REAL endpoint — real network latency, not the sub-second
 * stubbed-seam budget the rest of the M2 suite uses. */
const GENERATION_TIMEOUT_MS = 180_000;

const KIT_ID = "m2-generation-e2e-kit";
const KIT_DESCRIPTION =
  "Warm Instrument UI kit: clay accent #c87c5e used only on primary/generation " +
  "moments, 8px corner radius, Inter for body text, Newsreader for display " +
  "headings, warm bone-paper background (#faf8f5), near-black ink text. " +
  "Structural chrome stays neutral/ink; the clay accent is reserved for the " +
  "single most important action on a surface.";

/** AC3's five required components, each with the group + natural-language
 * prompt `conjure` needs. Kept deliberately small/concrete so a real model
 * call stays fast and cheap. */
interface ComponentSpec {
  label: string;
  group: string;
  prompt: string;
}

const COMPONENT_SPECS: ComponentSpec[] = [
  { label: "primary button", group: "actions", prompt: "A primary call-to-action button." },
  {
    label: "secondary button",
    group: "actions",
    prompt: "A secondary (outlined or ghost) button, lower visual emphasis than a primary button.",
  },
  {
    label: "card",
    group: "content",
    prompt: "A content card with a thumbnail image, a title, and a short description.",
  },
  {
    label: "modal",
    group: "overlays",
    prompt:
      "A confirmation modal dialog with a title, a short message, and Confirm/Cancel buttons.",
  },
  {
    label: "nav bar",
    group: "navigation",
    prompt:
      "A top navigation bar with a logo/wordmark, three nav links, and a call-to-action button.",
  },
];

/** One generated component plus its estimated USD cost (AC6). */
interface GeneratedComponent {
  spec: ComponentSpec;
  result: ConjureResult;
  costUsd: number;
}

/** The full run's outcome — what every `it()` below asserts slices of. */
interface GenerationRun {
  components: GeneratedComponent[];
  refined: { result: RefineResult; costUsd: number };
  totalCostUsd: number;
}

/** PascalCase component-name shape — same pattern COMPONENT_SCHEMA's
 * `componentName` enforces (schema.ts); re-declared here only for an explicit,
 * readable AC3 assertion (the real enforcement is validateComponent, AC4). */
const COMPONENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]{1,63}$/;

/** Reassemble the plain `COMPONENT_SCHEMA` shape from a tool result. Both
 * `ConjureResult` and `RefineResult` carry extra fields (`usage`, `diff`) the
 * schema's `additionalProperties: false` would reject, so `validateComponent`
 * (AC4) must see only the four schema keys. */
function toSchemaShape(result: {
  componentName: string;
  group: string;
  files: ValidatedComponent["files"];
  manifestEntry: ValidatedComponent["manifestEntry"];
}): unknown {
  return {
    componentName: result.componentName,
    group: result.group,
    files: result.files,
    manifestEntry: result.manifestEntry,
  };
}

/** Every `<Name>.html` preview file among a component's file set. There is
 * always exactly one (COMPONENT_SCHEMA's `contains` guarantee), but this
 * returns the full match set rather than assuming that shape holds. */
function htmlFiles(files: ValidatedComponent["files"]): ValidatedComponent["files"][number][] {
  return files.filter((f) => f.path.endsWith(".html"));
}

/**
 * A `RefineKitStore` backed entirely by an in-memory file set — no real kit,
 * no filesystem. Used to hand AC8's `refine` call the exact files `conjure`
 * just returned, one step earlier in this same live run (see module header).
 */
function inMemoryKitStore(files: ValidatedComponent["files"]): RefineKitStore {
  return {
    async listFiles() {
      return files.map((f) => ({ path: f.path }));
    },
    async readFile(_kitId: string, path: string) {
      const file = files.find((f) => f.path === path);
      if (!file) throw new Error(`m2-generation fixture: no such file "${path}"`);
      // COMPONENT_SCHEMA's file content is always a UTF-8 string (no base64
      // variant) — every conjure/refine file is safely "utf-8" for refine's
      // isTextFile() check.
      return { content: file.content, encoding: "utf-8", mimeType: file.mimeType };
    },
  };
}

// ── Report artefacts (AC7) ────────────────────────────────────────────────────

const REPORTS_DIR = join(process.cwd(), "reports", "m2-generation");

interface ReportEntry {
  label: string;
  componentName: string;
  group: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** Write one component's `.html` preview sample + the run's `summary.json` to
 * `reports/m2-generation/` (AC7 — the CI artefact this test produces; the
 * upload step itself lives in `ci.yml`'s `m2-generation` job). */
async function writeReport(
  generated: GeneratedComponent[],
  refined: RefineResult,
): Promise<{ summaryPath: string; totalCostUsd: number }> {
  await rm(REPORTS_DIR, { recursive: true, force: true });
  await mkdir(REPORTS_DIR, { recursive: true });

  const entries: ReportEntry[] = [];
  for (const { spec, result, costUsd } of generated) {
    const html = htmlFiles(result.files)[0];
    if (html) {
      await writeFile(join(REPORTS_DIR, `${result.componentName}.html`), html.content, "utf-8");
    }
    entries.push({
      label: spec.label,
      componentName: result.componentName,
      group: result.group,
      model: MODEL_ALIAS,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      costUsd,
    });
  }

  const refinedHtml = htmlFiles(refined.files)[0];
  if (refinedHtml) {
    await writeFile(
      join(REPORTS_DIR, `${refined.componentName}.refined.html`),
      refinedHtml.content,
      "utf-8",
    );
  }

  const totalCostUsd =
    entries.reduce((sum, e) => sum + e.costUsd, 0) + estimateCostUsd(MODEL_ALIAS, refined.usage);

  const summaryPath = join(REPORTS_DIR, "summary.json");
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: MODEL_ALIAS,
        budgetCapUsd: BUDGET_CAP_USD,
        totalCostUsd,
        components: entries,
        refine: {
          componentName: refined.componentName,
          diffNonEmpty: refined.diff.trim().length > 0,
          promptTokens: refined.usage.promptTokens,
          completionTokens: refined.usage.completionTokens,
          costUsd: estimateCostUsd(MODEL_ALIAS, refined.usage),
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  return { summaryPath, totalCostUsd };
}

// ── The live run ──────────────────────────────────────────────────────────────

async function runFullGeneration(): Promise<GenerationRun> {
  const conjureDeps: ConjureDeps = {}; // real chat seam — no stub (see header)

  // AC3 — 5 components, dispatched concurrently (independent generations;
  // the reference gateway's per-key rpm_limit, deploy/litellm/config.yaml,
  // comfortably covers 5 concurrent calls).
  const components = await Promise.all(
    COMPONENT_SPECS.map(async (spec): Promise<GeneratedComponent> => {
      const result = await conjure(conjureDeps, {
        kitId: KIT_ID,
        kit: KIT_DESCRIPTION,
        prompt: spec.prompt,
        group: spec.group,
        framework: "react",
        model: MODEL_ALIAS,
      });
      return { spec, result, costUsd: estimateCostUsd(MODEL_ALIAS, result.usage) };
    }),
  );

  // AC8 — refine round-trip. Refines the first spec (primary button) with a
  // real "make it dark mode" instruction, reading its "current" files back
  // from an in-memory store seeded with what conjure just returned.
  const primary = components[0]!;
  const refineDeps: RefineDeps = { kitStore: inMemoryKitStore(primary.result.files) };
  const refined = await refine(refineDeps, {
    kitId: KIT_ID,
    componentName: primary.result.componentName,
    instruction: "Make it dark mode.",
    model: MODEL_ALIAS,
  });
  const refinedCostUsd = estimateCostUsd(MODEL_ALIAS, refined.usage);

  const totalCostUsd = components.reduce((sum, c) => sum + c.costUsd, 0) + refinedCostUsd;

  return { components, refined: { result: refined, costUsd: refinedCostUsd }, totalCostUsd };
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe.skipIf(!hasLlmApiKey)("M2-09 — real LLM endpoint round-trip (DRO-256)", () => {
  let run: GenerationRun;
  let reportSummaryPath: string;

  beforeAll(async () => {
    run = await runFullGeneration();
    const { summaryPath } = await writeReport(run.components, run.refined.result);
    reportSummaryPath = summaryPath;
  }, GENERATION_TIMEOUT_MS);

  // ── AC3 — 5 components generated against design-default ────────────────────

  describe("AC3 — generates 5 components against design-default", () => {
    it("returns exactly 5 components, one per required kind", () => {
      // Every spec in COMPONENT_SPECS is dispatched through `runFullGeneration`
      // with `model: MODEL_ALIAS` ("design-default") — enforced by construction
      // (see the shared `conjure(conjureDeps, { …, model: MODEL_ALIAS })` call
      // above), so a passing run here already proves all 5 requests targeted it.
      expect(run.components).toHaveLength(COMPONENT_SPECS.length);
      expect(run.components.map((c) => c.spec.label)).toEqual(COMPONENT_SPECS.map((s) => s.label));
    });

    it("every component has a distinct, PascalCase componentName", () => {
      const names = run.components.map((c) => c.result.componentName);
      for (const name of names) {
        expect(name).toMatch(COMPONENT_NAME_PATTERN);
      }
      expect(new Set(names).size).toBe(names.length);
    });
  });

  // ── AC4 — schema validation passes for all 5 ────────────────────────────────

  describe("AC4 — schema validation passes for all 5", () => {
    it("every one of the 5 conjured components validates against COMPONENT_SCHEMA", () => {
      for (const { result } of run.components) {
        expect(
          () => validateComponent(toSchemaShape(result)),
          `componentName=${result.componentName}`,
        ).not.toThrow();
      }
    });

    it("validateComponent returns the same componentName it was given (no silent reshape)", () => {
      for (const { result } of run.components) {
        const validated = validateComponent(toSchemaShape(result));
        expect(validated.componentName).toBe(result.componentName);
      }
    });
  });

  // ── AC5 — @genie regex matches first line of every produced .html ──────────

  describe("AC5 — @genie regex matches first line of every produced .html", () => {
    it("every conjured component's .html preview opens with the @genie marker", () => {
      for (const { result } of run.components) {
        const previews = htmlFiles(result.files);
        expect(previews.length, `componentName=${result.componentName}`).toBeGreaterThan(0);
        for (const html of previews) {
          const firstLine = html.content.split("\n")[0] ?? "";
          expect(firstLine, `${result.componentName}/${html.path}`).toMatch(MARKER_REGEX_M2_07);
        }
      }
    });

    it("the refined component's .html preview also opens with the @genie marker", () => {
      const previews = htmlFiles(run.refined.result.files);
      expect(previews.length).toBeGreaterThan(0);
      for (const html of previews) {
        const firstLine = html.content.split("\n")[0] ?? "";
        expect(firstLine, html.path).toMatch(MARKER_REGEX_M2_07);
      }
    });
  });

  // ── AC6 — aggregate cost stays under the $5 budget cap ──────────────────────

  describe("AC6 — aggregate promptTokens/completionTokens cost stays under the $5 cap", () => {
    it("sums promptTokens + completionTokens * pricing across every call and stays <= $5", () => {
      expect(run.totalCostUsd).toBeGreaterThan(0); // a real run always burns SOME tokens
      expect(
        run.totalCostUsd,
        `aggregate cost $${run.totalCostUsd.toFixed(4)} exceeds the $${BUDGET_CAP_USD} cap`,
      ).toBeLessThanOrEqual(BUDGET_CAP_USD);
    });

    it("every individual call reports non-negative usage", () => {
      for (const { result } of run.components) {
        expect(result.usage.promptTokens).toBeGreaterThanOrEqual(0);
        expect(result.usage.completionTokens).toBeGreaterThanOrEqual(0);
      }
      expect(run.refined.result.usage.promptTokens).toBeGreaterThanOrEqual(0);
      expect(run.refined.result.usage.completionTokens).toBeGreaterThanOrEqual(0);
    });
  });

  // ── AC7 — test report + per-component sample written for CI upload ─────────

  describe("AC7 — per-component sample + summary written for CI artefact upload", () => {
    it("writes one <ComponentName>.html sample per component to reports/m2-generation/", async () => {
      for (const { result } of run.components) {
        const onDisk = await readFile(join(REPORTS_DIR, `${result.componentName}.html`), "utf-8");
        const original = htmlFiles(result.files)[0]?.content;
        expect(onDisk).toBe(original);
      }
    });

    it("writes a summary.json with one entry per component and the aggregate cost", async () => {
      const raw = await readFile(reportSummaryPath, "utf-8");
      const summary = JSON.parse(raw) as { components: unknown[]; totalCostUsd: number };
      expect(summary.components).toHaveLength(COMPONENT_SPECS.length);
      expect(summary.totalCostUsd).toBeCloseTo(run.totalCostUsd, 10);
    });
  });

  // ── AC8 — refine round-trip: generate, refine "make it dark mode", diff non-empty ──

  describe('AC8 — refine round-trip: generate, then refine with "make it dark mode"', () => {
    it("refine returns the same component, with a non-empty unified diff", () => {
      expect(run.refined.result.componentName).toBe(run.components[0]!.result.componentName);
      expect(run.refined.result.diff.trim().length).toBeGreaterThan(0);
    });

    it("the refined output also validates against COMPONENT_SCHEMA", () => {
      expect(() => validateComponent(toSchemaShape(run.refined.result))).not.toThrow();
    });
  });
});
