/**
 * list_projects — read-only project discovery tool.
 *
 * Returns all reachable projects (workspaces and blueprints), deterministically
 * sorted by kind → name → id. When a remote backend is unreachable, local
 * results still return with `_meta.warnings`.
 *
 * @see docs/github/issues/M1-16-tool-list-projects.md
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Project, ProjectStore, StoreWarning } from "../store/interface.js";

/** Deterministic sort: kind asc → name asc → id asc (JS < operator, no locale awareness). */
function sortProjects(projects: Project[]): Project[] {
  return projects.slice().sort((a, b) => {
    const kindCmp = a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    if (kindCmp !== 0) return kindCmp;
    const nameCmp = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    if (nameCmp !== 0) return nameCmp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Build the MCP text content payload. */
function buildContent(projects: Project[], warnings: StoreWarning[]) {
  const payload: Record<string, unknown> = { projects: sortProjects(projects) };
  if (warnings.length > 0) {
    payload._meta = { warnings };
  }
  return [{ type: "text" as const, text: JSON.stringify(payload) }];
}

/** Register the `mcp__genie__list_projects` tool on the given MCP server. */
export function registerListProjects(
  server: McpServer,
  store: ProjectStore,
): void {
  server.registerTool(
    "mcp__genie__list_projects",
    {
      title: "List Projects",
      description:
        "List all projects (workspaces and blueprints). Returns each project's " +
        "id, name, kind, defaultKitId, kitBindings, updatedAt, and canEdit. " +
        "Results are sorted by kind, then name, then id.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const [projects, warnings] = await store.listProjects();
      return { content: buildContent(projects, warnings) };
    },
  );
}
