/**
 * MCP tool: refine (M2-04 · DRO-251) — genie's iterate-on-an-existing-component
 * verb.
 *
 * Where `conjure` (M2-03) generates a component from a blank-slate prompt,
 * `refine` takes a component that ALREADY exists in a kit plus a free-form
 * `instruction` ("make the border radius softer") and an optional canvas-style
 * `region: { x, y, w, h }` rect, and returns the updated component — a unified
 * diff for the human plus the full updated file set (the source of truth, AC5).
 *
 * It reuses M2-03's machinery deliberately (AC6 "same retry-once pattern as
 * M2-03"): the request/validate/retry loop, the COMPONENT_SCHEMA `json_schema`
 * response_format, the Ajv validation, and the single retry-with-feedback all
 * come from the shared `llm/component-response.ts` harness. The delta from
 * `conjure` is entirely in the prompt (diff-mode: "edit, don't rewrite") and two
 * new steps this file owns: loading the current source from the kit (AC3) and,
 * when a region is given, rendering a crop of it for vision input (AC4/AC7).
 *
 * ── Import-time safety (same as conjure) ──────────────────────────────────────
 * `../llm/client.js` constructs its `llmClient` singleton eagerly at module load
 * and throws `MissingLLMConfigError` when `GENIE_LLM_*` is unset. So the client
 * is only a *type* import here (erased by `verbatimModuleSyntax`); the default
 * runtime `chat` seam reaches it via a lazy `await import(...)`, touched only
 * when a real `refine` call runs. Tests inject their own `chat` + `kitStore` +
 * `cropper` and never load the client or Playwright.
 *
 * ── AC7 region crop is a lazy, OPTIONAL peer dependency ───────────────────────
 * AC7 asks for a headless-Chromium crop via Playwright, and calls Playwright
 * "M3-02's validator setup is a peer dependency" — i.e. it is NOT one of genie's
 * hard `dependencies` (M3-02 hasn't landed). So the default `RegionCropper`
 * resolves Playwright with a *runtime* `import(...)` and degrades gracefully when
 * it is absent: it logs a warning and returns no image, and `refine` still runs
 * — the region's coordinates are described in the prompt text so the model can
 * still scope its edit. This keeps `refine` shippable now (CI's
 * `--frozen-lockfile` install stays green without Playwright) and lets the real
 * crop light up automatically once M3-02 adds Playwright. The cropper is
 * injectable, so tests exercise both the crop-attached and crop-unavailable
 * paths with a stub.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

import { type ValidatedComponent } from "../llm/schema.js";
import {
  REFINE_COMPONENT_SYSTEM_PROMPT_FILE,
  loadPrompt,
  type LoadedPrompt,
} from "../llm/prompts.js";
// Type-only (erased at build): importing the *values* from client.js would trip
// its eager MissingLLMConfigError singleton at server-build time. The default
// chat impl reaches the client lazily via dynamic import.
import type { ChatCompletionInput } from "../llm/client.js";
// The shared request/validate/retry harness (M2-03/M2-04) — the same Ajv
// validate, response_format envelope, retry-feedback wording, and two-attempt
// loop `conjure` uses (AC6).
import {
  type ChatCompletionFn,
  type RetryContext,
  type UsageInfo,
  appendRetryFeedback,
  logStderr,
  runComponentGeneration,
} from "../llm/component-response.js";
import { KIT_ID_PATTERN } from "./get_kit.js";

export const REFINE_TOOL_NAME = "mcp__genie__refine";

/** Default model routing alias — the same one `conjure` uses (M2-05). Resolved
 * to a concrete provider model by the configured endpoint/gateway. Defined
 * locally to keep `refine` decoupled from `conjure`'s module. */
export const DEFAULT_MODEL = "design-default";

/** PascalCase component-name shape — identical to `COMPONENT_SCHEMA`'s
 * `componentName` pattern, so an id `refine` accepts is one `conjure` could have
 * produced. */
export const COMPONENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]{1,63}$/;

/** Directory prefix every kit component's files live under. */
const COMPONENTS_ROOT = "components";

// ── Input schema (AC2) ────────────────────────────────────────────────────────
//
// { kitId, componentName, instruction, region?: { x, y, w, h }, model? }
// (research §3.1). `region` bounds mirror COMPONENT_SCHEMA's viewport limits
// (≤4096) so a canvas selection can't request an absurd crop; `w`/`h` are ≥1
// (a zero-area rect is not a selection). `model` defaults like `conjure`.
const regionSchema = z
  .object({
    x: z.number().int().min(0).max(4096),
    y: z.number().int().min(0).max(4096),
    w: z.number().int().min(1).max(4096),
    h: z.number().int().min(1).max(4096),
  })
  .strict();

