/**
 * Storage abstraction for genie kits and projects.
 *
 * All M1 tools are implemented against these interfaces, not against `fs`
 * directly. Two adapters ship with M1:
 *   - LocalFsStore  — solo dev; kit/project = directory on local FS
 *   - GitHostStore  — shared; kit/project = git-tracked tree on any git host
 */

// ─── Shared types ────────────────────────────────────────────────────────────

/** Immutable type discriminator stamped on every kit record. */
export const KIT_TYPE = "GENIE_KIT" as const;

/** Unique identifier for a kit (opaque string, adapter-assigned). */
export type KitId = string;

/** Unique identifier for a project (opaque string, adapter-assigned). */
export type ProjectId = string;

/**
 * A plan is a staging area for multi-file edits before they are committed.
 * In LocalFsStore it maps to a temp directory; in GitHostStore it maps to a
 * branch (`plan/${planId}`).
 */
export type PlanId = string;

/** Metadata returned when listing or getting a kit. */
export interface KitMeta {
  id: KitId;
  name: string;
  type: typeof KIT_TYPE;
  createdAt: string; // ISO-8601
}

/** Metadata returned when listing or getting a project. */
export interface ProjectMeta {
  id: ProjectId;
  name: string;
  kitId?: KitId;
  createdAt: string; // ISO-8601
}

/** Component entry returned by listComponents. */
export interface ComponentEntry {
  name: string;
  group: string;
  path: string;
  viewport: string;
  hash: string;
  lastModified: string; // ISO-8601
}

/** Encoding of a file's bytes as carried over the wire by `readFile`. */
export type FileEncoding = "utf-8" | "base64";

/**
 * Rich result of `KitStore.readFile` — the shape the `read_file` MCP tool
 * returns verbatim (RFC §9). MIME resolution + text/binary classification live
 * in the store (see `kit-files.ts`), so a `read_file` call is byte-identical
 * whichever adapter backs it:
 *   - `encoding: "utf-8"`  → `content` is the decoded text.
 *   - `encoding: "base64"` → `content` is base64 (binary files).
 * The 256 KiB cap (`MAX_FILE_BYTES`) is enforced by the store, which throws
 * `FileTooLargeError` before returning; the tool maps that onto its wire error.
 */
export interface KitFileContent {
  content: string;
  encoding: FileEncoding;
  mimeType: string;
}

/**
 * Rich per-file entry returned by `KitStore.listFiles` — the shape the
 * `list_files` MCP tool returns (RFC §9). Carries a Subresource-Integrity
 * hash (`sha256-<base64>`), byte size, and an ISO-8601 modification time.
 *
 * ── git-host `lastModified` parity (AC / DRO-540) ─────────────────────────────
 * `lastModified` is defined per-adapter and the granularity deliberately
 * differs:
 *   - `LocalFsKitStore` uses each file's real filesystem `mtime` — true
 *     per-file granularity.
 *   - `GitHostKitStore` uses the repository's last-update timestamp
 *     (`updated_at`, falling back to `created_at`) for EVERY entry in a
 *     listing — per-*repo* granularity, not per-file.
 * The reason is cost: the Gitea contents API (`GET …/contents/<path>`) carries
 * `sha`/`size` but no dependable per-file commit time across Gitea versions.
 * True per-file times would require a commits-API query per file
 * (`GET …/commits?path=<file>&limit=1`) — an N+1 fan-out over a whole kit tree.
 * The single repo-metadata read is the honest, cheap parity: "these files were
 * last touched no earlier than the repo's last push." Both satisfy the ISO-8601
 * contract; callers that need per-file precision on a git host must opt into the
 * commits API (a tracked follow-up, intentionally out of scope here).
 */
export interface KitFileEntry {
  path: string;
  size: number;
  hash: string; // Subresource-Integrity form: "sha256-<base64>"
  lastModified: string; // ISO-8601 (see parity note above)
}

/** A single file operation (write or delete) for plan commits. */
export type FileOp =
  | { kind: "write"; path: string; content: string }
  | { kind: "delete"; path: string };

