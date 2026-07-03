/**
 * Gitea reference-host fixture for the AC5 GitHostStore conformance walk.
 *
 * DRO-532 (blocker #2 of DRO-523 / M1-14a AC5) — test-infra half.
 *
 * Stands up a real `gitea/gitea` instance in a throwaway container via
 * testcontainers, provisions an admin user + API token + organization, and
 * hands back a `GitHostConfig`-shaped target that `GitHostKitStore` /
 * `GitHostProjectStore` (packages/server) can be pointed at unchanged.
 *
 * ── Why a real container (not the mocked fetch) ──────────────────────────────
 * `packages/server/test/store-conformance.test.ts` already runs the shared
 * KitStore/ProjectStore *contract* against `GitHost*` with an in-memory fetch
 * mock. That proves the adapter's request-shaping logic. It does NOT prove the
 * adapter speaks a dialect a real Gitea accepts (auth header form, status
 * codes, base64 content round-trips, plan-branch semantics). This fixture is
 * the missing end-to-end half, and the substrate DRO-523's AC5 tool-surface
 * walk will consume once the `createServer` store-injection seam lands.
 *
 * ── Docker-absent skip ───────────────────────────────────────────────────────
 * Everything here is gated behind {@link isDockerAvailable}. When no container
 * runtime is reachable (the common local case, and this authoring sandbox), the
 * consuming suite skips its whole `describe` block — so `pnpm test` stays green
 * without Docker (AC: "local pnpm test stays green without Docker"). The real
 * container boot is exercised only on the CI Docker leg (ci.yml `gitea` job).
 */

import { Buffer } from "node:buffer";

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

// ── Provisioning constants ────────────────────────────────────────────────────
//
// Non-secret, throwaway credentials: the container lives for the duration of a
// single test file and is discarded. Nothing here is a real secret (CLAUDE.md
// hard-rule #5) — it never leaves the ephemeral container.

/** Container image. Defaults per the AC (`gitea/gitea:latest`); override with
 *  `GENIE_GITEA_IMAGE` to pin a digest for reproducible CI. */
const GITEA_IMAGE = process.env.GENIE_GITEA_IMAGE ?? "gitea/gitea:latest";
/** Gitea's in-container HTTP port. */
const GITEA_HTTP_PORT = 3000;
const ADMIN_USER = "genie-admin";
// Complex enough to satisfy Gitea's default password policy even if a future
// image re-enables PASSWORD_COMPLEXITY; we also disable it via env below.
const ADMIN_PASSWORD = "Genie-Admin-Pw-2026!";
const ADMIN_EMAIL = "genie-admin@genie.test";
/** Org that owns kit repos. `GitHostKitStore.createKit` POSTs to
 *  `/orgs/{owner}/repos`, so `owner` MUST be an organization, not a user. */
const OWNER_ORG = "genie-kits";
const TOKEN_NAME = "genie-e2e";

/** The shape the server's GitHostStore adapters accept, replicated here so the
 *  fixture stays decoupled from `@genie/server` internals. Structurally equal
 *  to `GitHostConfig` in packages/server/src/store/git-host.ts. */
export interface GiteaTarget {
  /** e.g. `http://localhost:49213/api/v1` */
  baseUrl: string;
  /** API token with `all` scope. */
  token: string;
  /** Organization name (kit-repo owner). */
  owner: string;
}

export interface GiteaFixture extends GiteaTarget {
  /** Base URL without the `/api/v1` suffix — handy for diagnostics/logs. */
  rootUrl: string;
  /** The running container handle (exposed for advanced assertions). */
  container: StartedTestContainer;
  /** Tear down the container. Idempotent-safe to await in `afterAll`. */
  stop: () => Promise<void>;
}

/**
 * True when a container runtime (Docker/Podman) is reachable, i.e. when
 * `GenericContainer(...).start()` would succeed. Uses testcontainers' own
 * runtime resolver so the probe honours `DOCKER_HOST`, rootless sockets, and
 * `testcontainers.properties` exactly as the real start would.
 *
 * Falls back to a socket/env heuristic only if the resolver export is
 * unavailable, and NEVER throws — a false return simply skips the Gitea walk.
 */
export async function isDockerAvailable(): Promise<boolean> {
  // Allow an explicit opt-out (e.g. a runner that has Docker but should not use
  // it for this suite). `GENIE_SKIP_DOCKER_TESTS=1` forces the skip path.
  if (process.env.GENIE_SKIP_DOCKER_TESTS === "1") return false;

  try {
    // Preferred: ask testcontainers to resolve the runtime it would actually
    // use. Throws when nothing is reachable.
    const mod = (await import("testcontainers")) as unknown as {
      getContainerRuntimeClient?: () => Promise<unknown>;
    };
    if (typeof mod.getContainerRuntimeClient === "function") {
      await mod.getContainerRuntimeClient();
      return true;
    }
  } catch {
    return false;
  }

  // Fallback heuristic if the resolver export ever moves: a DOCKER_HOST or the
  // conventional unix socket is a strong signal a daemon is present.
  try {
    if (process.env.DOCKER_HOST) return true;
    const { existsSync } = await import("node:fs");
    return existsSync("/var/run/docker.sock");
  } catch {
    return false;
  }
}

