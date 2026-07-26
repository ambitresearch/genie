/**
 * MCP tool: bind_kit (M1-20).
 *
 * Attaches a UI kit to a project and optionally marks it the default for
 * screen generation (M1-21, `conjure_screen`, resolves against this).
 *
 * Input:  { projectId: string, kitId: string, default?: boolean }
 * Output: ProjectSummary (same shape `list_projects`/`get_project` return)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PROJECT_ID_PATTERN, ProjectStoreError, projectSummaryShape } from "./create_project.js";
import type { BindKitArgs, ProjectSummary } from "./create_project.js";
import { isSafeKitId, KIT_ID_SAFETY_MESSAGE } from "../store/kit-files.js";

export const BIND_KIT_TOOL_NAME = "mcp__genie__bind_kit";

const projectIdSchema = z
  .string()
  .regex(
    PROJECT_ID_PATTERN,
    "projectId must be a 3-64 character slug containing only lowercase letters, numbers, and hyphens.",
  );

// `projectId` is minted by `create_project`, so the slug shape is a real
// contract there. `kitId` is NOT: it is an opaque, adapter-assigned string and
// `list_kits` promises the ids it returns bind here, so this gates on the
// containment rule the store enforces (see `isSafeKitId`). Gating on the
// create_kit shape made an imported kit like `My_Kit.2` listable but unbindable.
const kitIdSchema = z.string().refine(isSafeKitId, KIT_ID_SAFETY_MESSAGE);

const bindKitArgsSchema = z
  .object({
    projectId: projectIdSchema,
    kitId: kitIdSchema,
    default: z.boolean().optional(),
  })
  .strict();

/**
 * Narrow port `bind_kit` depends on — anything that can bind a kit to a
 * project and return its updated summary. `ProjectStore` (from
 * `create_project.ts`) satisfies this structurally, matching the
 * `ProjectGetStore`/`ProjectListStore` pattern already used by sibling tools.
 */
export interface ProjectBindKitStore {
  bindKit(args: BindKitArgs): Promise<ProjectSummary>;
}

/**
 * Validate args and bind the kit. Exported standalone (bypassing the MCP
 * transport) so programmatic/direct callers get the same validation
 * defense-in-depth as `get_project`'s `getProject()` and `get_kit`'s `getKit()`.
 */
export async function bindKit(store: ProjectBindKitStore, args: unknown): Promise<ProjectSummary> {
  const parsed = bindKitArgsSchema.parse(args);
  return store.bindKit(parsed);
}

export function registerBindKitTool(server: McpServer, store: ProjectBindKitStore): void {
  server.registerTool(
    BIND_KIT_TOOL_NAME,
    {
      title: "Bind kit",
      description:
        "Attach a UI kit to a workspace or blueprint project, optionally marking it the " +
        "default kit for screen generation. Binding the same kit twice updates the existing " +
        "binding in place. Setting default: true clears default status from every other " +
        "binding on the project. Typically precedes conjure_screen, which resolves its kit " +
        "from these bindings when no explicit kitId is given.",
      inputSchema: {
        projectId: projectIdSchema,
        kitId: kitIdSchema,
        default: z.boolean().optional(),
      },
      outputSchema: projectSummaryShape,
    },
    async (args) => {
      try {
        const result = await bindKit(store, args);
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
