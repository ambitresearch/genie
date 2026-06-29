import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectStore } from "../store/interface.js";
import { BlueprintNotFoundError, ProjectExistsError } from "../store/interface.js";

/**
 * Register the `create_project` tool on the MCP server.
 *
 * Creates blank workspaces, reusable blueprint projects, and workspaces
 * instantiated from an existing blueprint (snapshot copy).
 */
export function registerCreateProject(
  server: McpServer,
  store: ProjectStore,
): void {
  server.registerTool(
    "create_project",
    {
      title: "Create Project",
      description:
        "Create a blank workspace, a reusable blueprint, or a workspace " +
        "instantiated from an existing blueprint. Blueprints are templates " +
        "whose starter files and kit bindings are snapshot-copied into the " +
        "new workspace at creation time.",
      inputSchema: {
        name: z.string().min(1).describe("Human-readable project name."),
        kind: z
          .enum(["workspace", "blueprint"])
          .describe('"workspace" for a screen workspace, "blueprint" for a reusable template.'),
        fromBlueprintId: z
          .string()
          .optional()
          .describe("ID of an existing blueprint to instantiate from."),
        kitBindings: z
          .array(
            z.object({
              kitId: z.string().describe("Kit identifier."),
              alias: z.string().optional().describe("Optional alias for the kit binding."),
            }),
          )
          .optional()
          .describe("Kit bindings for the project."),
      },
    },
    async ({ name, kind, fromBlueprintId, kitBindings }) => {
      try {
        const project = await store.createProject({
          name,
          kind,
          fromBlueprintId,
          kitBindings,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(project, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        if (err instanceof ProjectExistsError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: err.code,
                  message: err.message,
                  suggestedSlug: err.suggestedSlug,
                }),
              },
            ],
          };
        }
        if (err instanceof BlueprintNotFoundError) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: err.code,
                  message: err.message,
                }),
              },
            ],
          };
        }
        throw err;
      }
    },
  );
}
