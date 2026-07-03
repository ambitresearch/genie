/**
 * MCP tool: conjure_screen (M1-21).
 *
 * The M1 project-aware generation contract for *screen* artifacts — a screen is
 * a generated / previewed / refined / committed artifact, the same loop as a
 * component but one step up (D-F). This tool owns the M1 slice: resolve which
 * kit the screen is generated against, run the generation client, and record
 * the resulting artifact reference in `.genie/project.json`. The generation
 * *mechanics* (real model call, the validation gauntlet) are deepened by M2
 * behind the same `ScreenGenerator` seam this file introduces (Implementation
 * Notes: "the same generation-client interface later deepened by M2").
 *
 * Input:  { projectId, prompt, kitId?, blueprintId?, framework?, model? }
 * Output: { screenId, files: [{ path, content, encoding }], usage }
 *
 * Kit resolution ladder (D-F "Default-kit resolution", PRD DS-026 · AC3):
 *   1. explicit  — caller named `kitId`            → use it (validated to exist)
 *   2. default   — the project's `defaultKitId`    → use it
 *   3. sole      — exactly one reachable binding   → use it
 *   4. none / ambiguous → for a kit-specific prompt, STOP with
 *      `ERR_PROJECT_KIT_REQUIRED` (never invent a kit, AC4); for a basic-structure
 *      prompt, generate a framework-neutral scaffold that does not pretend it
 *      used a kit (AC5).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KIT_ID_PATTERN, ProjectNotFoundError, WrongProjectTypeError, getKit } from "./get_kit.js";
import { PROJECT_ID_PATTERN, ProjectStoreError } from "./create_project.js";
import type { ProjectDetail, ProjectScreen, RecordScreenInput } from "./create_project.js";
import type { KitStore } from "../store/interface.js";

export const CONJURE_SCREEN_TOOL_NAME = "mcp__genie__conjure_screen";

/** Target framework for the generated screen artifact (RFC §9.19). */
export const SCREEN_FRAMEWORKS = ["react", "vue", "html"] as const;
export type ScreenFramework = (typeof SCREEN_FRAMEWORKS)[number];

const projectIdSchema = z
  .string()
  .regex(
    PROJECT_ID_PATTERN,
    "projectId must be a 3-64 character slug containing only lowercase letters, numbers, and hyphens.",
  );

const kitIdSchema = z
  .string()
  .regex(
    KIT_ID_PATTERN,
    "kitId must be a 3-64 character slug containing only lowercase letters, numbers, and hyphens.",
  );

const blueprintIdSchema = z
  .string()
  .regex(
    PROJECT_ID_PATTERN,
    "blueprintId must be a 3-64 character slug containing only lowercase letters, numbers, and hyphens.",
  );

/**
 * Input schema (RFC §9.19). `prompt` is bounded (8..8192) so a stray empty
 * string or a megabyte paste can't reach the generator; `framework` defaults to
 * `react`; `model` is an opaque routing hint (default `design-default`) the M1
 * local generator ignores and M2 forwards to the configured endpoint.
 */
const conjureScreenArgsSchema = z
  .object({
    projectId: projectIdSchema,
    prompt: z.string().min(8).max(8192),
    kitId: kitIdSchema.optional(),
    blueprintId: blueprintIdSchema.optional(),
    framework: z.enum(SCREEN_FRAMEWORKS).default("react"),
    model: z.string().min(1).max(128).default("design-default"),
  })
  .strict();

export type ConjureScreenArgs = z.infer<typeof conjureScreenArgsSchema>;

/** How the effective kit was resolved — surfaced so generation can be *honest*
 * about provenance rather than silently guessing (D-F step 3: "use it, and name
 * which"). */
export type KitResolutionVia = "explicit" | "default" | "sole";

/** The kit a screen is generated against, plus how it was chosen. `null` marks a
 * deliberately kitless (framework-neutral) generation. */
export interface ResolvedKit {
  kitId: string;
  via: KitResolutionVia;
}

/** A single generated artifact file. `encoding` is carried explicitly (RFC
 * §9.19) so a future binary artifact (an image, a font) round-trips losslessly
 * rather than being assumed UTF-8. */
export interface GeneratedFile {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
}

/** Token/cost accounting for one generation (RFC `UsageInfo`). The M1 local
 * generator reports all-zero — it makes no model call, and saying so honestly is
 * the point (AC8: no real model call in CI). */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