/**
 * A single already-authorized file write for `KitStore.writeFiles`.
 *
 * The `write_files` TOOL resolves and validates every input before building
 * these ops — glob-gating against the plan's `writes`, duplicate-path
 * rejection, the byte-cap, and `localPath` containment/streaming decisions all
 * happen tool-side (mirroring how `delete_files` keeps plan-gating out of the
 * store). By the time an op reaches the store it is a bare "put these bytes at
 * this kit-relative path", sourced one of two ways:
 *   - `content`    — inline bytes already in memory (decoded from `data`).
 *   - `sourcePath` — an ABSOLUTE, already-containment-checked path the store
 *     streams from (`createReadStream`), so a large `localPath` upload is never
 *     fully buffered in memory (the LocalFs "streaming" property the issue
 *     calls out). The tool guarantees `sourcePath` is inside the plan's
 *     `localDir`; the store trusts it and only streams.
 * `path` is kit-relative (no leading slash, no `..` segment — the tool rejects
 * those); the store additionally guards traversal as defense-in-depth.
 */
export type WriteOp = { path: string; content: Buffer } | { path: string; sourcePath: string };

// ─── Error types ─────────────────────────────────────────────────────────────

/** Thrown when a kit already exists with the given ID. */
export class KitAlreadyExistsError extends Error {
  constructor(public readonly kitId: string) {
    super(`Kit already exists: ${kitId}`);
    this.name = "KitAlreadyExistsError";
  }
}

/** Thrown when `readFile` encounters a file exceeding the 256 KiB cap. */
export class FileTooLargeError extends Error {
  constructor(
    public readonly path: string,
    public readonly actualBytes: number,
  ) {
    super(`File "${path}" is ${actualBytes} bytes, exceeding the 256 KiB (262144 bytes) limit.`);
    this.name = "FileTooLargeError";
  }
}

/** Thrown when a referenced kit/project/plan does not exist. */
export class NotFoundError extends Error {
  constructor(
    public readonly resource: string,
    public readonly id: string,
  ) {
    super(`${resource} "${id}" not found.`);
    this.name = "NotFoundError";
  }
}

/** Thrown when a required credential is missing. */
export class MissingCredentialError extends Error {
  constructor(public readonly envVar: string) {
    super(
      `Required credential "${envVar}" is not set. ` +
        `Set it as an environment variable before starting genie.`,
    );
    this.name = "MissingCredentialError";
  }
}

/**
 * A file in a `KitStore.writeFiles` batch could not be committed; the whole
 * call was rolled back and the kit tree restored to its pre-call state.
 *
 * Lives in the store layer (not the tool) because the store now owns the
 * atomic write transaction — `LocalFsKitStore` throws this from its
 * rename-to-temp/rename-back commit, `GitHostKitStore` from a failed
 * contents-API write it then unwinds. The `write_files` tool imports it to map
 * onto its wire-error taxonomy (code `WriteFailedError`).
 */
export class WriteFailedError extends Error {
  readonly code = "WriteFailedError";
  constructor(
    public readonly path: string,
    public readonly cause: string,
  ) {
    super(`Failed to write "${path}": ${cause}. The call was rolled back; no files were written.`);
    this.name = "WriteFailedError";
  }
}

/**
 * A `KitStore.writeFiles` commit failed AND the rollback itself could not fully
 * undo/restore every step, so the kit tree is NOT guaranteed to match its
 * pre-call state (unlike the ordinary `WriteFailedError` path, which guarantees
 * a clean rollback). Surfaced instead of silently swallowing the rollback
 * failure and reporting the original commit error as if rollback had fully
 * succeeded (a Copilot review finding on PR #106, preserved through the store
 * re-plumb).
 */
export class RollbackIncompleteError extends Error {
  readonly code = "RollbackIncompleteError";
  constructor(
    public readonly commitError: string,
    public readonly rollbackFailures: string[],
  ) {
    super(
      `write_files failed (${commitError}) AND rollback could not fully restore the ` +
        `original tree: ${rollbackFailures.join("; ")}. The destination may be left in ` +
        "a partially-modified state — verify manually before retrying.",
    );
    this.name = "RollbackIncompleteError";
  }
}

// ─── KitStore interface ──────────────────────────────────────────────────────

/** Maximum file size in bytes that readFile will return (256 KiB). */
export const MAX_FILE_BYTES = 262_144;