export type Region = z.infer<typeof regionSchema>;

const refineInputShape = {
  kitId: z
    .string()
    .regex(
      KIT_ID_PATTERN,
      "kitId must be a 3-64 character slug of lowercase letters, numbers, and hyphens.",
    ),
  componentName: z
    .string()
    .regex(COMPONENT_NAME_PATTERN, "componentName must be PascalCase, 2-64 chars (e.g. Button)."),
  instruction: z.string().min(1).max(8192),
  region: regionSchema.optional(),
  model: z.string().min(1).max(128).default(DEFAULT_MODEL),
} as const;

const refineArgsSchema = z.object(refineInputShape).strict();

export type RefineArgs = z.infer<typeof refineArgsSchema>;

/**
 * What `refine` returns (AC5): a unified `diff` (informational — for the human
 * reading the change) plus the full updated `files` (the source of truth). Also
 * carries `componentName`/`group`/`manifestEntry` (echoing the refined
 * component) and token `usage`, mirroring `conjure`'s richer return so a caller
 * accounts for both verbs the same way.
 */
export interface RefineResult extends Record<string, unknown> {
  componentName: string;
  group: string;
  /** Unified diff (git-style) from the original file set to the updated one. */
  diff: string;
  files: ValidatedComponent["files"];
  manifestEntry: ValidatedComponent["manifestEntry"];
  usage: UsageInfo;
}

// ── Store port (AC3) ──────────────────────────────────────────────────────────

/** A file loaded from the kit: the store's `readFile` result plus the `path` the
 * caller passed in (the store does not echo it back). */
export interface LoadedFile {
  path: string;
  content: string;
  encoding: string;
  mimeType: string;
}

/** The `readFile` result shape `KitStore` returns — content + encoding + MIME,
 * WITHOUT the path (the caller already knows it). Kept structurally identical to
 * `KitFileContent` so the real `KitStore` is assignable to `RefineKitStore`. */
export interface KitFileRead {
  content: string;
  encoding: string;
  mimeType: string;
}

/**
 * The narrow kit-read port `refine` needs: list a kit's files (to discover which
 * belong to `componentName`) and read each one (AC3). `KitStore` satisfies this
 * structurally — the same pattern `conjure_screen` uses for its project port.
 *
 * Discovery via `listFiles` rather than `listComponents`: the latter reads the
 * M3-03-compiled `.genie/manifest.json` card index, which does not exist yet in
 * M2. `listFiles` + a path filter is the manifest-independent way to find a
 * component's files today; when M3-03 lands, this can switch to the manifest
 * without changing the tool's contract.
 */
export interface RefineKitStore {
  listFiles(kitId: string): Promise<{ path: string }[]>;
  readFile(kitId: string, path: string): Promise<KitFileRead>;
}

// ── Region cropper seam (AC7) ─────────────────────────────────────────────────

/** A request to render a preview and screenshot one rectangle of it. */
export interface RegionCropRequest {
  /** The `<Name>.html` preview markup to render. */
  html: string;
  /** The rect to screenshot, in the preview's own pixel coordinates. */
  region: Region;
  /** The viewport to render the preview at (must contain the region). */
  viewport: { width: number; height: number };
}

/** The crop result: a `data:image/png;base64,…` URL, or `null` when a crop could
 * not be produced (Playwright absent, or a render/screenshot failure). `null` is
 * a graceful-degradation signal, never an error — `refine` proceeds without the
 * image (AC7). */
export interface RegionCropResult {
  dataUrl: string | null;
}

/**
 * The region-crop seam (AC7). Production supplies {@link defaultRegionCropper}
 * (lazy Playwright); tests inject a stub so no browser is launched and the
 * crop-attached / crop-unavailable branches are both exercisable offline.
 */
export interface RegionCropper {
  crop(request: RegionCropRequest): Promise<RegionCropResult>;
}

export interface RefineDeps {
  /** Kit-read port (AC3). Required — `refine` cannot load source without it. */
  kitStore: RefineKitStore;
  /** Chat-completion seam (AC6). Defaults to a lazy wrapper over the M2-01 client. */
  chat?: ChatCompletionFn;
  /** Region-crop seam (AC7). Defaults to lazy Playwright with graceful degradation. */
  cropper?: RegionCropper;
  /** Prompt loader override (tests). Defaults to the real versioned loader. */
  loadSystemPrompt?: () => LoadedPrompt;
}