/** What the tool hands the generator: the fully-resolved generation context. The
 * tool owns id + path layout so the recorded manifest entry and the returned
 * files can never disagree; the generator only fills in file *contents* + usage. */
export interface ScreenGenerationRequest {
  projectId: string;
  screenId: string;
  /** Primary artifact path the tool has reserved (e.g. `screens/<id>/index.tsx`). */
  entryPath: string;
  prompt: string;
  framework: ScreenFramework;
  model: string;
  /** The resolved kit, or `null` for a framework-neutral scaffold (AC5). */
  kit: ResolvedKit | null;
  /** Blueprint this screen was seeded from, if any (AC6). */
  blueprint?: { id: string };
}

export interface ScreenGenerationResult {
  files: GeneratedFile[];
  usage: UsageInfo;
}

/**
 * The generation seam. M1 ships `LocalScaffoldScreenGenerator` (deterministic,
 * offline). M2 swaps in a client that calls the configured OpenAI-compatible
 * endpoint and runs the validation gauntlet — same interface, no tool change.
 */
export interface ScreenGenerator {
  generate(request: ScreenGenerationRequest): Promise<ScreenGenerationResult>;
}

/** Narrow project port `conjure_screen` needs — resolve detail + record the
 * screen. `ProjectStore` (create_project.ts) satisfies this structurally, the
 * same pattern `get_project`/`bind_kit` use. */
export interface ConjureScreenProjectStore {
  getProject(projectId: string): Promise<ProjectDetail>;
  recordScreen(input: { projectId: string; screen: RecordScreenInput }): Promise<ProjectScreen>;
}

export interface ConjureScreenDeps {
  projectStore: ConjureScreenProjectStore;
  /** Used only to validate an *explicit* `kitId` resolves to a real kit before
   * generating against it — default/sole kits came from bindings already
   * validated at bind time. */
  kitStore: KitStore;
  generator: ScreenGenerator;
}

export interface ConjureScreenResult extends Record<string, unknown> {
  screenId: string;
  files: GeneratedFile[];
  usage: UsageInfo;
}

// ── Kit-specificity heuristic (AC4 vs AC5) ────────────────────────────────────
//
// In the *kitless* branch we must decide whether the prompt "asks for
// kit-specific components" (→ stop, AC4) or merely "basic structure" (→ neutral
// scaffold, AC5). M1 uses a deterministic keyword heuristic — no model call, so
// it is testable and CI-stable. It intentionally errs toward *permitting* a
// neutral scaffold: a prompt only trips the kit requirement when it explicitly
// names kit-level component nouns or references a kit/component library. M2 can
// deepen this with the model's own read of the prompt.

/** Component nouns that only a UI kit can supply — interactive widgets and
 * overlays. Matched as whole words, case-insensitively. Structural and
 * *navigation* landmarks (header, footer, nav, navbar, sidebar, toolbar, hero,
 * section, banner, menu, breadcrumb, page, layout, grid) are deliberately
 * absent — those are framework-neutral and a kitless scaffold can render them
 * honestly (AC5). The heuristic errs toward permitting a neutral scaffold. */
const KIT_COMPONENT_TERMS = [
  "button",
  "card",
  "input",
  "textarea",
  "form",
  "modal",
  "dialog",
  "dropdown",
  "select",
  "combobox",
  "table",
  "datagrid",
  "badge",
  "avatar",
  "tab",
  "tabs",
  "accordion",
  "toast",
  "snackbar",
  "chip",
  "slider",
  "switch",
  "toggle",
  "checkbox",
  "radio",
  "tooltip",
  "popover",
  "pagination",
  "stepper",
  "alert",
  "datepicker",
  "carousel",
  "spinner",
  "progressbar",
  "drawer",
];

/** Phrases that explicitly invoke the kit / component library. */
const KIT_PHRASES = [
  "use the kit",
  "using the kit",
  "from the kit",
  "kit component",
  "kit's component",
  "component library",
  "design system component",
];

/**
 * True when `prompt` asks for kit-specific components (whole-word component noun
 * or an explicit kit/component-library phrase). Exported for direct testing of
 * the AC4/AC5 boundary.
 */