/**
 * AC1 — KitStore defines:
 *   listKits, getKit, listFiles, readFile(kitId, path),
 *   createKit, openPlan(kitId, ops) → planId,
 *   commitPlan(kitId, planId, ops), closePlan(kitId, planId).
 *
 * The file-content trio (`listFiles`/`readFile`/`deleteFile`) is what the
 * fs-native MCP kit-file verbs (`list_files`/`read_file`/`delete_files`) bind
 * to (M1-14a-1a / DRO-540) — so injecting a `GitHostKitStore` carries those
 * verbs onto the git host, not just the metadata verbs.
 */
export interface KitStore {
  /**
   * List all available kits.
   *
   * ### Identity contract (implemented by #282, documented here)
   *
   * Two invariants hold over the returned ids, and every adapter owes both:
   *
   * 1. **Routing key, not declared id.** `id` is the key `getKit`/`listFiles`/
   *    `readFile` route through — the directory name on LocalFs, the repository
   *    name on a git host — never an `id` embedded in `.kit.json`, which the
   *    adapters deliberately discard. A caller can therefore round-trip a listed
   *    id through any other kit verb without it changing under them.
   * 2. **Every returned id satisfies `isSafeKitId`.** A kit whose routing key the
   *    shared gate refuses is OMITTED rather than advertised, so a listed id is
   *    always one the shared gate admits. The guarantee is about what this
   *    method returns, NOT about uniform enforcement downstream: `validate`
   *    applies no kitId gate at all, and `create_project` persists
   *    `kitBindings[].kitId` unresolved and ungated (its `getKit` call belongs
   *    to `bindKit`). Stating it as "no verb would reject a listed
   *    id" would teach a uniformity the tool layer does not provide.
   *
   * Locked adapter-neutrally by `store-conformance.test.ts` →
   * `🔒 reports the routing key as the id when .kit.json embeds a divergent one`,
   * `🔒 omits a directory whose name isSafeKitId rejects` (LocalFs) and
   * `🔒 omits a listed repository whose name isSafeKitId rejects` (GitHost).
   *
   * Invariant 2 is re-applied at the tool layer by `listWritableKits`
   * (`tools/list_kits.ts`). That is defence in depth, not redundancy: `KitStore`
   * is a public injection point, so a third-party adapter that does not honour
   * this clause must still not be able to falsify the promise `list_kits` makes
   * to its callers.
   */
  listKits(): Promise<KitMeta[]>;

  /**
   * Get metadata for a single kit. Throws NotFoundError if missing.
   *
   * `KitMeta.id` echoes the `kitId` that was looked up, so a caller can route
   * subsequent calls with the value it already holds. That is a lookup-key
   * guarantee, NOT canonical identity: `isSafeKitId` (`store/kit-files.ts`)
   * deliberately accepts alternate SPELLINGS of one kit — case folding on a
   * case-insensitive filesystem, and NTFS short names — so an accepted id can
   * open a kit that `listKits` publishes under a different string. Its docblock
   * owns that residual and explains why closing it needs `realpath` in the
   * adapters rather than a stricter predicate. GitHost has a second route to
   * the same divergence: it falls back to the repository name when a kit's
   * marker cannot be read, which is the string `listKits` always reports.
   *
   * So do not treat `getKit(x).id` as the catalogue's name for that kit. A verb
   * that must act under the published name — anything destructive, or anything
   * it records — should reconcile against `listKits` instead of assuming the
   * two agree.
   */
  getKit(kitId: KitId): Promise<KitMeta>;

  /**
   * List files within a kit as rich entries (path + size + SRI hash +
   * lastModified). Sorted by `path` ASC for deterministic output. The
   * default-excluded dirs (`node_modules`/`.git`/`dist`/`.genie-tmp`), the
   * `.kit.json` marker, and any `.genieignore` patterns are honoured by the
   * adapter that has a notion of them (LocalFs); adapters without local
   * ignore semantics (GitHost) treat the tracked tree as authoritative.
   * Throws NotFoundError if the kit does not exist.
   */
  listFiles(kitId: KitId): Promise<KitFileEntry[]>;

