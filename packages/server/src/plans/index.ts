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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as micromatch from "micromatch";

/** Max number of write patterns allowed per plan. */
export const MAX_WRITES = 256;

/** Max number of wildcards per glob pattern. */
export const MAX_WILDCARDS = 3;

/** Default plan TTL in milliseconds (1 hour). */
export const DEFAULT_PLAN_TTL = 60 * 60 * 1000;

/** Environment variable to override plan TTL. */
export const PLAN_TTL_ENV = "GENIE_PLAN_TTL";

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

/** Load a plan from disk. */
function loadPlanFromDisk(planId: string): PlanState | null {
  const plansDir = getPlansDir();
  const planPath = resolve(plansDir, `${planId}.json`);

  if (!existsSync(planPath)) {
    return null;
  }

  try {
    const content = readFileSync(planPath, "utf-8");
    return JSON.parse(content) as PlanState;
  } catch {
    return null;
  }
}

/** Save a plan to disk. */
function savePlanToDisk(state: PlanState): void {
  const plansDir = getPlansDir();
  mkdirSync(plansDir, { recursive: true });

  const planPath = resolve(plansDir, `${state.planId}.json`);
  writeFileSync(planPath, JSON.stringify(state, null, 2), "utf-8");
}

/** Check if a plan has expired based on TTL. */
function isPlanExpired(state: PlanState): boolean {
  const ttl = getPlanTTL();
  const lastAccessed = new Date(state.lastAccessedAt).getTime();
  const now = Date.now();
  return now - lastAccessed > ttl;
}

/** Create a new plan and persist it. */
export function createPlan(
  kitId: string,
  writes: string[],
  deletes: string[],
  localDir: string,
): PlanState {
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
  savePlanToDisk(state);

  return state;
}

/** Retrieve a plan by ID, checking expiry. */
export function getPlan(planId: string): PlanState {
  // Check in-memory registry first
  let state: PlanState | null | undefined = planRegistry.get(planId);

  // Fall back to disk if not in memory
  if (!state) {
    state = loadPlanFromDisk(planId);
    if (state) {
      planRegistry.set(planId, state);
    }
  }

  if (!state) {
    throw new PlanNotFoundError(planId);
  }

  // Check expiry
  if (isPlanExpired(state)) {
    planRegistry.delete(planId);
    throw new PlanNotFoundError(planId);
  }

  // Update last accessed time
  state.lastAccessedAt = new Date().toISOString();
  savePlanToDisk(state);

  return state;
}

/** Check if a path matches any glob pattern in the plan. */
export function pathMatchesGlobs(path: string, globs: string[]): boolean {
  return micromatch.isMatch(path, globs, { dot: true });
}

/** Validate that a path is inside the plan's localDir. */
export function isPathInsideLocalDir(path: string, localDir: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedLocalDir = resolve(localDir);
  return resolvedPath.startsWith(resolvedLocalDir + "/") || resolvedPath === resolvedLocalDir;
}

/** Clear expired plans from the registry (housekeeping). */
export function pruneExpiredPlans(): number {
  let pruned = 0;
  const now = Date.now();
  const ttl = getPlanTTL();

  for (const [planId, state] of planRegistry.entries()) {
    const lastAccessed = new Date(state.lastAccessedAt).getTime();
    if (now - lastAccessed > ttl) {
      planRegistry.delete(planId);
      pruned++;
    }
  }

  return pruned;
}
