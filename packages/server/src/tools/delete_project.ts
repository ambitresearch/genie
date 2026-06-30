import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PROJECT_ID_PATTERN } from "./create_project.js";

export const DELETE_PROJECT_TOOL_NAME = "mcp__genie__delete_project";

export const ERR_PROJECT_READONLY = "ERR_PROJECT_READONLY";
export const ERR_INVALID_PROJECT_ID = "ERR_INVALID_PROJECT_ID";

const projectIdSchema = z
  .string()
  .regex(
    PROJECT_ID_PATTERN,
    "projectId must be a 3-64 character slug containing only lowercase letters, numbers, and hyphens.",
  );

const deleteProjectArgsSchema = z
  .object({
    projectId: projectIdSchema,
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
  let parsed: DeleteProjectArgs;
  try {
    parsed = deleteProjectArgsSchema.parse(args);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      throw new DeleteProjectError(
        ERR_INVALID_PROJECT_ID,
        issue?.message ??
          "projectId must be a 3-64 character slug containing only lowercase letters, numbers, and hyphens.",
      );
    }
    throw error;
  }
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
        projectId: projectIdSchema,
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
