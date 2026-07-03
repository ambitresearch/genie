/**
 * In-memory git-host (Gitea-shaped) REST mock.
 *
 * Extracted verbatim from `store-conformance.test.ts` so the store-contract
 * suite AND the createServer store-injection seam test (DRO-523 AC1) drive the
 * SAME reference git host, rather than maintaining two drifting copies of a
 * ~170-line fetch mock. It simulates just enough of the Gitea `/api/v1` surface
 * that `GitHostKitStore` / `GitHostProjectStore` exercise:
 *   - GET  /repos/search
 *   - GET/POST /repos/:owner/:repo
 *   - POST /orgs/:owner/repos
 *   - POST/GET/DELETE /repos/:owner/:repo/branches[/:branch]
 *   - GET/POST/PUT/DELETE /repos/:owner/:repo/contents/:path (per-branch files)
 *
 * Files are keyed by `${owner}/${repo}` AND branch, so plan-branch writes never
 * leak into reads against the default branch — the same isolation a real git
 * host gives, which the store contract's "readFile rejects plan-staged files"
 * test depends on.
 *
 * This is a hermetic stand-in for the real `gitea/gitea` testcontainer (AC5):
 * it lets the seam be proven end-to-end WITHOUT a Docker daemon, which the
 * Docker-gated live walk then re-confirms against a genuine Gitea when Docker
 * is available. It is a *mock*, not a substitute for that container leg — see
 * the AC5 fixture.
 */

/** A `fetch`-shaped function backed by an in-memory git host. */
export type MockFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Build a fresh, isolated in-memory git host and return a `fetch` implementation
 * bound to it. Each call gets its own repo/file/branch maps, so tests never
 * share mutable state.
 */