  /**
   * List components within a kit, optionally filtered by group.
   * Returns an array of component metadata sorted by group ASC, then name ASC, then path ASC (for deterministic ordering when group + name collide).
   * Throws NotFoundError if the kit does not exist.
   */
  listComponents(params: { kitId: KitId; group?: string }): Promise<ComponentEntry[]>;

  /**
   * Read a file from a kit as rich content (content + encoding + mimeType).
   * The store owns MIME resolution and text/binary classification, and returns
   * base64 for binary files / utf-8 for text.
   * Throws FileTooLargeError if the file exceeds MAX_FILE_BYTES.
   * Throws NotFoundError if the kit or file does not exist.
   */
  readFile(kitId: KitId, path: string): Promise<KitFileContent>;

  /**
   * Delete a single file from a kit's readable surface (the LocalFs kit dir /
   * the git-host default branch). Returns `{ existed }`:
   *   - `existed: true`  — the file was present and has been removed.
   *   - `existed: false` — the file (or its whole kit) was already absent — an
   *     idempotent no-op, NOT an error. This is the `delete_files`
   *     silent-retry case (an authorized path that no longer exists lands in
   *     `notFoundPaths`, not a failure).
   * Plan-gating (which paths a caller may delete) is NOT a store concern — it
   * stays in the `delete_files` tool (planId → `deletes` globs), as does the
   * path-shape / kitId-shape traversal guard. This primitive only performs the
   * physical removal once the tool has authorized it. A hard removal failure
   * that is NOT "already absent" (e.g. a directory target → EISDIR, a
   * permission error) propagates as the adapter's native error, which the tool
   * surfaces as `DeleteFailed`.
   */
  deleteFile(kitId: KitId, path: string): Promise<{ existed: boolean }>;

  /**
   * Atomically write a batch of files into a kit's readable surface (the
   * LocalFs kit dir / the git-host default branch — the SAME surface
   * `readFile`/`listFiles`/`deleteFile` see, NOT a plan branch). Returns the
   * kit-relative paths written, in input order.
   *
   * All-or-nothing (the shipped `write_files` AC10 contract, preserved through
   * the store re-plumb): either every op lands, or the kit tree is restored to
   * its exact pre-call state and the failure is surfaced. Two failure shapes:
   *   - `WriteFailedError`        — a file could not be committed AND rollback
   *     fully restored the tree (clean failure; nothing landed).
   *   - `RollbackIncompleteError` — the commit failed AND rollback could not
   *     fully restore the tree (the kit may be partially modified).
   *
   * Per-adapter realization:
   *   - `LocalFsKitStore`  — stage every op under `<kitDir>/.genie-tmp/<rand>/`,
   *     back up existing destinations, rename staged files in, and on any
   *     failure remove what committed + rename the backups back (same-filesystem
   *     rename = atomic). Streams `sourcePath` ops so large uploads never fully
   *     buffer.
   *   - `GitHostKitStore`  — commit each op to the default branch via the
   *     contents API, capturing prior blob state first; on failure, re-PUT the
   *     captured state / delete created files to unwind. A git host has no
   *     rename transaction, so atomicity is best-effort-with-surfaced-failures
   *     rather than filesystem-atomic — the same contract shape, honoured with
   *     the primitive the host offers.
   *
   * Plan-gating (which paths may be written, the byte cap, `localPath`
   * containment, duplicate rejection) is NOT a store concern — it stays in the
   * `write_files` tool, exactly as `deleteFile` keeps `deletes`-glob gating in
   * `delete_files`. The store trusts the resolved `WriteOp[]` and only commits.
   */
  writeFiles(kitId: KitId, ops: WriteOp[]): Promise<{ writtenPaths: string[] }>;