export function promptRequiresKit(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  if (KIT_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  // Whole-word match so "input" matches but "throughput" does not, and
  // "form" matches but "information"/"platform" do not.
  return KIT_COMPONENT_TERMS.some((term) => new RegExp(`\\b${term}s?\\b`).test(lower));
}

// ── Screen id + title derivation (deterministic; no clock/random) ─────────────

/** A human title for the screen: first non-empty line of the prompt, whitespace
 * collapsed, capped at 80 chars. Falls back to "Screen". */
export function deriveScreenTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const collapsed = (firstLine ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return "Screen";
  return collapsed.length > 80 ? `${collapsed.slice(0, 79).trimEnd()}…` : collapsed;
}

/** Slugify a title into a screenId base matching `^[a-z0-9-]{3,64}$`. Falls back
 * to "screen" when the title has no slug-able characters or is too short. */
function slugifyScreen(title: string): string {
  const slug = title
    // Locale-independent: `toLocaleLowerCase()` would fold letters per the host
    // locale (e.g. Turkish `I`→`ı`), making the same title yield different ids
    // on different servers and breaking the `[a-z0-9]` slug. determinism is the
    // contract here, so use the Unicode-default `toLowerCase()`.
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length >= 3 ? slug : "screen";
}

/**
 * Derive a unique screenId from the prompt, disambiguating against a project's
 * existing screens by appending `-2`, `-3`, … (same scheme `create_project`'s
 * `suggestSlug` uses). Deterministic given the project's current screen set — no
 * clock or randomness, so tests are stable.
 */
export function uniqueScreenId(existing: ProjectScreen[], title: string): string {
  const base = slugifyScreen(title);
  const taken = new Set(existing.map((screen) => screen.id));
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    // Keep the whole id within 64 chars even after the suffix.
    const candidate = `${base.slice(0, 64 - `-${suffix}`.length)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/** Entry filename per framework — the primary artifact the manifest points at. */
function entryFileName(framework: ScreenFramework): string {
  switch (framework) {
    case "react":
      return "index.tsx";
    case "vue":
      return "index.vue";
    case "html":
      return "index.html";
  }
}

/**
 * Validate an explicit `kitId` resolves to a real `GENIE_KIT`, mapping every
 * shape `getKit` can reject with — malformed id (Zod), missing kit
 * (`ProjectNotFoundError`), non-kit project (`WrongProjectTypeError`) — onto the
 * single `ERR_KIT_NOT_FOUND` code (mirrors `bind_kit`'s `assertKitExists`).
 */
async function assertExplicitKitExists(kitStore: KitStore, kitId: string): Promise<void> {
  try {
    await getKit(kitStore, { kitId });
  } catch (error) {
    if (
      error instanceof ProjectNotFoundError ||
      error instanceof WrongProjectTypeError ||
      error instanceof z.ZodError
    ) {
      throw new ProjectStoreError("ERR_KIT_NOT_FOUND", `Kit "${kitId}" was not found.`, { kitId });
    }
    throw error;
  }
}

/**
 * Resolve the effective kit for a screen using the D-F ladder. Returns the
 * resolved kit (with provenance) or `null` when nothing resolves. Does *not*
 * decide the kitless error — that depends on the prompt (see `conjureScreen`).
 */
async function resolveKit(
  deps: ConjureScreenDeps,
  project: ProjectDetail,
  explicitKitId: string | undefined,
): Promise<ResolvedKit | null> {
  if (explicitKitId !== undefined) {
    await assertExplicitKitExists(deps.kitStore, explicitKitId);
    return { kitId: explicitKitId, via: "explicit" };
  }
  if (project.defaultKitId) {
    return { kitId: project.defaultKitId, via: "default" };
  }
  if (project.kitBindings.length === 1) {
    const sole = project.kitBindings[0];
    if (sole) return { kitId: sole.kitId, via: "sole" };
  }
  return null;
}

/**
 * Validate `blueprintId` (AC6) resolves to a project of `kind: "blueprint"`,
 * mapping a missing project or a non-blueprint onto `ERR_BLUEPRINT_NOT_FOUND`.
 */
async function assertBlueprint(
  deps: ConjureScreenDeps,
  blueprintId: string,
): Promise<{ id: string }> {
  let detail: ProjectDetail;
  try {
    detail = await deps.projectStore.getProject(blueprintId);
  } catch (error) {
    if (error instanceof ProjectStoreError && error.code === "ERR_PROJECT_NOT_FOUND") {
      throw new ProjectStoreError(
        "ERR_BLUEPRINT_NOT_FOUND",
        `Blueprint "${blueprintId}" was not found.`,
      );
    }
    throw error;
  }
  if (detail.kind !== "blueprint") {
    throw new ProjectStoreError(
      "ERR_BLUEPRINT_NOT_FOUND",
      `Project "${blueprintId}" is a ${detail.kind}, not a blueprint.`,
    );
  }
  return { id: blueprintId };
}

/**
 * Core conjure_screen logic. Exported standalone (bypassing the MCP transport)
 * so programmatic callers get the same validation + resolution as the tool
 * (mirrors `bind_kit`'s `bindKit`).
 *
 * Ordering is deliberate: validate the project (and that it's writable) and the
 * blueprint seed *before* resolving the kit, and resolve the kit *before*
 * generating — so a bad reference fails cheaply, with no artifact written.
 */
export async function conjureScreen(
  deps: ConjureScreenDeps,
  args: unknown,
): Promise<ConjureScreenResult> {
  const parsed = conjureScreenArgsSchema.parse(args);

  // 1. Project must exist and be writable (a screen is a mutation). getProject
  //    throws ProjectStoreError("ERR_PROJECT_NOT_FOUND") for a missing project.
  const project = await deps.projectStore.getProject(parsed.projectId);
  if (!project.canEdit) {
    throw new ProjectStoreError(
      "ERR_PROJECT_READONLY",
      `Project "${parsed.projectId}" is read-only and cannot be modified.`,
      { projectId: parsed.projectId },
    );
  }

  // 2. Blueprint seed (AC6), validated before we spend any generation effort.
  const blueprint = parsed.blueprintId
    ? await assertBlueprint(deps, parsed.blueprintId)
    : undefined;

  // 3. Resolve the kit (AC3).
  const kit = await resolveKit(deps, project, parsed.kitId);

  // 4. Kitless branch: stop for a kit-specific prompt (AC4), scaffold otherwise
  //    (AC5). Never invent a kit.
  if (kit === null && promptRequiresKit(parsed.prompt)) {
    throw new ProjectStoreError("ERR_PROJECT_KIT_REQUIRED", kitRequiredMessage(project), {
      projectId: parsed.projectId,
    });
  }

  // 5. Reserve a unique id + entry path so the manifest entry and returned files
  //    agree (the tool owns layout; the generator owns contents).
  const title = deriveScreenTitle(parsed.prompt);
  const screenId = uniqueScreenId(project.screens, title);
  const entryPath = `screens/${screenId}/${entryFileName(parsed.framework)}`;

  // 6. Generate (M1: offline local scaffold; M2: real endpoint, same seam).
  const generated = await deps.generator.generate({
    projectId: parsed.projectId,
    screenId,
    entryPath,
    prompt: parsed.prompt,
    framework: parsed.framework,
    model: parsed.model,
    kit,
    blueprint,
  });

  // 7. Record the artifact reference in `.genie/project.json` (AC7).
  await deps.projectStore.recordScreen({
    projectId: parsed.projectId,
    screen: { id: screenId, path: entryPath, title },
  });

  return { screenId, files: generated.files, usage: generated.usage };
}

/** Message for `ERR_PROJECT_KIT_REQUIRED`, differentiating the two kitless
 * dead-ends (D-F step 4): nothing bound vs. several bound with no default. */
function kitRequiredMessage(project: ProjectDetail): string {
  const boundKitIds = project.kitBindings.map((binding) => binding.kitId);
  if (boundKitIds.length === 0) {
    return (
      `No kit is bound to project "${project.id}". Bind one with bind_kit or pass an ` +
      `explicit kitId before generating kit-specific components.`
    );
  }
  return (
    `Project "${project.id}" has multiple bound kits (${boundKitIds.join(", ")}) but no ` +
    `default; pass an explicit kitId or set a default kit before generating kit-specific components.`
  );
}

// ── The default M1 generator: deterministic, offline scaffold ─────────────────

/**
 * The M1 generation client: a deterministic, **offline** scaffold generator. It
 * makes no model call — CI needs none (AC8) — and reports zero usage, which is
 * the honest accounting for "no tokens were spent". M2 replaces this with a
 * client that calls the configured endpoint behind the same `ScreenGenerator`
 * interface.
 *
 * Honesty is load-bearing (AC5): a kitless scaffold's banner explicitly says no
 * kit was used; a kit-targeted scaffold names the kit it targets but does *not*
 * claim to have pulled that kit's components (M1 can't — that's M2's gauntlet).
 */
export class LocalScaffoldScreenGenerator implements ScreenGenerator {
  async generate(request: ScreenGenerationRequest): Promise<ScreenGenerationResult> {
    const content = renderScaffold(request);
    return {
      files: [{ path: request.entryPath, content, encoding: "utf-8" }],
      // No model call → no tokens, no cost. Reported honestly (AC8).
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
    };
  }
}

/** A one-line, honest provenance note for the scaffold header comment. */
function provenanceNote(request: ScreenGenerationRequest): string {
  const parts: string[] = [];
  if (request.kit) {
    parts.push(`targeting kit "${request.kit.kitId}" (resolved via ${request.kit.via})`);
  } else {
    parts.push("framework-neutral scaffold — no UI kit was used");
  }
  if (request.blueprint) parts.push(`seeded from blueprint "${request.blueprint.id}"`);
  return parts.join("; ");
}

/** Render the entry artifact for the requested framework. Deterministic — the
 * same request always produces the same bytes. */
function renderScaffold(request: ScreenGenerationRequest): string {
  const title = deriveScreenTitle(request.prompt);
  const note = provenanceNote(request);
  switch (request.framework) {
    case "html":
      return [
        "<!doctype html>",
        `<!-- genie conjure_screen (M1): ${note} -->`,
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        `    <title>${escapeHtml(title)}</title>`,
        "  </head>",
        "  <body>",
        "    <header><h1>" + escapeHtml(title) + "</h1></header>",
        "    <main><!-- generated screen body --></main>",
        "    <footer></footer>",
        "  </body>",
        "</html>",
        "",
      ].join("\n");
    case "vue":
      return [
        `<!-- genie conjure_screen (M1): ${note} -->`,
        "<template>",
        '  <main class="screen">',
        `    <h1>${escapeHtml(title)}</h1>`,
        "    <!-- generated screen body -->",
        "  </main>",
        "</template>",
        "",
        '<script setup lang="ts"></script>',
        "",
      ].join("\n");
    case "react":
      return [
        `// genie conjure_screen (M1): ${note}`,
        "export default function Screen() {",
        "  return (",
        '    <main className="screen">',
        `      <h1>${escapeJsx(title)}</h1>`,
        "      {/* generated screen body */}",
        "    </main>",
        "  );",
        "}",
        "",
      ].join("\n");
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSX text nodes only need `{`, `}`, `<`, `>`, `&` neutralized; the title is
 * plain text so we escape the structural characters that would break parsing. */
function escapeJsx(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[{}]/g, (char) => (char === "{" ? "&#123;" : "&#125;"));
}

