import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PROJECT_ID_PATTERN } from "./create_project.js";
import type { ProjectSummary } from "./create_project.js";

export const LIST_PROJECTS_TOOL_NAME = "mcp__genie__list_projects";

export interface ProjectListStore {
  listProjects(): Promise<ProjectSummary[]>;
}

export interface ProjectListBackend extends ProjectListStore {
  name: string;
}

export interface ProjectListWarning extends Record<string, unknown> {
  code: "ERR_BACKEND_UNREACHABLE";
  message: string;
  backend: string;
}

export interface ListProjectsResult extends Record<string, unknown> {
  projects: ProjectSummary[];
}

const listProjectsArgsSchema = z.object({}).strict();

export class ProjectBackendUnreachableError extends Error {
  constructor(
    readonly code: "ERR_BACKEND_UNREACHABLE",
    message: string,
  ) {
    super(message);
    this.name = "ProjectBackendUnreachableError";
  }
}

const projectSummarySchema = {
  id: z.string().regex(PROJECT_ID_PATTERN),
  name: z.string(),
  kind: z.enum(["workspace", "blueprint"]),
  defaultKitId: z.string().optional(),
  kitBindings: z.array(
    z
      .object({
        kitId: z.string().min(1),
        default: z.boolean().optional(),
      })
      .strict(),
  ),
  updatedAt: z.string(),
  canEdit: z.boolean(),
};

export function registerListProjectsTool(
  server: McpServer,
  localStore: ProjectListStore,
  additionalBackends: ProjectListBackend[] = [],
): void {
  server.registerTool(
    LIST_PROJECTS_TOOL_NAME,
    {
      title: "List projects",
      description:
        "List genie workspace and blueprint projects visible to this server. " +
        "Read-only and idempotent; returns local results even if an optional git-host backend is unreachable.",
      inputSchema: listProjectsArgsSchema,
      outputSchema: {
        projects: z.array(z.object(projectSummarySchema).strict()),
      },
    },
    async (args) => {
      listProjectsArgsSchema.parse(args);
      const projects = [...(await localStore.listProjects())];
      const warnings: ProjectListWarning[] = [];
      for (const backend of additionalBackends) {
        try {
          projects.push(...(await backend.listProjects()));
        } catch (error) {
          warnings.push(toBackendWarning(backend.name, error));
        }
      }

      const result: ListProjectsResult = { projects: sortProjects(projects) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        ...(warnings.length > 0 ? { _meta: { warnings } } : {}),
      };
    },
  );
}

function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort(
    (a, b) => compareText(a.kind, b.kind) || compareText(a.name, b.name) || compareText(a.id, b.id),
  );
}

function compareText(a: string, b: string): number {
  const aNorm = a.normalize("NFC").toLowerCase();
  const bNorm = b.normalize("NFC").toLowerCase();
  return aNorm < bNorm ? -1 : aNorm > bNorm ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

function toBackendWarning(backend: string, error: unknown): ProjectListWarning {
  if (error instanceof ProjectBackendUnreachableError) {
    return {
      code: error.code,
      message: error.message,
      backend,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "ERR_BACKEND_UNREACHABLE",
    message: `Project backend "${backend}" unreachable; showing local projects only. ${message}`,
    backend,
  };
}
