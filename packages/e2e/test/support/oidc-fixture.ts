/**
 * Ephemeral OIDC provider fixture (DRO-276 / M5-04).
 *
 * Boots a real `oidc-provider`-backed authorization server in a throwaway
 * container (built from `./oidc-provider-image/`), configured with:
 *   - client_id `genie-test` (AC3), a public/PKCE-only OAuth client,
 *   - two seeded users — `alice` (member of `genie-users`) and `mallory`
 *     (member of a different group) — so the same running provider proves
 *     both AC5 (authorized access) and AC6 (403 for non-members).
 *
 * Follows the exact pattern `./gitea-fixture.ts` established for M1-14a/
 * DRO-532: testcontainers-backed, gated behind {@link isDockerAvailable},
 * consuming suites `describe.skipIf` the whole block when no runtime is
 * reachable so `pnpm test` stays green without Docker, and CI's dedicated
 * OIDC job sets `GENIE_REQUIRE_DOCKER=1` to fail loudly rather than
 * vacuously skip if its own daemon is ever missing.
 */

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { createServer } from "node:net";

const OIDC_HTTP_PORT = 9944;
export const OIDC_CLIENT_ID = "genie-test";
export const OIDC_REQUIRED_GROUP = "genie-users";

/** Seeded users the fixture's `server.mjs` recognizes — kept here too so
 *  tests reference the same literals rather than re-deriving them. */
export const OIDC_TEST_USERS = {
  authorized: { username: "alice", password: "genie-e2e-alice-pw" },
  unauthorized: { username: "mallory", password: "genie-e2e-mallory-pw" },
} as const;

export interface OidcFixture {
  /** Provider issuer URL as reachable from the TEST PROCESS (host-mapped port). */
  issuer: string;
  /** Redirect URI the fixture's sole client is registered under. */
  redirectUri: string;
  /** RFC 8707 resource identifier used to request a JWT access token. */
  resource: string;
  container: StartedTestContainer;
  stop: () => Promise<void>;
}

/**
 * True when a container runtime (Docker/Podman) is reachable. Mirrors
 * `gitea-fixture.ts`'s {@link isDockerAvailable} exactly (same resolver,
 * same `GENIE_SKIP_DOCKER_TESTS` opt-out, same non-throwing contract) so both
 * fixtures agree on what "Docker is available" means.
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (process.env.GENIE_SKIP_DOCKER_TESTS === "1") return false;

  try {
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

  try {
    if (process.env.DOCKER_HOST) return true;
    const { existsSync } = await import("node:fs");
    return existsSync("/var/run/docker.sock");
  } catch {
    return false;
  }
}

/**
 * Boot the ephemeral OIDC provider. `oidc-provider` fixes its issuer before
 * the container starts, so reserve a free host port first and bind container
 * port 9944 to that exact port. The same issuer is then reachable from the
 * test process on Linux and Docker Desktop, without a fixed-port collision or
 * Linux-only host networking. `redirectUri` is passed straight through as
 * the client's registered callback.
 *
 * @param redirectUri the OAuth redirect_uri the test's own callback catcher
 *   listens on (e.g. `http://127.0.0.1:4180/callback`).
 * @param startupTimeoutMs container readiness budget (default 60s — this is
 *   a small pure-Node image, far lighter than Gitea's DB migration).
 */
export async function startOidcProvider(
  redirectUri: string,
  startupTimeoutMs = 60_000,
): Promise<OidcFixture> {
  const hostPort = await reserveHostPort();
  const issuer = `http://127.0.0.1:${hostPort}`;
  const resource = `${issuer}/mcp`;

  const container = await GenericContainer.fromDockerfile(
    `${import.meta.dirname}/oidc-provider-image`,
  ).build();

  const started = await container
    .withExposedPorts({ container: OIDC_HTTP_PORT, host: hostPort })
    .withEnvironment({
      OIDC_REDIRECT_URI: redirectUri,
      OIDC_ISSUER: issuer,
    })
    .withWaitStrategy(Wait.forLogMessage(/oidc-fixture listening/))
    .withStartupTimeout(startupTimeoutMs)
    .start();

  const stop = async () => {
    await started.stop();
  };

  return { issuer, redirectUri, resource, container: started, stop };
}

async function reserveHostPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve a TCP port for the OIDC fixture");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
