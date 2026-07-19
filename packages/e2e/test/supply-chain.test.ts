import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
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

function job(source: string, name: string, nextName?: string): string {
  const start = source.indexOf(`  ${name}:`);
  expect(start, `${name} job`).toBeGreaterThanOrEqual(0);
  const end = nextName === undefined ? source.length : source.indexOf(`  ${nextName}:`, start);
  expect(end, `${nextName ?? "end"} boundary`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("supply-chain policy", () => {
  it("pins every third-party workflow action to a reviewed commit", () => {
    const usesPattern = /^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+)(?:\s+#\s+(\S+))?\s*$/gm;

    for (const { file, source } of workflowFiles) {
      for (const match of source.matchAll(usesPattern)) {
        const [, action, ref, version] = match;
        if (!action || !ref) throw new Error(`${file}: malformed uses entry`);
        if (action.startsWith("./")) continue;
        expect(ref, `${file}: ${action}`).toMatch(/^[0-9a-f]{40}$/);
        expect(version, `${file}: ${action}`).toMatch(/^v\d+\.\d+\.\d+$/);
      }
    }
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
