/**
 * Plan registry and state management.
 *
 * A plan is the single user-visible permission grant that locks `writes`,
 * `deletes`, and `localDir`. Plans persist to disk at
 * `${GENIE_HOME}/plans/<planId>.json` so they survive server restarts.
 *
 * Plans expire after 1 hour of inactivity (configurable via GENIE_PLAN_TTL).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
// Default import, NOT `import * as micromatch`. micromatch is CommonJS and
// assigns `isMatch` dynamically, so cjs-module-lexer can't surface it as a
// named ESM export. Under native Node ESM a namespace import lands the real
// module under `.default`, leaving `micromatch.isMatch` undefined at runtime
// (vitest's lenient interop hides this; the built dist throws). The default
// import binds the whole module object, so `.isMatch` resolves correctly.
import micromatch from "micromatch";

/** Max number of write patterns allowed per plan. */
export const MAX_WRITES = 256;

/** Max number of wildcards per glob pattern. */
export const MAX_WILDCARDS = 3;

/** Default plan TTL in milliseconds (1 hour). */
export const DEFAULT_PLAN_TTL = 60 * 60 * 1000;

/** Environment variable to override plan TTL. */
export const PLAN_TTL_ENV = "GENIE_PLAN_TTL";

/**
 * Plan IDs are always UUIDs (see `createPlan` → `randomUUID`). Validating the
 * shape up front lets `getPlan` reject a malformed/hostile `planId` — e.g. a
 * path-traversal value like `"../../x"` — before it is ever interpolated into a
 * `${GENIE_HOME}/plans/<planId>.json` disk path.
 */
const PLAN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True if `planId` has the UUID shape every real plan uses. */
export function isValidPlanId(planId: string): boolean {
  return PLAN_ID_PATTERN.test(planId);
}

/** Plan state persisted to disk. */
export interface PlanState {
  planId: string;
  kitId: string;
  writes: string[];
  deletes: string[];
  localDir: string;
  createdAt: string; // ISO-8601
  lastAccessedAt: string; // ISO-8601
}

/** Error thrown when too many write patterns are provided. */
export class TooManyWritesError extends Error {
  constructor(public readonly count: number) {
    super(`Too many write patterns: ${count}. Maximum allowed is ${MAX_WRITES}.`);
    this.name = "TooManyWritesError";
  }
}

/** Error thrown when a glob pattern has too many wildcards. */
export class TooComplexGlobError extends Error {
  constructor(
    public readonly pattern: string,
    public readonly wildcardCount: number,
  ) {
    super(
      `Glob pattern "${pattern}" has ${wildcardCount} wildcards. ` +
        `Maximum allowed is ${MAX_WILDCARDS}.`,
    );
    this.name = "TooComplexGlobError";
  }
}

/** Error thrown when a plan is not found or has expired. */
export class PlanNotFoundError extends Error {
  constructor(public readonly planId: string) {
    super(`Plan "${planId}" not found or expired.`);
    this.name = "PlanNotFoundError";
  }
}

/** Count wildcards in a glob pattern. */
function countWildcards(pattern: string): number {
  // Count * and ** (double-asterisk counts as one wildcard for this rule)
  const stars = pattern.match(/\*+/g) || [];
  return stars.length;
}

/** Validate glob patterns against complexity limits. */
export function validateGlobPatterns(patterns: string[]): void {
  for (const pattern of patterns) {
    const wildcardCount = countWildcards(pattern);
    if (wildcardCount > MAX_WILDCARDS) {
      throw new TooComplexGlobError(pattern, wildcardCount);
    }
  }
}

/** In-memory plan registry. */
const planRegistry = new Map<string, PlanState>();

/** Get the plans directory path from GENIE_HOME. */
function getPlansDir(): string {
  const home = process.env.GENIE_HOME || resolve(process.cwd(), ".genie");
  return resolve(home, "plans");
}