export function createMockGitHostFetch(): MockFetch {
  // In-memory storage for repos, files, branches.
  const repos = new Map<string, { name: string; created_at: string; default_branch: string }>();
  const files = new Map<string, Map<string, Map<string, { content: string; sha: string }>>>();
  const branches = new Map<string, Set<string>>();

  const filesFor = (repoKey: string, branch: string) => {
    let perBranch = files.get(repoKey);
    if (!perBranch) {
      perBranch = new Map();
      files.set(repoKey, perBranch);
    }
    let perFile = perBranch.get(branch);
    if (!perFile) {
      perFile = new Map();
      perBranch.set(branch, perFile);
    }
    return perFile;
  };

  return async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    // Parse URL - strip /api/v1 prefix since the baseUrl includes it
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.replace(/^\/api\/v1/, "");
    const pathParts = pathname.split("/").filter(Boolean);
    const refParam = urlObj.searchParams.get("ref");

    // Helper to generate SHA
    const genSha = () => Math.random().toString(36).substring(2);

    // Route: GET /repos/search
    if (method === "GET" && pathParts[0] === "repos" && pathParts[1] === "search") {
      const data = Array.from(repos.values());
      return new Response(JSON.stringify({ data }), { status: 200 });
    }

    // Route: GET/POST /repos/:owner/:repo
    if (pathParts[0] === "repos" && pathParts.length === 3) {
      const [, owner, repo] = pathParts;
      const key = `${owner}/${repo}`;
      if (method === "GET") {
        if (!repos.has(key)) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return new Response(JSON.stringify(repos.get(key)), { status: 200 });
      }
    }

    // Route: POST /orgs/:owner/repos
    if (
      method === "POST" &&
      pathParts[0] === "orgs" &&
      pathParts.length === 3 &&
      pathParts[2] === "repos"
    ) {
      const [, owner] = pathParts;
      const { name } = body;
      const key = `${owner}/${name}`;
      if (repos.has(key)) {
        return new Response(JSON.stringify({ message: "Repository already exists" }), {
          status: 409,
        });
      }
      const repo = { name, created_at: new Date().toISOString(), default_branch: "main" };
      repos.set(key, repo);
      // Seed the default branch with an empty file map.
      filesFor(key, "main");
      branches.set(key, new Set(["main"]));
      return new Response(JSON.stringify(repo), { status: 201 });
    }

    // Route: POST /repos/:owner/:repo/branches  (4 path segments)
    if (
      method === "POST" &&
      pathParts.length === 4 &&
      pathParts[0] === "repos" &&
      pathParts[3] === "branches"
    ) {
      const [, owner, repo] = pathParts;
      const key = `${owner}/${repo}`;
      if (!repos.has(key)) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      const { new_branch_name, old_branch_name } = body;
      branches.get(key)?.add(new_branch_name);
      // Copy files from the source branch so the new branch starts as a fork.
      const source = filesFor(key, old_branch_name ?? "main");
      const target = filesFor(key, new_branch_name);
      for (const [path, entry] of source) target.set(path, { ...entry });
      return new Response(JSON.stringify({ name: new_branch_name }), { status: 201 });
    }

    // Route: GET /repos/:owner/:repo/branches/:branch  (5 path segments)
    if (
      method === "GET" &&
      pathParts.length === 5 &&
      pathParts[0] === "repos" &&
      pathParts[3] === "branches"
    ) {
      const [, owner, repo, , branch] = pathParts;
      const key = `${owner}/${repo}`;
      if (!branches.get(key)?.has(decodeURIComponent(branch))) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response(JSON.stringify({ name: branch }), { status: 200 });
    }

    // Route: DELETE /repos/:owner/:repo/branches/:branch  (5 path segments)
    if (
      method === "DELETE" &&
      pathParts.length === 5 &&
      pathParts[0] === "repos" &&
      pathParts[3] === "branches"
    ) {
      const [, owner, repo, , branch] = pathParts;
      const key = `${owner}/${repo}`;
      const decoded = decodeURIComponent(branch);
      branches.get(key)?.delete(decoded);
      files.get(key)?.delete(decoded);
      return new Response(null, { status: 204 });
    }

    // Route: GET/POST/PUT/DELETE /repos/:owner/:repo/contents/:path
    if (pathParts[3] === "contents") {
      const [, owner, repo, , ...pathSegments] = pathParts;
      const key = `${owner}/${repo}`;
      const filePath = decodeURIComponent(pathSegments.join("/"));

      if (!repos.has(key)) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      // ref query param wins; for writes, fall back to body.branch; else default.
      const branch =
        refParam ??
        (body && typeof body === "object" && "branch" in body
          ? (body as { branch: string }).branch
          : repos.get(key)!.default_branch);
      if (!branches.get(key)?.has(branch)) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      const repoFiles = filesFor(key, branch);

      if (method === "GET") {
        // Build a `file` entry for a full path.
        const entryFor = (path: string) => ({
          type: "file" as const,
          name: path.split("/").pop()!,
          path,
          sha: repoFiles.get(path)!.sha,
          size: Buffer.from(repoFiles.get(path)!.content, "base64").length,
        });

        // Immediate children of `prefix` (""=root): direct files as `file`
        // entries, and first-level subdirectories as unique `dir` entries. The
        // real Gitea contents API returns BOTH at each directory level, which is
        // what GitHostKitStore.listTree recurses through — a files-only mock
        // would silently hide every nested file.
        const listDir = (prefix: string) => {
          const base = prefix ? `${prefix}/` : "";
          const files: Array<ReturnType<typeof entryFor>> = [];
          const dirs = new Map<string, { type: "dir"; name: string; path: string }>();
          for (const path of repoFiles.keys()) {
            if (base && !path.startsWith(base)) continue;
            const rest = path.substring(base.length);
            if (!rest) continue;
            const slash = rest.indexOf("/");
            if (slash === -1) {
              files.push(entryFor(path));
            } else {
              const dirName = rest.substring(0, slash);
              const dirPath = `${base}${dirName}`;
              if (!dirs.has(dirPath)) {
                dirs.set(dirPath, { type: "dir", name: dirName, path: dirPath });
              }
            }
          }
          return [...files, ...dirs.values()];
        };

        // If filePath is empty, return the root directory listing.
        if (!filePath || filePath === "") {
          return new Response(JSON.stringify(listDir("")), { status: 200 });
        }
        // A directory path has children under `filePath/`.
        const hasChildren = Array.from(repoFiles.keys()).some((path) =>
          path.startsWith(filePath + "/"),
        );
        if (hasChildren && !repoFiles.has(filePath)) {
          return new Response(JSON.stringify(listDir(filePath)), { status: 200 });
        }
        // It's a file
        if (!repoFiles.has(filePath)) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        const file = repoFiles.get(filePath)!;
        return new Response(
          JSON.stringify({
            type: "file",
            name: filePath.split("/").pop(),
            path: filePath,
            content: file.content,
            encoding: "base64",
            sha: file.sha,
            size: Buffer.from(file.content, "base64").length,
          }),
          { status: 200 },
        );
      }

      if (method === "POST" || method === "PUT") {
        const { content } = body;
        const sha = genSha();
        repoFiles.set(filePath, { content, sha });
        return new Response(JSON.stringify({ content: { sha } }), {
          status: method === "POST" ? 201 : 200,
        });
      }

      if (method === "DELETE") {
        repoFiles.delete(filePath);
        return new Response(null, { status: 204 });
      }
    }

    // Default 404
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
}
