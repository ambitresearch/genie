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
import type { ProjectStore } from "../store/interface.js";
import type { Project, StoreWarning } from "../store/interface.js";

/** Deterministic sort: kind asc → name asc → id asc. */
function sortProjects(projects: Project[]): Project[] {
  return projects.slice().sort((a, b) => {
    const kindCmp = a.kind.localeCompare(b.kind);
    if (kindCmp !== 0) return kindCmp;
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    return a.id.localeCompare(b.id);
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

/** Register the `list_projects` tool on the given MCP server. */
export function registerListProjects(
  server: McpServer,
  store: ProjectStore,
): void {
  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "List all projects (workspaces and blueprints). Returns each project's " +
        "id, name, kind, defaultKitId, kitBindings, updatedAt, and canEdit. " +
        "Results are sorted by kind, then name, then id.",
      inputSchema: {},
    },
    async () => {
      const [projects, warnings] = await store.listProjects();
      return { content: buildContent(projects, warnings) };
    },
  );
}