/** Typed failure surfaced to the tool boundary (mapped to an MCP error result).
 * `ERR_COMPONENT_NOT_FOUND` — no files for `componentName` in the kit (or the
 * kit itself is absent); `ERR_LLM_OUTPUT_INVALID` — the model did not return a
 * schema-valid component after the retry (same code `conjure` throws). */
export class RefineError extends Error {
  constructor(
    readonly code: "ERR_COMPONENT_NOT_FOUND" | "ERR_LLM_OUTPUT_INVALID",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RefineError";
  }
}

// ── Default (production) chat impl: lazy client import (same as conjure) ───────

const defaultChatCompletion: ChatCompletionFn = async (input) => {
  const { createChatCompletion } = await import("../llm/client.js");
  return createChatCompletion(input);
};

// ── Default (production) region cropper: lazy Playwright (AC7) ─────────────────
//
// Minimal structural types for the slice of Playwright's API we touch, declared
// locally because Playwright is an OPTIONAL peer dependency (M3-02) with no
// `@types` installed. The specifier below is loaded through a non-literal
// variable so `tsc` does not try to resolve `"playwright"` at build time (it is
// not a dependency) — resolution happens only at runtime, inside the try/catch.

interface PwPage {
  setContent(html: string, options?: { waitUntil?: string }): Promise<void>;
  screenshot(options: {
    clip: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer>;
}
interface PwBrowser {
  newPage(options?: { viewport?: { width: number; height: number } }): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(options?: { args?: string[] }): Promise<PwBrowser>;
}
interface PlaywrightModule {
  chromium: PwChromium;
}

/** Load Playwright at runtime, or `null` if it is not installed. The non-literal
 * specifier keeps `tsc` from resolving the (non-dependency) module at build. */
async function importPlaywright(): Promise<PlaywrightModule | null> {
  const specifier = "playwright";
  try {
    return (await import(specifier)) as PlaywrightModule;
  } catch (error) {
    logStderr({
      event: "refine.region.unavailable",
      reason: "playwright-not-installed",
      error: String(error),
    });
    return null;
  }
}

/**
 * Default cropper (AC7): render the preview HTML in headless Chromium and
 * screenshot the region rect, returning it as a PNG data URL for vision input.
 * Degrades gracefully — if Playwright is absent, or launch/render/screenshot
 * fails, it logs and returns `{ dataUrl: null }` so `refine` continues without
 * the image rather than failing the whole call over an optional enhancement.
 */
export const defaultRegionCropper: RegionCropper = {
  async crop({ html, region, viewport }): Promise<RegionCropResult> {
    const pw = await importPlaywright();
    if (!pw) return { dataUrl: null };

    let browser: PwBrowser | undefined;
    try {
      // `--no-sandbox` so it runs in restricted CI/container environments.
      browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
      const page = await browser.newPage({ viewport });
      // `load` (not `networkidle`): an embedded-CSP preview has no network to go
      // idle on (`default-src 'none'`), so waiting for idle would just add the
      // default timeout to every crop.
      await page.setContent(html, { waitUntil: "load" });
      const buf = await page.screenshot({
        clip: { x: region.x, y: region.y, width: region.w, height: region.h },
      });
      return { dataUrl: `data:image/png;base64,${buf.toString("base64")}` };
    } catch (error) {
      logStderr({ event: "refine.region.error", error: String(error) });
      return { dataUrl: null };
    } finally {
      if (browser) await browser.close();
    }
  },
};

// ── File discovery (AC3) ──────────────────────────────────────────────────────

/**
 * Split a kit-relative path into its `components/<group>/<Name>/…` parts, or
 * `null` if it is not a component file. Used to find every file belonging to
 * `componentName` and to read its group off the first match.
 */
function parseComponentPath(path: string): { group: string; name: string; rest: string } | null {
  const parts = path.split("/");
  if (parts.length < 4 || parts[0] !== COMPONENTS_ROOT) return null;
  return { group: parts[1]!, name: parts[2]!, rest: parts.slice(3).join("/") };
}

/**
 * Load every file of `componentName` from the kit (AC3): `listFiles` to discover
 * the set, then `readFile` per file (one call each, as the AC specifies). The
 * group is derived from the matched paths — a component's directory names it.
 * Throws `RefineError("ERR_COMPONENT_NOT_FOUND")` when nothing matches (a missing
 * kit surfaces the same way: no files, nothing to refine).
 */
async function loadComponentFiles(
  kitStore: RefineKitStore,
  kitId: string,
  componentName: string,
): Promise<{ group: string; files: LoadedFile[] }> {
  let entries: { path: string }[];
  try {
    entries = await kitStore.listFiles(kitId);
  } catch (error) {
    // A missing kit (NotFoundError) is just "nothing to refine" — one clear code.
    throw new RefineError(
      "ERR_COMPONENT_NOT_FOUND",
      `Could not load component "${componentName}" from kit "${kitId}": ${String(
        (error as Error)?.message ?? error,
      )}`,
      { kitId, componentName },
    );
  }

  // Match files whose 3rd path segment is exactly the component name. Sort by
  // path so group derivation and file order are deterministic.
  const matches = entries
    .map((e) => ({ path: e.path, parsed: parseComponentPath(e.path) }))
    .filter(
      (m): m is { path: string; parsed: NonNullable<ReturnType<typeof parseComponentPath>> } =>
        m.parsed !== null && m.parsed.name === componentName,
    )
    .sort((a, b) => a.path.localeCompare(b.path));

  if (matches.length === 0) {
    throw new RefineError(
      "ERR_COMPONENT_NOT_FOUND",
      `No component named "${componentName}" was found in kit "${kitId}". ` +
        `Expected files under ${COMPONENTS_ROOT}/<group>/${componentName}/.`,
      { kitId, componentName },
    );
  }

  // A component lives in ONE group; take it from the first match and keep only
  // that group's files (guards the pathological case of two same-named dirs).
  const group = matches[0]!.parsed.group;
  const inGroup = matches.filter((m) => m.parsed.group === group);

  const files = await Promise.all(
    inGroup.map(async ({ path }): Promise<LoadedFile> => {
      const read = await kitStore.readFile(kitId, path);
      return { path, content: read.content, encoding: read.encoding, mimeType: read.mimeType };
    }),
  );
  return { group, files };
}

// ── Preview + viewport helpers (AC4/AC7) ──────────────────────────────────────

/** The `<Name>.html` preview file among the loaded set, if present. */
function findPreview(files: LoadedFile[], componentName: string): LoadedFile | undefined {
  const suffix = `/${componentName}/${componentName}.html`;
  return files.find((f) => f.path.endsWith(suffix));
}

/**
 * Choose a render viewport for the crop that (a) is at least the component's
 * natural preview size (read from `meta.json`'s `viewport` when available, so the
 * layout matches how the card really renders) and (b) is big enough to contain
 * the requested region. Falls back to a sensible default when there is no
 * parseable meta.
 */
export function deriveRenderViewport(
  files: LoadedFile[],
  region: Region,
): { width: number; height: number } {
  const DEFAULT = { width: 400, height: 300 };
  const meta = files.find((f) => f.path.endsWith("/meta.json"));
  let base = DEFAULT;
  if (meta) {
    try {
      const parsed = JSON.parse(meta.content) as {
        viewport?: { width?: unknown; height?: unknown };
      };
      const w = parsed.viewport?.width;
      const h = parsed.viewport?.height;
      if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
        base = { width: w, height: h };
      }
    } catch {
      // Non-JSON / unexpected meta → keep the default. Best-effort only.
    }
  }
  return {
    width: Math.max(base.width, region.x + region.w),
    height: Math.max(base.height, region.y + region.h),
  };
}

// ── Prompt / message assembly (AC4) ───────────────────────────────────────────

/** True for files we inline verbatim into the prompt. Binary (base64) files are
 * summarized rather than dumped as base64 into the context. */
function isTextFile(file: LoadedFile): boolean {
  return file.encoding !== "base64";
}

/** Build the natural-language user instruction block (everything except the
 * optional vision crop image, attached separately). */
function buildUserText(
  args: RefineArgs,
  group: string,
  files: LoadedFile[],
  cropAttached: boolean,
): string {
  const lines: string[] = [
    "## Instruction",
    args.instruction,
    "",
    "## Component",
    `Name: ${args.componentName}`,
    `Group: ${group}`,
  ];

  if (args.region) {
    const { x, y, w, h } = args.region;
    lines.push(
      "",
      "## Region (canvas selection)",
      `The instruction targets this rectangle of the preview, in the preview's own ` +
        `pixel coordinates: x=${x}, y=${y}, width=${w}, height=${h}.`,
    );
    lines.push(
      cropAttached
        ? "A cropped screenshot of that region is attached as a reference image — " +
            "focus your edit on the element(s) it shows and leave the rest unchanged."
        : "(A rendered crop of that region could not be produced; identify which " +
            "element sits at those coordinates from the preview markup below.)",
    );
  }

  lines.push(
    "",
    "## Current files",
    "Apply only the instruction. Return every file below (updated where the edit " +
      "touches it, unchanged otherwise); do not rename the component or drop files.",
  );
  for (const file of files) {
    lines.push("", `### File: ${file.path} (${file.mimeType})`);
    lines.push(isTextFile(file) ? file.content : `[binary file, ${file.encoding} — omitted]`);
  }
  return lines.join("\n");
}

/**
 * Assemble the messages for one attempt (AC4). System prompt is message 0; the
 * user message carries the instruction + current files, and — when a region crop
 * was produced — becomes a content-parts array with a vision `image_url` part
 * (the same shape `conjure` uses for its reference image). `retry` appends the
 * shared validation-feedback block on the single retry (AC6).
 */
function buildMessages(
  systemPrompt: string,
  args: RefineArgs,
  group: string,
  files: LoadedFile[],
  cropDataUrl: string | null,
  retry: RetryContext | undefined,
): ChatCompletionInput["messages"] {
  let userText = buildUserText(args, group, files, cropDataUrl !== null);
  if (retry) userText = appendRetryFeedback(userText, retry);

  const userContent: ChatCompletionInput["messages"][number]["content"] = cropDataUrl
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: cropDataUrl } },
      ]
    : userText;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