  /**
   * Create a new kit with the given name and metadata. Returns its metadata.
   *
   * `kitId`, when supplied, MUST satisfy `isSafeKitId`
   * (`store/kit-files.ts`), which is the authority on what that means —
   * deliberately NOT restated here, because the rejection set grows (#277 adds
   * trailing dots and spaces) and a copy in this file would silently understate
   * it. This is a precondition, not a hint: it is checked
   * before any repo/directory is created, so a rejected id leaves no partial
   * kit behind. Both adapters reject a violating id with
   * `NotFoundError("Kit", id)` — the same error every other `isSafeKitId`
   * rejection in the store layer reports (`LocalFsKitStore.safeKitDir`,
   * `GitHostKitStore.listFiles`/`readFile`). Implementations MUST NOT surface a
   * different error for this case; `test/store-conformance.test.ts` pins it on
   * every adapter.
   *
   * Callers that mint ids through `buildKitId` never trip this — its output is
   * a slug. The rule exists because this method is public and the parameter is
   * caller-supplied, so "the tool layer always mints it" is not an invariant of
   * the CONTRACT, only of one caller.
   *
   * When `kitId` is OMITTED the adapter assigns one, and that assigned id must
   * itself satisfy `isSafeKitId` — the constraint is on the id either way, so
   * an adapter cannot launder an unsafe value in through its own fallback.
   * `name` is NOT constrained: it is free display text, preserved verbatim on
   * the returned `KitMeta`. Do NOT derive the assigned id from `name` — doing
   * so puts a display string under a path-safety predicate and makes the call
   * reject names that are perfectly legal (the same category error #276
   * removed from the tools that gated input on `KIT_ID_PATTERN`, a description
   * of `buildKitId`'s OUTPUT). Both adapters use `randomUUID()`; deriving a
   * slug instead would also re-diverge them. Pinned on every adapter by
   * `test/store-conformance.test.ts`.
   *
   * Throws KitAlreadyExistsError if a kit with the same ID already exists.
   */
  createKit(name: string, kitId?: string): Promise<KitMeta>;

  /**
   * Open a plan (staging area) for a kit. Applies initial writes/deletes.
   * Returns a planId that can be used with commitPlan/closePlan.
   */
  openPlan(kitId: KitId, ops: FileOp[]): Promise<PlanId>;

  /**
   * Commit additional file operations to an existing plan.
   * In LocalFsStore this writes to a staging dir; in GitHostStore it commits
   * to the plan branch.
   */
  commitPlan(kitId: KitId, planId: PlanId, ops: FileOp[]): Promise<void>;

  /**
   * Close a plan (discard the staging area / delete the plan branch).
   * Idempotent — closing an already-closed plan is a no-op.
   */
  closePlan(kitId: KitId, planId: PlanId): Promise<void>;
}

// ─── ProjectStore interface ──────────────────────────────────────────────────

/**
 * AC2 — ProjectStore defines:
 *   listProjects, getProject, createProject, deleteProject,
 *   bindKit, recordScreen.
 *
 * ⚠️ NAME COLLISION — this is NOT the `ProjectStore` the `bind_kit` tool binds.
 * A second, unrelated `ProjectStore` (a *class*) is exported from
 * `src/tools/create_project.ts`, and that is the one wired into the server and
 * used by every project tool. The two are not structurally assignable:
 *
 *   |            | this interface                | tools/create_project.ts    |
 *   |------------|-------------------------------|----------------------------|
 *   | kind       | interface                     | class                      |
 *   | bindKit    | (projectId, kitId) => void    | (args) => ProjectSummary   |
 *   | checks kit | no (see bindKit note below)   | yes (`assertKitExists`)    |
 *   | callers    | store conformance tests       | the `bind_kit` tool        |
 *
 * The `bindKit` note below is accurate *for this interface* — do not "correct"
 * it by reading the class's behaviour. Reading one declaration and attributing
 * its behaviour to the other has produced wrong conclusions more than once.
 */
export interface ProjectStore {
  /** List all projects. */
  listProjects(): Promise<ProjectMeta[]>;

  /** Get metadata for a single project. Throws NotFoundError if missing. */
  getProject(projectId: ProjectId): Promise<ProjectMeta>;

  /** Create a new project with the given name. */
  createProject(name: string): Promise<ProjectMeta>;

  /** Delete a project. Throws NotFoundError if missing. */
  deleteProject(projectId: ProjectId): Promise<void>;

  /**
   * Bind a kit to a project. Throws NotFoundError if the project is missing.
   * Note: kit existence is not validated by this interface.
   */
  bindKit(projectId: ProjectId, kitId: KitId): Promise<void>;

  /**
   * Record a screen capture reference for a project.
   * Stores the path/url for later retrieval.
   */
  recordScreen(projectId: ProjectId, screenRef: string): Promise<void>;
}
