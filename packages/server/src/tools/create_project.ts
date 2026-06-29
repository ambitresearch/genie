import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectStore, ProjectStoreError } from "../project-store.js";

export const CREATE_PROJECT_TOOL_NAME = "mcp__genie__create_project";

export function registerCreateProjectTool(server: McpServer, projectStore: ProjectStore): void {
  server.registerTool(
    CREATE_PROJECT_TOOL_NAME,
    {
      title: "Create project",
      description:
        "Create a genie workspace, create a reusable blueprint, or instantiate a workspace from a blueprint.",
      inputSchema: {
        name: z.string().min(1).max(128),
        kind: z.enum(["workspace", "blueprint"]),
        fromBlueprintId: z.string().min(1).max(64).optional(),
        kitBindings: z
          .array(
            z.object({
              kitId: z.string().min(1),
              default: z.boolean().optional(),
            }),
          )
          .max(32)
          .optional(),
      },
      outputSchema: {
        projectId: z.string(),
      },
    },
    async (args) => {
      try {
        const result = await projectStore.createProject(args);
        return {
          structuredContent: { projectId: result.projectId },
          content: [{ type: "text", text: `Created project ${result.projectId}` }],
        };
      } catch (error) {
        if (error instanceof ProjectStoreError) {
          throw new McpError(ErrorCode.InvalidParams, error.message, {
            code: error.code,
            details: error.details,
          });
        }
        throw error;
      }
    },
  );
}
