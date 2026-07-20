import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  collectPnpmOptionalDependencyEdges,
  selectPackageClosure,
} from "../../../scripts/generate-package-sbom.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowsRoot = resolve(repoRoot, ".github/workflows");
const ci = readFileSync(resolve(workflowsRoot, "ci.yml"), "utf8");
const release = readFileSync(resolve(workflowsRoot, "release.yml"), "utf8");
const releasePleaseConfig = JSON.parse(
  readFileSync(resolve(repoRoot, "release-please-config.json"), "utf8"),
);
const runnerGuard = readFileSync(resolve(workflowsRoot, "runner-guard.yml"), "utf8");
const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const serverPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/server/package.json"), "utf8"),
);
const viewerPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/viewer/package.json"), "utf8"),
);
const mcpbManifest = JSON.parse(readFileSync(resolve(repoRoot, "mcpb/manifest.json"), "utf8"));
const workspace = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8");
const gitleaks = readFileSync(resolve(repoRoot, ".gitleaks.toml"), "utf8");
const sbomScript = resolve(repoRoot, "scripts/generate-package-sbom.mjs");

const workflowFiles = readdirSync(workflowsRoot)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => ({ file, source: readFileSync(resolve(workflowsRoot, file), "utf8") }));

const reviewedActions = new Map(
  Object.entries({
    "actions/checkout": ["34e114876b0b11c390a56381ad16ebd13914f8d5", "v4.3.1"],
    "actions/configure-pages": ["983d7736d9b0ae728b81ab479565c72886d7745b", "v5.0.0"],
    "actions/deploy-pages": ["d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e", "v4.0.5"],
    "actions/upload-pages-artifact": ["7b1f4a764d45c48632c6b24a0339c27f5614fb0b", "v4.0.0"],
    "actions/setup-node": ["49933ea5288caeca8642d1e84afbd3f7d6820020", "v4.4.0"],
    "actions/upload-artifact": ["ea165f8d65b6e75b540449e92b4886f43607fa02", "v4.6.2"],
    "docker/build-push-action": ["10e90e3645eae34f1e60eeb005ba3a3d33f178e8", "v6.19.2"],
    "docker/login-action": ["c94ce9fb468520275223c153574b00df6fe4bcc9", "v3.7.0"],
    "docker/setup-buildx-action": ["8d2750c68a42422c14e847fe6c8ac0403b4cbd6f", "v3.12.0"],
    "docker/setup-qemu-action": ["c7c53464625b32c7a7e944ae62b3e17d2b600130", "v3.7.0"],
    "googleapis/release-please-action": ["5c625bfb5d1ff62eadeeb3772007f7f66fdcf071", "v4.4.1"],
    "pnpm/action-setup": ["b906affcce14559ad1aafd4ab0e942779e9f58b1", "v4.3.0"],
    "sigstore/cosign-installer": ["6f9f17788090df1f26f669e9d70d6ae9567deba6", "v4.1.2"],
    "softprops/action-gh-release": ["3bb12739c298aeb8a4eeaf626c5b8d85266b0e65", "v2.6.2"],
  } as Record<string, readonly [string, string]>),
);