/** Output schema mirroring RFC §9.19 (`screenId`, `files[]`, `usage`). */
const conjureScreenOutputShape = {
  screenId: z.string().regex(/^[a-z0-9-]{3,64}$/),
  files: z.array(
    z
      .object({
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf-8", "base64"]),
      })
      .strict(),
  ),
  usage: z
    .object({
      promptTokens: z.number().int().min(0),
      completionTokens: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
      costUsd: z.number().min(0).optional(),
    })
    .strict(),
};

export function registerConjureScreenTool(server: McpServer, deps: ConjureScreenDeps): void {
  server.registerTool(
    CONJURE_SCREEN_TOOL_NAME,
    {
      title: "Conjure screen",
      description:
        "Generate a full-page screen artifact inside a project, constrained by the project's " +
        "bound UI kit. Resolves the kit by explicit kitId, then the project default, then a sole " +
        "reachable binding; a kit-specific prompt with no resolvable kit stops with " +
        "ERR_PROJECT_KIT_REQUIRED rather than inventing one. Records the screen in the project " +
        "manifest and returns its files and token usage.",
      inputSchema: {
        projectId: projectIdSchema,
        prompt: z.string().min(8).max(8192),
        kitId: kitIdSchema.optional(),
        blueprintId: blueprintIdSchema.optional(),
        framework: z.enum(SCREEN_FRAMEWORKS).default("react"),
        model: z.string().min(1).max(128).default("design-default"),
      },
      outputSchema: conjureScreenOutputShape,
    },
    async (args) => {
      try {
        const result = await conjureScreen(deps, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof ProjectStoreError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code: error.code,
                  message: error.message,
                  ...(error.projectId ? { projectId: error.projectId } : {}),
                  ...(error.kitId ? { kitId: error.kitId } : {}),
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
