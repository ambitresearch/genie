import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { selectPackageClosure } from "../../../scripts/generate-package-sbom.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowsRoot = resolve(repoRoot, ".github/workflows");
const ci = readFileSync(resolve(workflowsRoot, "ci.yml"), "utf8");
const release = readFileSync(resolve(workflowsRoot, "release.yml"), "utf8");
const workspace = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8");
const gitleaks = readFileSync(resolve(repoRoot, ".gitleaks.toml"), "utf8");
const sbomScript = resolve(repoRoot, "scripts/generate-package-sbom.mjs");

const workflowFiles = readdirSync(workflowsRoot)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => ({ file, source: readFileSync(resolve(workflowsRoot, file), "utf8") }));

const reviewedActions = new Map(
  Object.entries({
    "actions/checkout": ["34e114876b0b11c390a56381ad16ebd13914f8d5", "v4.3.1"],
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
      for (const uses of usesEntries) {
        if (uses.startsWith("./")) continue;
        const separator = uses.lastIndexOf("@");
        expect(separator, `${file}: malformed uses entry ${uses}`).toBeGreaterThan(0);
        const action = uses.slice(0, separator);
        const reviewed = reviewedActions.get(action);
        expect(reviewed, `${file}: unreviewed third-party action ${action}`).toBeDefined();
        const [sha, version] = reviewed!;
        expect(uses, `${file}: ${action}`).toBe(`${action}@${sha}`);
        expect(source, `${file}: provenance annotation for ${action}`).toMatch(
          new RegExp(
            `^\\s*(?:-\\s*)?uses:\\s*["']?${escapeRegex(uses)}["']?\\s+#\\s+${escapeRegex(version)}\\s*$`,
            "m",
          ),
        );
        seen.add(action);
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
    expect(releasePlease).toContain('org ls ambitresearch "$npm_user"');
    expect(releasePlease).toContain("access list packages @ambitresearch");
    expect(releasePlease).toContain('docker --config "$docker_config" login docker.io');
    expect(releasePlease.indexOf("Validate production registry authentication")).toBeLessThan(
      releasePlease.indexOf("Create the CI-gated GitHub release"),
    );
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
      devDependencies: { "dev-only": "3.0.0" },
    };
    const rootRef = "pkg:npm/@ambitresearch/example@1.2.3";
    const directRef = "pkg:npm/direct@1.0.0";
    const scopedRef = "pkg:npm/@scope/other@2.0.0";
    const transitiveRef = "pkg:npm/transitive@4.0.0";
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
        component(devRef, "", "dev-only", "3.0.0"),
      ],
      dependencies: [
        { ref: rootRef, dependsOn: [directRef, scopedRef, devRef] },
        { ref: directRef, dependsOn: [transitiveRef] },
        { ref: scopedRef, dependsOn: [] },
        { ref: transitiveRef, dependsOn: [] },
        { ref: devRef, dependsOn: [] },
      ],
    };

    const bom = selectPackageClosure(workspaceBom, manifest);
    expect(`${bom.metadata.component.group}/${bom.metadata.component.name}`).toBe(manifest.name);
    expect(bom.metadata.component.version).toBe(manifest.version);
    expect(bom.dependencies[0].dependsOn).toEqual([scopedRef, directRef].sort());
    expect(bom.components.map((entry: { "bom-ref": string }) => entry["bom-ref"])).toEqual(
      [directRef, scopedRef, transitiveRef].sort(),
    );
    expect(JSON.stringify(bom)).not.toContain("dev-only");
    expect(readFileSync(sbomScript, "utf8")).toContain('"--no-recurse"');
    expect(readFileSync(sbomScript, "utf8")).toContain('"--no-install-deps"');
    expect(readFileSync(sbomScript, "utf8")).toContain('"--strict"');
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
      expect(source).toContain('--certificate-identity="$CERTIFICATE_IDENTITY"');
      expect(source).toContain('--certificate-oidc-issuer="$CERTIFICATE_OIDC_ISSUER"');
      expect(source).toContain("SIGNING_SHA: ${{ github.sha }}");
      expect(source).toContain('--certificate-github-workflow-sha="$SIGNING_SHA"');
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
