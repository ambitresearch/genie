import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const DELETE_PROJECT_TOOL_NAME = "mcp__genie__delete_project";

export const ERR_PROJECT_READONLY = "ERR_PROJECT_READONLY";

const deleteProjectArgsSchema = z
  .object({
    projectId: z.string().min(1),
  })
  .strict();

export type DeleteProjectArgs = z.infer<typeof deleteProjectArgsSchema>;

export interface DeleteProjectResult extends Record<string, unknown> {
  deletedProjectId: string;
  _meta?: {
    warnings?: string[];
  };
}

export class DeleteProjectError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeleteProjectError";
    this.code = code;
  }
}

export async function deleteProject(
  root: string,
  args: DeleteProjectArgs,
): Promise<DeleteProjectResult> {
  const parsed = deleteProjectArgsSchema.parse(args);
  const projectRoot = join(root, parsed.projectId);

  // Check if project exists
  if (!existsSync(projectRoot)) {
    return {
      deletedProjectId: parsed.projectId,
      _meta: {
        warnings: [`Project "${parsed.projectId}" does not exist or was already deleted.`],
      },
    };
  }

  // Check if project is read-only
  const readonlyMarker = join(projectRoot, ".genie", ".readonly");
  if (existsSync(readonlyMarker)) {
    throw new DeleteProjectError(
      ERR_PROJECT_READONLY,
      `Project "${parsed.projectId}" is read-only and cannot be deleted.`,
    );
  }

  // Delete the project directory recursively
  await rm(projectRoot, { recursive: true, force: true });

  return {
    deletedProjectId: parsed.projectId,
  };
}

export function registerDeleteProjectTool(server: McpServer, projectsRoot: string): void {
  server.registerTool(
    DELETE_PROJECT_TOOL_NAME,
    {
      title: "Delete project",
      description:
        "Delete a workspace or blueprint project. Deleting a blueprint does not delete derived workspaces.",
      inputSchema: {
        projectId: z.string().min(1),
      },
      outputSchema: {
        deletedProjectId: z.string(),
        _meta: z
          .object({
            warnings: z.array(z.string()).optional(),
          })
          .optional(),
      },
    },
    async (args) => {
      try {
        const result = await deleteProject(projectsRoot, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof DeleteProjectError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  code: error.code,
                  message: error.message,
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