// ── Minimal Gitea REST helpers (fixture-local; independent of the adapter) ────

async function giteaFetch(
  url: string,
  init: RequestInit,
  expectStatuses: number[],
): Promise<Response> {
  const res = await fetch(url, init);
  if (!expectStatuses.includes(res.status)) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Gitea provisioning call failed: ${init.method ?? "GET"} ${url} → ` +
        `${res.status} ${res.statusText}\n${body}`,
    );
  }
  return res;
}

/** Retry an async step against a freshly-booted Gitea whose API may need a
 *  beat to settle even after `/api/healthz` reports healthy. */
async function withRetries<T>(
  label: string,
  attempts: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Linear backoff; total worst-case ~ attempts * 500ms.
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempts: ${String(lastErr)}`,
  );
}

/**
 * Boot a Gitea container and provision it for GitHostStore conformance:
 *   1. start `gitea/gitea` with install-lock + sqlite (no first-run wizard),
 *   2. create an admin user (via `gitea admin user create`),
 *   3. mint an `all`-scope API token (Basic-auth REST call),
 *   4. create the kit-owner organization.
 *
 * Callers MUST gate on {@link isDockerAvailable} first; invoking this without a
 * runtime throws from testcontainers.
 *
 * @param startupTimeoutMs container readiness budget (default 180s — first-run
 *   image pull + DB migration can be slow on a cold CI runner).
 */
export async function startGitea(startupTimeoutMs = 180_000): Promise<GiteaFixture> {
  const container = await new GenericContainer(GITEA_IMAGE)
    .withExposedPorts(GITEA_HTTP_PORT)
    .withEnvironment({
      // Skip the browser install wizard; run entirely from env-derived app.ini.
      GITEA__security__INSTALL_LOCK: "true",
      GITEA__security__PASSWORD_COMPLEXITY: "off",
      // Self-contained sqlite DB — no external DB container needed.
      GITEA__database__DB_TYPE: "sqlite3",
      GITEA__database__PATH: "/data/gitea/gitea.db",
      // Quiet, offline, deterministic.
      GITEA__server__OFFLINE_MODE: "true",
      GITEA__server__DISABLE_SSH: "true",
      GITEA__log__LEVEL: "warn",
      // New repos default to `main`, matching the store's default-branch fallback.
      GITEA__repository__DEFAULT_BRANCH: "main",
      // Allow token-authenticated org/repo creation without extra gates.
      GITEA__service__DISABLE_REGISTRATION: "true",
    })
    // `/api/healthz` returns 200 once migrations are done and the API is live.
    .withWaitStrategy(Wait.forHttp("/api/healthz", GITEA_HTTP_PORT).forStatusCode(200))
    .withStartupTimeout(startupTimeoutMs)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(GITEA_HTTP_PORT);
  const rootUrl = `http://${host}:${port}`;
  const baseUrl = `${rootUrl}/api/v1`;

  const stop = async () => {
    await container.stop();
  };

  try {
    // 2. Admin user. Run the gitea CLI as the `git` user against the app.ini the
    //    entrypoint materialised from our env. `--must-change-password=false`
    //    keeps the token usable immediately.
    await withRetries("gitea admin user create", 5, async () => {
      const { exitCode, output } = await container.exec(
        [
          "gitea",
          "admin",
          "user",
          "create",
          "--admin",
          "--username",
          ADMIN_USER,
          "--password",
          ADMIN_PASSWORD,
          "--email",
          ADMIN_EMAIL,
          "--must-change-password=false",
          "--config",
          "/data/gitea/conf/app.ini",
        ],
        { user: "git" },
      );
      if (exitCode !== 0) {
        throw new Error(`exit ${exitCode}: ${output}`);
      }
    });

    // 3. Mint an all-scope token via Basic auth (same HTTP surface the adapter
    //    uses, so this also smoke-tests reachability of the mapped port).
    const basic = Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString("base64");
    const token = await withRetries("create access token", 8, async () => {
      const res = await giteaFetch(
        `${baseUrl}/users/${ADMIN_USER}/tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ name: TOKEN_NAME, scopes: ["all"] }),
        },
        [201],
      );
      const data = (await res.json()) as { sha1?: string };
      if (!data.sha1) throw new Error(`token response missing sha1: ${JSON.stringify(data)}`);
      return data.sha1;
    });

    // 4. Kit-owner organization (createKit POSTs to /orgs/{owner}/repos).
    await withRetries("create org", 5, async () => {
      await giteaFetch(
        `${baseUrl}/orgs`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ username: OWNER_ORG, visibility: "private" }),
        },
        // 201 created, or 422 if a retry re-attempts an already-created org.
        [201, 422],
      );
    });

    return { baseUrl, token, owner: OWNER_ORG, rootUrl, container, stop };
  } catch (err) {
    // Never leak the container if provisioning fails partway.
    await stop().catch(() => {});
    throw err;
  }
}