// ── Unified diff (AC5) ────────────────────────────────────────────────────────

/**
 * Build a git-style unified diff from the original file set to the updated one,
 * matched by path. Only CHANGED files contribute a hunk (unchanged files are
 * omitted so the diff shows exactly what the refinement did); added/removed
 * files diff against `/dev/null`. Informational only — `files` is authoritative.
 */
export function buildUnifiedDiff(
  originals: Map<string, string>,
  updated: Map<string, string>,
): string {
  const paths = new Set<string>([...originals.keys(), ...updated.keys()]);
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  const parts: string[] = [];
  for (const path of sorted) {
    const before = originals.get(path) ?? "";
    const after = updated.get(path) ?? "";
    if (before === after) continue;
    parts.push(
      createTwoFilesPatch(
        originals.has(path) ? `a/${path}` : "/dev/null",
        updated.has(path) ? `b/${path}` : "/dev/null",
        before,
        after,
      ),
    );
  }
  return parts.join("\n");
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Refine one existing component. Flow: load current files (AC3) → optionally
 * render a region crop (AC4/AC7) → run the shared request/validate/retry loop
 * with the diff-mode prompt (AC6) → compute the unified diff (AC5) → return
 * `{ diff, files, … }` and log a per-call line (AC8).
 */
export async function refine(deps: RefineDeps, args: unknown): Promise<RefineResult> {
  const parsed = refineArgsSchema.parse(args);
  const chat = deps.chat ?? defaultChatCompletion;
  const cropper = deps.cropper ?? defaultRegionCropper;
  const systemPrompt = (
    deps.loadSystemPrompt ?? (() => loadPrompt(REFINE_COMPONENT_SYSTEM_PROMPT_FILE))
  )();

  const startedAt = performance.now();
  const hasRegion = parsed.region !== undefined;

  // AC3 — load the component's current files from the kit.
  const { group, files: originalFiles } = await loadComponentFiles(
    deps.kitStore,
    parsed.kitId,
    parsed.componentName,
  );

  // AC4/AC7 — if a region was given, try to render a crop of it for vision input.
  let cropDataUrl: string | null = null;
  if (parsed.region) {
    const preview = findPreview(originalFiles, parsed.componentName);
    if (preview && isTextFile(preview)) {
      const viewport = deriveRenderViewport(originalFiles, parsed.region);
      const { dataUrl } = await cropper.crop({
        html: preview.content,
        region: parsed.region,
        viewport,
      });
      cropDataUrl = dataUrl;
    } else {
      // No preview to render — the coordinates still reach the prompt as text.
      logStderr({
        event: "refine.region.no_preview",
        componentName: parsed.componentName,
        kitId: parsed.kitId,
      });
    }
  }

  // AC6 — shared request/validate/retry-once loop (same as conjure).
  const { outcome, usage, attempts } = await runComponentGeneration({
    chat,
    model: parsed.model,
    buildMessages: (retry) =>
      buildMessages(systemPrompt.text, parsed, group, originalFiles, cropDataUrl, retry),
  });

  const latencyMs = Math.round(performance.now() - startedAt);

  if (!outcome.ok) {
    logStderr({
      event: "refine",
      ok: false,
      componentName: parsed.componentName,
      hasRegion,
      model: parsed.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs,
      promptVersion: systemPrompt.version,
      attempts,
    });
    throw new RefineError(
      "ERR_LLM_OUTPUT_INVALID",
      `The model did not return a schema-valid component after ${attempts} attempt(s). ` +
        `Last validation error:\n${outcome.reason}`,
      { attempts, reason: outcome.reason },
    );
  }

  const component = outcome.component;

  // Binary (base64) originals are never sent to the model (they can't be inlined
  // as prompt text — see buildUserText), so the model cannot echo them back. If
  // we returned `component.files` as-is, any binary asset in the component
  // directory would be silently DROPPED from the returned set and the diff would
  // misreport it as deleted (diffed against /dev/null) — a refine round-trip
  // would lose it (Copilot review, PR #127). So carry every original binary file
  // the model did not return forward into the result. Because such a file is then
  // byte-identical on both sides, `buildUnifiedDiff`'s `before === after` check
  // omits it from the diff automatically — it is preserved, not spuriously shown
  // as changed.
  const returnedPaths = new Set(component.files.map((f) => f.path));
  const carriedBinaries: ValidatedComponent["files"] = originalFiles
    .filter((f) => !isTextFile(f) && !returnedPaths.has(f.path))
    .map((f) => ({ path: f.path, content: f.content, mimeType: f.mimeType }));
  const files: ValidatedComponent["files"] = [...component.files, ...carriedBinaries];

  // AC5 — unified diff (informational) from originals → updated, by path. Built
  // from the merged `files` so carried-forward binaries (identical on both sides)
  // are excluded, while genuine text edits still surface.
  const originalsByPath = new Map(originalFiles.map((f) => [f.path, f.content]));
  const updatedByPath = new Map(files.map((f) => [f.path, f.content]));
  const diff = buildUnifiedDiff(originalsByPath, updatedByPath);

  // AC8 — per-call structured log.
  logStderr({
    event: "refine",
    ok: true,
    componentName: component.componentName,
    hasRegion,
    model: parsed.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    latencyMs,
    promptVersion: systemPrompt.version,
    attempts,
  });

  return {
    componentName: component.componentName,
    group: component.group,
    diff,
    files,
    manifestEntry: component.manifestEntry,
    usage,
  };
}

// ── MCP registration ──────────────────────────────────────────────────────────

const refineOutputShape = {
  componentName: z.string(),
  group: z.string(),
  diff: z.string(),
  files: z.array(
    z.object({ path: z.string(), content: z.string(), mimeType: z.string() }).strict(),
  ),
  manifestEntry: z
    .object({
      viewport: z.object({ width: z.number(), height: z.number() }).strict(),
      subtitle: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .strict(),
  usage: z
    .object({
      promptTokens: z.number().int().min(0),
      completionTokens: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
    })
    .strict(),
};

export function registerRefineTool(server: McpServer, deps: RefineDeps): void {
  server.registerTool(
    REFINE_TOOL_NAME,
    {
      title: "Refine component",
      description:
        "Iterate on an existing component in a UI kit. Takes a free-form instruction " +
        '(e.g. "make the border radius softer") and an optional region { x, y, w, h } rect ' +
        'for a canvas-style "fix this element" edit, and returns a unified diff plus the full ' +
        "updated files (the files are the source of truth; the diff is informational). Loads the " +
        "component's current source from the kit, validates the model's reply against " +
        "COMPONENT_SCHEMA (retried once on a validation failure), and — when a region is given — " +
        "attaches a rendered crop of it as a visual reference.",
      inputSchema: refineInputShape,
      outputSchema: refineOutputShape,
    },
    async (args) => {
      try {
        const result = await refine(deps, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof RefineError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code: error.code,
                  message: error.message,
                  ...(error.details ? { details: error.details } : {}),
                }),
              },
            ],
          };
        }
        throw error;
      }
    },
  );
}
