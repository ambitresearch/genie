# DRO-565 — Route `write_files` onto a `KitStore` write primitive

> Design note for **[M1-14a-1b]** _Route `write_files` onto a KitStore write primitive
> (last store-injection holdout)_. Owner: Voss Rivet (`e2790d9a`).
> Status: **blocked** on DRO-523 / PR #114 (foundation) + one maintainer design decision.
> This note is the "own design + review" the issue itself calls for. It is written so
> implementation is a mechanical follow-through once the two gates below clear.

## 1. Why this is not a mechanical swap

`write_files` (`packages/server/src/tools/write_files.ts`) is the one M1 write/delete verb
still bound to a raw `kitsRoot` + `node:fs`, unlike the four siblings already routed through
an injected store on DRO-523's branch. Re-plumbing it is not a swap because of **two
independent gates**, one temporal and one semantic.

### Gate A — the foundation is unmerged (temporal, hard blocker)

Everything DRO-565's description treats as _already shipped_ lives **only on branch
`DRO-523-m1-14a-ac5-…` (open PR #114 → `main`)**, which is `MERGEABLE`/`CLEAN` with all
9 CI checks green but **not yet merged**:

| Prerequisite DRO-565 assumes | Introduced by | Present on `main`? |
| --- | --- | --- |
| `createServer({ kitStore?, projectStore? })` injection seam | DRO-531 (`bb26474`) | **No** |
| `KitStore.deleteFile()` write-sibling primitive to mirror | DRO-540 (`5ef203d`) | **No** |
| Rich `KitFileEntry` / `KitFileContent` return types | DRO-540 | **No** |
| `read_file`/`list_files`/`delete_files` on injected `kitStore` | DRO-540 | **No** |
| `packages/server/test/server-store-injection.test.ts` (Scope 3 says "extend") | DRO-531/540 | **No** |
| The `server.ts` L84–85 caveat the issue quotes verbatim | DRO-540 | **No** |

This worktree is based on `main` @ `d053a4b` with **0 unique commits**. All three Scope items
touch exactly the files PR #114 rewrites (`store/interface.ts`, `store/local.ts`,
`store/git-host.ts`, `server.ts`, and the brand-new `server-store-injection.test.ts`).
Building DRO-565 on `main` would (a) force re-implementing DRO-531+DRO-540 first, and
(b) guarantee a head-on merge conflict with #114. **DRO-565 must be based on merged `main`
_after_ #114 lands**, not on today's `main`.

### Gate B — routing onto `KitStore` rewrites a shipped destination contract (semantic decision)

The shipped tool writes to the **harness-local working directory**, not the kit:

```
// tools/write_files.ts  (shipped)
return stageAndCommit(args.files, resolvedLocalPaths, plan.localDir);   // L572
const destPath = resolve(localDir, file.path);                          // L651  → plan.localDir
```

33 tests in `write_files.test.ts` + `write_files.rollback.test.ts` assert this
(`readFile(join(localDir, "components", "Button.html"))`, etc.).

But Scope 1 asks for "a write primitive that **both** `LocalFsKitStore` … **and**
`GitHostKitStore` … can honor." A `GitHostKitStore` has no `localDir` — it can only commit
into the **kit repo**. RFC §4 (`04-tech-design-rfc.md` L240) confirms the store-native model:

> For git host HTTP, `kitId` = repo, `planId` = branch, **`write_files` = git commits**, merge = atomic publish.

So a KitStore write primitive is inherently **kit-tree-destined** (`plan.kitId`), symmetric
with how `delete_files` already routes (`store.deleteFile(plan.kitId, path)`). Routing
`write_files` onto it therefore **changes the destination from `plan.localDir` to the kit
tree** — a rewrite of the shipped contract, not a refactor. That is the design decision the
maintainer must ratify before code is written; it is out of scope for an agent to flip a
shipped, tested contract unilaterally.

**Two coherent resolutions (pick one):**

- **B1 — Kit-destined (recommended, matches RFC §L240 + `delete_files` symmetry).**
  `write_files` writes into the kit tree via the plan branch. `plan.localDir` keeps its
  current, narrower job: the **source** root that `localPath` reads resolve against
  (unchanged), while the **destination** becomes the kit. This is the only reading under
  which "both adapters honor it" is true. Requires updating the 33 shipped tests' destination
  assertions from `localDir` to the kit surface, and a migration note in the PR.

