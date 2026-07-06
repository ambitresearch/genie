/**
 * MCP tool: get_project (M1-17).
 *
 * Metadata read for a single workspace or blueprint project manifest.
 * Blueprints are returned through the same shape (`kind: "blueprint"`) — there is
 * no special-case tool family for them (AC4).
 *
 * Input:  { projectId: string }
 * Output: ProjectSummary & { screens: ProjectScreen[]; sourceBlueprintId?: string }
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PROJECT_ID_PATTERN,
  ProjectStoreError,
  projectScreenShape,
  projectSummaryShape,
} from "./create_project.js";
import type { ProjectDetail } from "./create_project.js";

export const GET_PROJECT_TOOL_NAME = "mcp__genie__get_project";

/** Error code raised when `projectId` does not resolve to an existing project. */
export const ERR_PROJECT_NOT_FOUND = "ERR_PROJECT_NOT_FOUND" as const;

const projectIdSchema = z
  .string()
  .regex(
    PROJECT_ID_PATTERN,
    "projectId must be a 3-64 character slug containing only lowercase letters, numbers, and hyphens.",
  );

const getProjectArgsSchema = z
  .object({
    projectId: projectIdSchema,
  })
  .strict();

export type GetProjectArgs = z.infer<typeof getProjectArgsSchema>;

/** Raw shape (not a constructed ZodObject) — matches how every other tool in this
 * repo declares `outputSchema` (see get_kit.ts, delete_project.ts, list_files.ts). */
const projectDetailShape = {
  ...projectSummaryShape,
  screens: z.array(z.object(projectScreenShape).strict()),
  sourceBlueprintId: z.string().optional(),
};

const projectDetailSchema = z.object(projectDetailShape).strict();

/**
 * Narrow port `get_project` depends on — anything that can resolve a single
 * project's full detail. `ProjectStore` (from `create_project.ts`) satisfies this
 * structurally, matching the `ProjectListStore` pattern already used by `list_projects`.
 */
export interface ProjectGetStore {
  getProject(projectId: string): Promise<ProjectDetail>;
}

/**
 * Validate args and fetch project detail. Exported standalone (bypassing the MCP
 * transport) so programmatic/direct callers get the same validation defense-in-depth
 * as `list_files`' `listFiles()` and `get_kit`'s `getKit()`.
 */
export async function getProject(
  store: ProjectGetStore,
  args: unknown,
): Promise<ProjectDetail> {
  const { projectId } = getProjectArgsSchema.parse(args);
  const detail = await store.getProject(projectId);
  return projectDetailSchema.parse(detail);
}

export function registerGetProjectTool(server: McpServer, store: ProjectGetStore): void {
  server.registerTool(
    GET_PROJECT_TOOL_NAME,
    {
      title: "Get project",
      description:
        "Return metadata for one genie workspace or blueprint project, including its " +
        "kit bindings, recorded screens, and canEdit status. Blueprints use the same " +
        'shape as workspaces (kind: "blueprint") — there is no separate tool family. ' +
        "Typically follows list_projects; check kitBindings here before bind_kit or conjure_screen.",
      inputSchema: {
        projectId: projectIdSchema,
      },
      outputSchema: projectDetailShape,
    },
    async (args) => {
      try {
        const result = await getProject(store, args);
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