function job(source: string, name: string, nextName?: string): string {
  const start = source.indexOf(`  ${name}:`);
  expect(start, `${name} job`).toBeGreaterThanOrEqual(0);
  const end = nextName === undefined ? source.length : source.indexOf(`  ${nextName}:`, start);
  expect(end, `${nextName ?? "end"} boundary`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("supply-chain policy", () => {
  it("pins every third-party workflow action to a reviewed commit", () => {
    const seen = new Set<string>();

    for (const { file, source } of workflowFiles) {
      const usesEntries = collectUses(parse(source));
      const parsedCounts = new Map<string, number>();
      for (const uses of usesEntries) {
        if (uses.startsWith("./")) continue;
        const separator = uses.lastIndexOf("@");
        expect(separator, `${file}: malformed uses entry ${uses}`).toBeGreaterThan(0);
        const action = uses.slice(0, separator);
        const reviewed = reviewedActions.get(action);
        expect(reviewed, `${file}: unreviewed third-party action ${action}`).toBeDefined();
        const [sha] = reviewed!;
        expect(uses, `${file}: ${action}`).toBe(`${action}@${sha}`);
        parsedCounts.set(action, (parsedCounts.get(action) ?? 0) + 1);
        seen.add(action);
      }

      for (const [action, [sha, version]] of reviewedActions) {
        const annotatedCount = [
          ...source.matchAll(
            new RegExp(
              `^\\s*(?:-\\s*)?uses:\\s*["']?${escapeRegex(`${action}@${sha}`)}["']?\\s+#\\s+${escapeRegex(version)}\\s*$`,
              "gm",
            ),
          ),
        ].length;
        expect(annotatedCount, `${file}: annotated occurrences for ${action}`).toBe(
          parsedCounts.get(action) ?? 0,
        );
      }
    }

    expect([...seen].sort()).toEqual([...reviewedActions.keys()].sort());
  });

  it("enforces registry age, source, and trust-downgrade checks", () => {
    expect(workspace).toMatch(/^blockExoticSubdeps: true$/m);
    expect(workspace).toMatch(/^minimumReleaseAge: 10080$/m);
    expect(workspace).toMatch(/^trustPolicy: no-downgrade$/m);
    expect(workspace).not.toContain("not a real pnpm");
  });

  it("fails before tagging when any production publish prerequisite is absent", () => {
    const releasePlease = job(release, "release-please", "verify-release");
    expect(releasePlease).toContain("visibility");
    expect(releasePlease).toContain("NPM_TOKEN");
    expect(releasePlease).toContain("DOCKERHUB_USERNAME");
    expect(releasePlease).toContain("DOCKERHUB_TOKEN");
    expect(releasePlease).toContain('if [ "$current_sha" != "$TESTED_SHA" ]');
    expect(releasePlease.indexOf('if [ -z "$DOCKERHUB_USERNAME" ]')).toBeLessThan(
      releasePlease.indexOf("Create the CI-gated GitHub release"),
    );
    expect(releasePlease).toContain('npm --userconfig "$npmrc" whoami');
    expect(releasePlease).toContain("org ls ambitresearch --json");
    expect(releasePlease).toContain("JSON.parse(process.env.ORG_MEMBERS)");
    expect(releasePlease).toContain("Object.hasOwn(members, npmUser)");
    expect(releasePlease).toContain("access list packages @ambitresearch");
    expect(releasePlease).toContain('docker --config "$docker_config" login docker.io');
    expect(releasePlease.indexOf("Validate production registry authentication")).toBeLessThan(
      releasePlease.indexOf("Create the CI-gated GitHub release"),
    );
  });

  it("uses the transferred repository identity for releases and usage accounting", () => {
    const workflowIdentity =
      "https://github.com/ambitresearch/genie/.github/workflows/release.yml@refs/heads/main";
    expect(release.match(/CERTIFICATE_IDENTITY:/g)).toHaveLength(5);
    expect([...release.matchAll(new RegExp(escapeRegex(workflowIdentity), "g"))]).toHaveLength(5);
    expect(release).not.toContain("https://github.com/roshangautam/genie");

    expect(runnerGuard).toContain("OWNER: ${{ github.repository_owner }}");
    expect(runnerGuard).toContain("/organizations/${OWNER}/settings/billing/usage");
    expect(runnerGuard).not.toContain("/users/${OWNER}/settings/billing/usage");
    expect(runnerGuard).toContain("/repos/${OWNER}/${REPO}/actions/runners");
    expect(runnerGuard).toContain('select(.status == "online")');
    expect(runnerGuard).toContain('[ "${online_runners:-0}" -gt 0 ]');
  });

  it.each([
    { used: 2_799, online: 0, expected: '["ubuntu-latest"]' },
    { used: 2_799, online: 1, expected: '["ubuntu-latest"]' },
    { used: 2_800, online: 0, expected: '["ubuntu-latest"]' },
    { used: 2_800, online: 1, expected: '["self-hosted"]' },
  ])(
    "routes $used used minutes with $online online runners to $expected",
    ({ used, online, expected }) => {
      const workflow = parse(runnerGuard) as {
        jobs: { guard: { steps: Array<{ run?: string }> } };
      };
      const script = workflow.jobs.guard.steps.find((step) => step.run)?.run;
      expect(script).toBeDefined();

      const fakeBin = mkdtempSync(join(tmpdir(), "genie-runner-guard-"));
      const targetFile = join(fakeBin, "target");
      try {
        writeFileSync(
          join(fakeBin, "date"),
          '#!/bin/sh\ncase "$*" in *%Y*) echo 2026 ;; *) echo 7 ;; esac\n',
        );
        writeFileSync(
          join(fakeBin, "gh"),
          `#!/bin/sh
if [ "$1" = api ]; then
  case "$2" in
    /organizations/*/settings/billing/usage*) echo "$FAKE_USED" ;;
    /repos/*/actions/runners*) echo "$FAKE_ONLINE" ;;
    /repos/*/actions/variables/RUNS_ON) echo '["stale"]' ;;
    *) exit 1 ;;
  esac
elif [ "$1" = variable ] && [ "$2" = set ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --body ]; then printf '%s' "$2" > "$FAKE_TARGET_FILE"; exit 0; fi
    shift
  done
  exit 1
else
  exit 1
fi
`,
        );
        chmodSync(join(fakeBin, "date"), 0o755);
        chmodSync(join(fakeBin, "gh"), 0o755);

        execFileSync("/bin/bash", ["-c", script!], {
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            GH_TOKEN: "test-token",
            OWNER: "ambitresearch",
            REPO: "genie",
            THRESHOLD: "2800",
            FAKE_USED: String(used),
            FAKE_ONLINE: String(online),
            FAKE_TARGET_FILE: targetFile,
          },
          stdio: "pipe",
        });

        expect(readFileSync(targetFile, "utf8")).toBe(expected);
      } finally {
        rmSync(fakeBin, { recursive: true, force: true });
      }
    },
  );

  it("publishes source metadata from the Ambit Research repository", () => {
    const gitUrl = "git+https://github.com/ambitresearch/genie.git";
    expect(rootPackage.repository.url).toBe(gitUrl);
    expect(serverPackage.repository.url).toBe(gitUrl);
    expect(viewerPackage.repository.url).toBe(gitUrl);
    expect(mcpbManifest.repository.url).toBe("https://github.com/ambitresearch/genie");
    expect(mcpbManifest.homepage).toBe("https://github.com/ambitresearch/genie");
    expect(mcpbManifest.documentation).toBe("https://github.com/ambitresearch/genie#readme");
    expect(mcpbManifest.support).toBe("https://github.com/ambitresearch/genie/issues");
  });

  it("ships release-verification guidance in both npm packages", () => {
    const verificationGuide =
      "https://github.com/ambitresearch/genie/blob/main/docs/supply-chain.md#verifying-a-release";

    for (const packagePath of ["packages/server", "packages/viewer"]) {
      const readme = readFileSync(resolve(repoRoot, packagePath, "README.md"), "utf8");
      expect(readme, packagePath).toContain(verificationGuide);
      expect(readme, packagePath).toContain("npm audit signatures");
      expect(readme, packagePath).toContain("cosign verify-blob");
    }
  });

  it("signs and verifies the exact npm tarballs and SBOMs before publishing", () => {
    const dryRun = job(release, "publish-dry-run", "release-please");
    expect(dryRun).toContain("Generate CycloneDX SBOM");
    expect(dryRun).toContain("node scripts/generate-package-sbom.mjs");
    expect(dryRun).toContain("npm pack --json");
    expect(dryRun).toContain('npm publish "$tmp_dir/$filename" --dry-run');

    for (const [name, nextName, packageName] of [
      ["publish-server", "publish-viewer", "@ambitresearch/genie"],
      ["publish-viewer", "publish-mcpb", "@ambitresearch/genie-viewer"],
    ] as const) {
      const source = job(release, name, nextName);
      expect(source).toContain(`name: publish ${packageName} (npm)`);
      expect(source).toContain("npm pack --json");
      expect(source).toContain("node scripts/generate-package-sbom.mjs");
      expect(source).toContain("cosign sign-blob --yes --bundle");
      expect(source).toContain("cosign verify-blob --bundle");
      expect(source).toContain('--certificate-identity="$CERTIFICATE_IDENTITY"');
      expect(source).toContain('--certificate-oidc-issuer="$CERTIFICATE_OIDC_ISSUER"');
      expect(source).toContain("*.tgz");
      expect(source).toContain("*.tgz.sig");
      expect(source).toContain("-sbom.cdx.json");
      expect(source).toContain("-sbom.cdx.json.sig");
      expect(source).toContain("SIGNING_SHA: ${{ github.sha }}");
      expect(source).toContain('--certificate-github-workflow-sha="$SIGNING_SHA"');

      const pack = source.indexOf("npm pack --json");
      const sign = source.indexOf("cosign sign-blob --yes --bundle");
      const verify = source.indexOf("cosign verify-blob --bundle");
      const publish = source.lastIndexOf('npm publish "$TARBALL"');
      expect(pack).toBeLessThan(sign);
      expect(sign).toBeLessThan(verify);
      expect(verify).toBeLessThan(publish);
    }
  });

  it("selects a non-empty package-scoped production SBOM closure", () => {
    const manifest = {
      name: "@ambitresearch/example",
      version: "1.2.3",
      description: "fixture",
      license: "MIT",
      dependencies: { direct: "1.0.0", "@scope/other": "2.0.0" },
      optionalDependencies: { "root-optional": "5.0.0" },
      devDependencies: { "dev-only": "3.0.0" },
    };
    const rootRef = "pkg:npm/@ambitresearch/example@1.2.3";
    const directRef = "pkg:npm/direct@1.0.0";
    const scopedRef = "pkg:npm/@scope/other@2.0.0";
    const transitiveRef = "pkg:npm/transitive@4.0.0";
    const platformRef = "pkg:npm/@scope/platform@4.0.0";
    const rootOptionalRef = "pkg:npm/root-optional@5.0.0";
    const devRef = "pkg:npm/dev-only@3.0.0";
    const component = (ref: string, group: string, name: string, version: string) => ({
      "bom-ref": ref,
      purl: ref,
      group,
      name,
      version,
      type: "library",
    });
    const workspaceBom = {
      metadata: {
        tools: { components: [] },
        component: {
          components: [component(rootRef, "@ambitresearch", "example", "1.2.3")],
        },
      },
      components: [
        component(directRef, "", "direct", "1.0.0"),
        component(scopedRef, "@scope", "other", "2.0.0"),
        component(transitiveRef, "", "transitive", "4.0.0"),
        component(platformRef, "@scope", "platform", "4.0.0"),
        component(rootOptionalRef, "", "root-optional", "5.0.0"),
        component(devRef, "", "dev-only", "3.0.0"),
      ],
      dependencies: [
        { ref: rootRef, dependsOn: [directRef, scopedRef, devRef] },
        { ref: directRef, dependsOn: [transitiveRef] },
        { ref: scopedRef, dependsOn: [] },
        { ref: transitiveRef, dependsOn: [] },
        { ref: platformRef, dependsOn: [] },
        { ref: rootOptionalRef, dependsOn: [] },
        { ref: devRef, dependsOn: [] },
      ],
    };

    const optionalEdges = collectPnpmOptionalDependencyEdges(
      workspaceBom,
      {
        importers: {
          "packages/example": {
            optionalDependencies: { "root-optional": { version: "5.0.0" } },
          },
        },
        snapshots: {
          "direct@1.0.0": {
            optionalDependencies: { "@scope/platform": "4.0.0" },
          },
        },
      },
      manifest,
      "packages/example",
    );
    expect(() =>
      collectPnpmOptionalDependencyEdges(
        { ...workspaceBom, components: workspaceBom.components.slice(1) },
        {
          snapshots: {
            "direct@1.0.0": {
              optionalDependencies: { "@scope/platform": "4.0.0" },
            },
          },
        },
        manifest,
        "packages/example",
      ),
    ).toThrow(/no component for optional dependency parent direct@1\.0\.0/);
    expect(() =>
      collectPnpmOptionalDependencyEdges(
        {
          ...workspaceBom,
          components: workspaceBom.components.filter((entry) => entry["bom-ref"] !== platformRef),
        },
        {
          snapshots: {
            "direct@1.0.0": {
              optionalDependencies: { "@scope/platform": "4.0.0" },
            },
          },
        },
        manifest,
        "packages/example",
      ),
    ).toThrow(/no component for optional dependency @scope\/platform@4\.0\.0/);
    const bom = selectPackageClosure(workspaceBom, manifest, optionalEdges);
    expect(`${bom.metadata.component.group}/${bom.metadata.component.name}`).toBe(manifest.name);
    expect(bom.metadata.component.version).toBe(manifest.version);
    expect(bom.dependencies[0].dependsOn).toEqual([scopedRef, directRef, rootOptionalRef].sort());
    expect(bom.components.map((entry: { "bom-ref": string }) => entry["bom-ref"])).toEqual(
      [directRef, scopedRef, transitiveRef, platformRef, rootOptionalRef].sort(),
    );
    expect(
      bom.dependencies.find((entry: { ref: string }) => entry.ref === directRef)?.dependsOn,
    ).toEqual([platformRef, transitiveRef].sort());
    expect(JSON.stringify(bom)).not.toContain("dev-only");
    const generator = readFileSync(sbomScript, "utf8");
    expect(generator).toContain('"--no-recurse"');
    expect(generator).toContain('"--no-install-deps"');
    expect(generator).toContain('"--fail-on-error"');
    expect(generator).not.toContain('"--required-only"');
    expect(generator).toContain('"--strict"');
  });

  it("fails closed when the workspace SBOM is stale or incomplete", () => {
    const manifest = {
      name: "@ambitresearch/example",
      version: "1.2.3",
      dependencies: { direct: "1.0.0" },
    };
    const rootRef = "pkg:npm/@ambitresearch/example@1.2.3";
    const directRef = "pkg:npm/direct@1.0.0";
    const root = {
      "bom-ref": rootRef,
      purl: rootRef,
      group: "@ambitresearch",
      name: "example",
      version: "1.2.3",
      type: "application",
    };

    expect(() =>
      selectPackageClosure({ metadata: { component: { components: [] } } }, manifest),
    ).toThrow(/does not contain/);
    expect(() =>
      selectPackageClosure(
        {
          metadata: { component: { components: [root] } },
          components: [],
          dependencies: [],
        },
        manifest,
      ),
    ).toThrow(/has no dependency graph for @ambitresearch\/example/);
    expect(() =>
      selectPackageClosure(
        {
          metadata: { component: { components: [root] } },
          components: [],
          dependencies: [{ ref: rootRef, dependsOn: [] }],
        },
        manifest,
      ),
    ).toThrow(/missing runtime dependencies/);
    expect(() =>
      selectPackageClosure(
        {
          metadata: { component: { components: [root] } },
          components: [],
          dependencies: [{ ref: rootRef, dependsOn: [directRef] }],
        },
        manifest,
      ),
    ).toThrow(/has no component record/);
    expect(() =>
      selectPackageClosure(
        {
          metadata: { component: { components: [root] } },
          components: [
            {
              "bom-ref": directRef,
              purl: directRef,
              group: "",
              name: "direct",
              version: "1.0.0",
              type: "library",
            },
          ],
          dependencies: [{ ref: rootRef, dependsOn: [directRef] }],
        },
        manifest,
      ),
    ).toThrow(/component pkg:npm\/direct@1\.0\.0 has no dependency graph entry/);
  });

  it("signs and verifies the Desktop bundle and both image digests", () => {
    const mcpb = job(release, "publish-mcpb", "docker-publish-ghcr");
    expect(mcpb).toContain("cosign sign-blob --yes --bundle dist/genie.mcpb.sig");
    expect(mcpb).toContain("cosign verify-blob --bundle dist/genie.mcpb.sig");
    expect(mcpb).toContain("dist/genie.mcpb.sig");

    for (const [name, nextName] of [
      ["docker-publish-ghcr", "docker-publish-dockerhub"],
      ["docker-publish-dockerhub", undefined],
    ] as const) {
      const source = job(release, name, nextName);
      expect(source).toContain("cosign sign --yes");
      expect(source).toContain("cosign verify");
      expect(source).toContain("staging-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}");
      expect(source).toContain("docker buildx imagetools create");
      expect(source).toContain("--metadata-file promotion.json");
      expect(source).toContain('test "$promoted_digest" = "$BUILD_DIGEST"');
      expect(source).toContain('--certificate-identity="$CERTIFICATE_IDENTITY"');
      expect(source).toContain('--certificate-oidc-issuer="$CERTIFICATE_OIDC_ISSUER"');
      expect(source).toContain("SIGNING_SHA: ${{ github.sha }}");
      expect(source).toContain('--certificate-github-workflow-sha="$SIGNING_SHA"');
      const build = source.indexOf("Build and push staging multi-arch image");
      const sign = source.indexOf("cosign sign --yes");
      const verify = source.indexOf("cosign verify");
      const promote = source.indexOf("docker buildx imagetools create");
      expect(build).toBeLessThan(sign);
      expect(sign).toBeLessThan(verify);
      expect(verify).toBeLessThan(promote);
    }
  });

  it("keeps component releases draft until every applicable publish path succeeds", () => {
    expect(releasePleaseConfig.draft).toBe(true);
    expect(releasePleaseConfig["force-tag-creation"]).toBe(true);

    const finalize = job(release, "finalize-releases");
    for (const dependency of [
      "publish-server",
      "publish-viewer",
      "publish-mcpb",
      "docker-publish-ghcr",
      "docker-publish-dockerhub",
    ]) {
      expect(finalize).toContain(dependency);
      expect(finalize).toContain(`needs.${dependency}.result`);
    }
    expect(finalize).toContain("always()");
    expect(finalize).toContain("npm view");
    expect(finalize).toContain("dist.attestations.provenance.predicateType");
    expect(finalize).toContain("https://slsa.dev/provenance/v1");
    expect(finalize).toContain("genie-server-sbom.cdx.json");
    expect(finalize).toContain("genie-viewer-sbom.cdx.json");
    expect(finalize).toContain("genie.mcpb");

    for (const [name, nextName] of [
      ["publish-server", "publish-viewer"],
      ["publish-viewer", "publish-mcpb"],
      ["publish-mcpb", "docker-publish-ghcr"],
    ] as const) {
      const source = job(release, name, nextName);
      expect(source).toContain("softprops/action-gh-release");
      expect(source).toContain("draft: true");
    }

    const verify = finalize.indexOf("Verify draft release assets and live registries");
    const publish = finalize.indexOf(
      'gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false',
    );
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(publish);

    for (const [name, nextName] of [
      ["docker-publish-ghcr", "docker-publish-dockerhub"],
      ["docker-publish-dockerhub", "finalize-releases"],
    ] as const) {
      const source = job(release, name, nextName);
      expect(source.indexOf("Promote verified")).toBeLessThan(
        source.indexOf("Verify promoted release tag"),
      );
      expect(source).toContain("docker buildx imagetools inspect");
      expect(source).toContain('for tag in "$VERSION" latest');
      expect(source).toContain('test "$published_digest" = "$BUILD_DIGEST"');
    }
  });

  it("runs a digest-pinned full-history secret scan with exact fixture tokens only", () => {
    expect(ci).toContain("fetch-depth: 0");
    expect(ci).toContain(
      "ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
    );
    expect(ci).toContain("git --config .gitleaks.toml --redact");

    expect(gitleaks).toContain("useDefault = true");
    expect(gitleaks).toContain('id = "generic-api-key"');
    expect(gitleaks).toContain('regexTarget = "secret"');
    expect(gitleaks).not.toMatch(/^\s*(?:paths|commits|stopwords)\s*=/m);

    const allowedValues = [...gitleaks.matchAll(/'''(\^[^']+\$)'''/g)].map((match) => match[1]);
    expect(allowedValues).toEqual([
      "^genie-e2e-alice-pw$",
      "^genie-e2e-mallory-pw$",
      "^hs256-abcdefghijklmnopqrstuvwxyz$",
      "^sk-0123456789abcdef$",
      "^VALID_HS256_KEY$",
    ]);
  });
});

function collectUses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectUses);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (key === "uses") {
      if (typeof child !== "string") throw new Error("workflow uses entry must be a string");
      return [child];
    }
    return collectUses(child);
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