- **B2 — Keep localDir-destined, make the primitive local-only.** Then `GitHostKitStore`
  cannot implement it (throws `UnsupportedOperationError`), Scope 1's "both adapters" clause
  is unmet, and the store abstraction leaks. Rejected — it defeats the issue's own goal.

## 2. Proposed primitive (assuming B1)

Mirror the `deleteFile` sibling shipped on DRO-523, but as an **atomic batch** (write_files is
all-or-nothing across ≤256 files — a per-file primitive cannot preserve AC10):

```ts
// store/interface.ts — added to interface KitStore
/**
 * Atomically write a batch of files into a kit's readable surface.
 * All-or-nothing (AC10): either every op lands or the kit tree is byte-for-byte
 * restored to its pre-call state. Plan-gating (which paths, byte cap, duplicate
 * detection, localPath streaming/containment) stays in the write_files TOOL;
 * this primitive only performs the authorized physical commit.
 *   - LocalFsKitStore: rename-to-temp / rename-back transaction under the kit dir
 *     (lift the shipped stageAndCommit/commitStaged, re-anchored on the kit root).
 *   - GitHostKitStore: commit the batch onto plan branch `plan/${planId}`, then the
 *     tool's existing commit path publishes — atomicity = a single branch commit.
 * Throws WriteFailedError / RollbackIncompleteError exactly as shipped.
 */
writeFiles(kitId: KitId, ops: WriteOp[]): Promise<{ writtenPaths: string[] }>;

// WriteOp carries already-resolved bytes/stream handle — NOT localPath (the tool
// resolves + streams + containment-checks localPath before calling the store, so
// file contents never enter model context and the store stays fs-source-agnostic).
export type WriteOp = { path: string; content: Buffer };
```

Note: streaming from `localPath` (AC: large-file safe) is a **tool-side** concern — the tool
streams source→staging, then hands the store staged bytes/paths. Keeping `localPath` out of
the store interface preserves the "contents never enter model context" invariant and lets the
GitHost adapter stay a pure contents-API client.

## 3. Implementation checklist (on unblock)

1. Rebase this branch onto `main` **after PR #114 merges**.
2. `store/interface.ts`: add `writeFiles(kitId, ops)` + `WriteOp`; doc the atomicity contract.
3. `store/local.ts`: implement by lifting shipped `stageAndCommit`/`commitStaged`/
   `tryRenameIfExists` from the tool, re-anchored on `kitDir(kitId)` (same-filesystem rename
   still holds — stage under `<kitDir>/.genie-tmp/`).
4. `store/git-host.ts`: implement via `applyOps(kitId, plan/${planId}, ops)` (already exists
   for `openPlan`/`commitPlan`) — the write path is a branch commit.
5. `tools/write_files.ts`: keep all plan-gating/validation/streaming; replace the direct
   fs `stageAndCommit` call with `kitStore.writeFiles(plan.kitId, stagedOps)`. Signature
   `registerWriteFilesTool(server, kitStore)` (same shape as `registerDeleteFilesTool`).
6. `server.ts`: `registerWriteFilesTool(server, kitStore)` — drop the `kitsRoot`-only call;
   remove the L84–85 "last holdout" caveat.
7. Tests:
   - `store-conformance.test.ts`: add write-primitive cases to `kitStoreContract` (runs on
     **both** LocalFs + GitHost adapters) — happy path, overwrite+restore-on-failure, batch atomicity.
   - `server-store-injection.test.ts`: seam test proving MCP `write_files` routes through an
     injected spy store (mirrors the delete_files seam test).
   - Update the 33 destination assertions in `write_files*.test.ts` per decision B1.

## 4. Blocking status & unblock owner

- **Blocked-by:** DRO-523 (PR #114) must merge to `main` first — first-class blocker recorded
  on the issue.
- **Decision owner:** repo maintainer (`roshangautam`) — ratify destination decision **B1 vs B2**.
- **Not blocking anything:** confirmed — `write_files` has zero references in DRO-523's AC5
  conformance walk (`gitea-conformance.test.ts`), and no other open M1 issue depends on it.
- **Sibling follow-up worth its own issue:** a rich `GitHostProjectStore`
  (blueprints/kitBindings/screens/canEdit), noted in the DRO-565 description.
