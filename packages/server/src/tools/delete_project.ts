import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PROJECT_ID_PATTERN, ProjectStore, ProjectStoreError } from "./create_project.js";

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

/**
 * Delete a project through the injected `ProjectStore` (M1-14a-1 / DRO-531 —
 * the `delete_project` store-injection re-plumb).
 *
 * Previously this reached into the filesystem directly via a raw `projectsRoot`
 * path + `node:fs`; it now routes through the same `ProjectStore` instance the
 * rest of the project family (`create_project`/`get_project`/`bind_kit`/
 * `conjure_screen`) already uses, so a non-LocalFs backend injected into
 * `createServer` reaches this verb too. Persistence + read-only policy live in
 * `ProjectStore.deleteProject`; this function owns only the tool's arg-shape
 * validation and result/error shaping.
 *
 * Contract (unchanged from the pre-seam tool):
 *   - Malformed / traversal `projectId` → `ERR_INVALID_PROJECT_ID`, nothing
 *     touched (the Zod schema rejects it before the store is reached).
 *   - Missing project → success with an idempotent "already deleted" warning.
 *   - Read-only project → `ERR_PROJECT_READONLY`, nothing removed.
 *   - Otherwise the project tree is removed and `deletedProjectId` returned.
 */
export async function deleteProject(
  store: ProjectStore,
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

  try {
    const { existed } = await store.deleteProject(parsed.projectId);
    if (!existed) {
      return {
        deletedProjectId: parsed.projectId,
        _meta: {
          warnings: [`Project "${parsed.projectId}" does not exist or was already deleted.`],
        },
      };
    }
    return { deletedProjectId: parsed.projectId };
  } catch (error) {
    // Translate the store's error taxonomy onto the tool's own so both direct
    // callers and the MCP wrapper below keep branching on `DeleteProjectError`.
    if (error instanceof ProjectStoreError && error.code === ERR_PROJECT_READONLY) {
      throw new DeleteProjectError(ERR_PROJECT_READONLY, error.message);
    }
    throw error;
  }
}

export function registerDeleteProjectTool(server: McpServer, store: ProjectStore): void {
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
        const result = await deleteProject(store, args);
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