/** Get the plan TTL in milliseconds. */
export function getPlanTTL(): number {
  const envTTL = process.env[PLAN_TTL_ENV];
  if (envTTL) {
    const parsed = parseInt(envTTL, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PLAN_TTL;
}

/** Load a plan from disk. Returns null if missing or unreadable/corrupt. */
async function loadPlanFromDisk(planId: string): Promise<PlanState | null> {
  const plansDir = getPlansDir();
  const planPath = resolve(plansDir, `${planId}.json`);

  try {
    const content = await readFile(planPath, "utf-8");
    return JSON.parse(content) as PlanState;
  } catch {
    return null;
  }
}

/** Save a plan to disk. */
async function savePlanToDisk(state: PlanState): Promise<void> {
  const plansDir = getPlansDir();
  await mkdir(plansDir, { recursive: true });

  const planPath = resolve(plansDir, `${state.planId}.json`);
  await writeFile(planPath, JSON.stringify(state, null, 2), "utf-8");
}

/** Delete a plan's disk snapshot, if any. Missing file is not an error. */
async function deletePlanFromDisk(planId: string): Promise<void> {
  const plansDir = getPlansDir();
  const planPath = resolve(plansDir, `${planId}.json`);

  try {
    await unlink(planPath);
  } catch {
    // Already gone (or never persisted) — nothing to clean up.
  }
}

/** Check if a plan has expired based on TTL. */
function isPlanExpired(state: PlanState): boolean {
  const ttl = getPlanTTL();
  const lastAccessed = new Date(state.lastAccessedAt).getTime();
  const now = Date.now();
  return now - lastAccessed > ttl;
}

/** Create a new plan and persist it. */
export async function createPlan(
  kitId: string,
  writes: string[],
  deletes: string[],
  localDir: string,
): Promise<PlanState> {
  // Validate write count
  if (writes.length > MAX_WRITES) {
    throw new TooManyWritesError(writes.length);
  }

  // Validate glob complexity
  validateGlobPatterns(writes);
  validateGlobPatterns(deletes);

  // Create plan state
  const planId = randomUUID();
  const now = new Date().toISOString();

  const state: PlanState = {
    planId,
    kitId,
    writes,
    deletes,
    localDir,
    createdAt: now,
    lastAccessedAt: now,
  };

  // Store in registry and persist
  planRegistry.set(planId, state);
  await savePlanToDisk(state);

  return state;
}

/** Retrieve a plan by ID, checking expiry. */
export async function getPlan(planId: string): Promise<PlanState> {
  // Reject a malformed/hostile planId before it ever touches a disk path.
  // Every real plan id is a UUID; anything else (e.g. a "../../x" traversal
  // value) cannot correspond to a plan we created, so treat it as not-found.
  if (!isValidPlanId(planId)) {
    throw new PlanNotFoundError(planId);
  }

  // Check in-memory registry first
  let state: PlanState | null | undefined = planRegistry.get(planId);

  // Fall back to disk if not in memory
  if (!state) {
    state = await loadPlanFromDisk(planId);
    if (state) {
      // Defense in depth: the on-disk JSON is untrusted (a tampered snapshot
      // could carry a `planId` that differs from the file it was read from,
      // e.g. a traversal value that `savePlanToDisk` would later write outside
      // the plans dir). Only trust a snapshot whose embedded id matches the id
      // we looked up.
      if (state.planId !== planId) {
        throw new PlanNotFoundError(planId);
      }
      planRegistry.set(planId, state);
    }
  }

  if (!state) {
    throw new PlanNotFoundError(planId);
  }

  // Check expiry
  if (isPlanExpired(state)) {
    planRegistry.delete(planId);
    // Clean up the on-disk snapshot too, so expired plans don't accumulate
    // indefinitely under `${GENIE_HOME}/plans/`.
    await deletePlanFromDisk(planId);
    throw new PlanNotFoundError(planId);
  }

  // Update last accessed time
  state.lastAccessedAt = new Date().toISOString();
  await savePlanToDisk(state);

  return state;
}

/** Check if a path matches any glob pattern in the plan. */
export function pathMatchesGlobs(path: string, globs: string[]): boolean {
  return micromatch.isMatch(path, globs, { dot: true });
}

/**
 * Validate that a path is inside the plan's localDir.
 *
 * Uses `path.relative`/`path.isAbsolute` rather than a string check against a
 * hard-coded "/" separator, so containment is correct across platforms (POSIX
 * and Windows) — mirrors `safePath` in `store/local.ts` and `read_file.ts`.
 *
 * A relative `path` is resolved against `localDir` (the RFC's base for
 * resolving `localPath` in `write_files`), NOT against `process.cwd()` — so
 * containment stays correct even when the server's cwd differs from localDir.
 * An absolute `path` is checked as-is.
 */
export function isPathInsideLocalDir(path: string, localDir: string): boolean {
  const resolvedLocalDir = resolve(localDir);
  const resolvedPath = resolve(resolvedLocalDir, path);

  // Identical paths are trivially "inside".
  if (resolvedPath === resolvedLocalDir) {
    return true;
  }

  const rel = relative(resolvedLocalDir, resolvedPath);
  // `rel` escapes localDir if it's ".." itself, starts with a ".." segment,
  // or is absolute (e.g. a different drive on Windows).
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/** Clear expired plans from the registry and disk (housekeeping). */
export async function pruneExpiredPlans(): Promise<number> {
  let pruned = 0;
  const now = Date.now();
  const ttl = getPlanTTL();

  for (const [planId, state] of planRegistry.entries()) {
    const lastAccessed = new Date(state.lastAccessedAt).getTime();
    if (now - lastAccessed > ttl) {
      planRegistry.delete(planId);
      await deletePlanFromDisk(planId);
      pruned++;
    }
  }

  return pruned;
}
