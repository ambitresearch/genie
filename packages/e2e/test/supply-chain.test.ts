import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function releaseStep(jobName: string, stepName: string): string {
  const workflow = parse(release) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const script = workflow.jobs[jobName]?.steps?.find((step) => step.name === stepName)?.run;
  expect(script, `${jobName}: ${stepName}`).toBeDefined();
  return script!;
}

function runReleaseStep(
  jobName: string,
  stepName: string,
  options: {
    commands?: Record<string, string>;
    env?: Record<string, string>;
  } = {},
): { status: number; stdout: string; stderr: string; log: string } {
  const fakeBin = mkdtempSync(join(tmpdir(), "genie-release-step-"));
  const logFile = join(fakeBin, "commands.log");
  try {
    for (const [name, source] of Object.entries(options.commands ?? {})) {
      const path = join(fakeBin, name);
      writeFileSync(path, source.endsWith("\n") ? source : `${source}\n`);
      chmodSync(path, 0o755);
    }

    const result = spawnSync("/bin/bash", ["-c", releaseStep(jobName, stepName)], {
      cwd: fakeBin,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_LOG: logFile,
        GITHUB_REPOSITORY: "ambitresearch/genie",
        GITHUB_RUN_ATTEMPT: "1",
        ...options.env,
      },
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
    };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

const recoveryGuardCommands = {
  npm: [
    "#!/bin/sh",
    'case "$2" in',
    "  @ambitresearch/genie) printf '%s\\n' \"$FAKE_SERVER_LATEST\" ;;",
    "  @ambitresearch/genie-viewer) printf '%s\\n' \"$FAKE_VIEWER_LATEST\" ;;",
    "  *) exit 64 ;;",
    "esac",
  ].join("\n"),
  gh: [
    "#!/bin/sh",
    'if [ "$1" = release ] && [ "$2" = view ]; then',
    "  tag=$3",
    "  shift 3",
    "  field=",
    '  while [ "$#" -gt 0 ]; do',
    '    if [ "$1" = --json ]; then field=$2; break; fi',
    "    shift",
    "  done",
    '  case "$tag:$field" in',
    '    "$SERVER_TAG:isDraft") printf \'%s\\n\' "$FAKE_SERVER_DRAFT" ;;',
    '    "$SERVER_TAG:isImmutable") printf \'%s\\n\' "$FAKE_SERVER_IMMUTABLE" ;;',
    "    \"$SERVER_TAG:targetCommitish\") printf '%s\\n' server-target ;;",
    '    "$VIEWER_TAG:isDraft") printf \'%s\\n\' "$FAKE_VIEWER_DRAFT" ;;',
    '    "$VIEWER_TAG:isImmutable") printf \'%s\\n\' "$FAKE_VIEWER_IMMUTABLE" ;;',
    "    \"$VIEWER_TAG:targetCommitish\") printf '%s\\n' viewer-target ;;",
    "    *) exit 65 ;;",
    "  esac",
    'elif [ "$1" = api ]; then',
    "  endpoint=$2",
    '  if [ "$endpoint" = "repos/$GITHUB_REPOSITORY/commits/$SERVER_TAG" ]; then',
    "    printf '%s\\n' \"$FAKE_SERVER_TAG_SHA\"",
    '  elif [ "$endpoint" = "repos/$GITHUB_REPOSITORY/commits/server-target" ]; then',
    "    printf '%s\\n' \"$FAKE_SERVER_TARGET_SHA\"",
    '  elif [ "$endpoint" = "repos/$GITHUB_REPOSITORY/commits/$VIEWER_TAG" ]; then',
    "    printf '%s\\n' \"$FAKE_VIEWER_TAG_SHA\"",
    '  elif [ "$endpoint" = "repos/$GITHUB_REPOSITORY/commits/viewer-target" ]; then',
    "    printf '%s\\n' \"$FAKE_VIEWER_TARGET_SHA\"",
    "  else",
    "    exit 66",
    "  fi",
    "else",
    "  exit 67",
    "fi",
  ].join("\n"),
};

const recoveryGuardEnv = {
  GITHUB_REF: "refs/heads/main",
  SERVER_TAG: "server-v1.3.1",
  VIEWER_TAG: "viewer-v0.1.1",
  FAKE_SERVER_LATEST: "1.3.1",
  FAKE_VIEWER_LATEST: "0.1.1",
  FAKE_SERVER_DRAFT: "true",
  FAKE_SERVER_IMMUTABLE: "false",
  FAKE_VIEWER_DRAFT: "true",
  FAKE_VIEWER_IMMUTABLE: "false",
  FAKE_SERVER_TAG_SHA: "sha-shared",
  FAKE_SERVER_TARGET_SHA: "sha-shared",
  FAKE_VIEWER_TAG_SHA: "sha-shared",
  FAKE_VIEWER_TARGET_SHA: "sha-shared",
};

const dockerPlatformCommand = [
  "#!/bin/sh",
  'printf \'docker %s\\n\' "$*" >> "$FAKE_LOG"',
  'test "$*" = "buildx imagetools inspect $EXPECTED_IMAGE@$BUILD_DIGEST --raw"',
  "printf '%s\\n' \"$FAKE_MANIFEST\"",
].join("\n");

const dockerPromotionCommand = [
  "#!/bin/sh",
  'printf \'docker %s\\n\' "$*" >> "$FAKE_LOG"',
  'test "$*" = "buildx imagetools create --tag $EXPECTED_IMAGE:$VERSION --tag $EXPECTED_IMAGE:latest --metadata-file promotion.json $EXPECTED_IMAGE@$BUILD_DIGEST"',
  'printf \'{"containerimage.descriptor":{"digest":"%s"}}\' "$FAKE_PROMOTION_DIGEST" > promotion.json',
].join("\n");

const dockerLiveTagCommand = [
  "#!/bin/sh",
  'printf \'docker %s\\n\' "$*" >> "$FAKE_LOG"',
  'test "$1" = buildx',
  'test "$2" = imagetools',
  'test "$3" = inspect',
  'case "$4" in',
  '  "$EXPECTED_IMAGE:$VERSION") key=version; digest=$FAKE_VERSION_DIGEST; success_attempt=${FAKE_VERSION_SUCCESS_ATTEMPT:-1} ;;',
  '  "$EXPECTED_IMAGE:latest") key=latest; digest=$FAKE_LATEST_DIGEST; success_attempt=${FAKE_LATEST_SUCCESS_ATTEMPT:-1} ;;',
  "  *) exit 64 ;;",
  "esac",
  'attempt_file="$FAKE_LOG.$key-attempts"',
  'attempt=$(cat "$attempt_file" 2>/dev/null || printf 0)',
  "attempt=$((attempt + 1))",
  'printf \'%s\\n\' "$attempt" > "$attempt_file"',
  'if [ "$attempt" -lt "$success_attempt" ]; then digest=${FAKE_TRANSIENT_DIGEST:-sha256:stale}; fi',
  "printf 'Name: fixture\\nDigest: %s\\n' \"$digest\"",
].join("\n");

const transientCosignCommand = [
  "#!/bin/sh",
  'printf \'cosign %s\\n\' "$*" >> "$FAKE_LOG"',
  'if [ "$1" = sign ]; then exit 0; fi',
  'test "$1" = verify',
  'attempt_file="$FAKE_LOG.cosign-attempts"',
  'attempt=$(cat "$attempt_file" 2>/dev/null || printf 0)',
  "attempt=$((attempt + 1))",
  'printf \'%s\\n\' "$attempt" > "$attempt_file"',
  'test "$attempt" -ge "${FAKE_COSIGN_SUCCESS_ATTEMPT:-1}"',
].join("\n");

const fakeSleepCommand = ["#!/bin/sh", 'printf \'sleep %s\\n\' "$*" >> "$FAKE_LOG"'].join("\n");

const recoveryFinalizeGhCommand = [
  "#!/bin/sh",
  'if [ "$1" = release ] && [ "$2" = view ]; then',
  "  tag=$3",
  "  shift 3",
  "  field=",
  '  while [ "$#" -gt 0 ]; do',
  '    if [ "$1" = --json ]; then field=$2; break; fi',
  "    shift",
  "  done",
  '  case "$tag:$field" in',
  '    "$SERVER_TAG:isDraft") printf \'%s\\n\' "$FAKE_SERVER_DRAFT" ;;',
  '    "$SERVER_TAG:isImmutable") printf \'%s\\n\' "$FAKE_SERVER_IMMUTABLE" ;;',
  '    "$SERVER_TAG:assets") printf \'%s\\n\' "$FAKE_SERVER_ASSETS" ;;',
  '    "$VIEWER_TAG:isDraft") printf \'%s\\n\' "$FAKE_VIEWER_DRAFT" ;;',
  '    "$VIEWER_TAG:isImmutable") printf \'%s\\n\' "$FAKE_VIEWER_IMMUTABLE" ;;',
  '    "$VIEWER_TAG:assets") printf \'%s\\n\' "$FAKE_VIEWER_ASSETS" ;;',
  "    *) exit 65 ;;",
  "  esac",
  'elif [ "$1" = release ] && [ "$2" = download ]; then',
  "  tag=$3",
  "  shift 3",
  "  dir=",
  '  while [ "$#" -gt 0 ]; do',
  '    if [ "$1" = --dir ]; then dir=$2; break; fi',
  "    shift",
  "  done",
  '  mkdir -p "$dir"',
  '  if [ "$tag" = "$SERVER_TAG" ]; then assets=$FAKE_SERVER_ASSETS; else assets=$FAKE_VIEWER_ASSETS; fi',
  '  for asset in $assets; do : > "$dir/$asset"; done',
  'elif [ "$1" = release ] && [ "$2" = edit ]; then',
  '  printf \'edit %s\\n\' "$3" >> "$FAKE_LOG"',
  '  if [ "${FAKE_EDIT_FAIL_TAG:-}" = "$3" ]; then exit 42; fi',
  "else",
  "  exit 66",
  "fi",
].join("\n");

const recoveryFinalizeNpmCommand = [
  "#!/bin/sh",
  'printf \'npm %s|%s|%s\\n\' "$1" "$2" "$3" >> "$FAKE_LOG"',
  'case "$2:$3" in',
  "  @ambitresearch/genie@*:version) printf '%s\\n' \"${2##*@}\" ;;",
  "  @ambitresearch/genie-viewer@*:version) printf '%s\\n' \"${2##*@}\" ;;",
  "  @ambitresearch/genie@*:dist.attestations.provenance.predicateType)",
  "    printf '%s\\n' \"$FAKE_SERVER_PROVENANCE\" ;;",
  "  @ambitresearch/genie-viewer@*:dist.attestations.provenance.predicateType)",
  "    printf '%s\\n' \"$FAKE_VIEWER_PROVENANCE\" ;;",
  "  *) exit 64 ;;",
  "esac",
].join("\n");

const recoveryFinalizeCosignCommand = [
  "#!/bin/sh",
  'printf \'cosign %s\\n\' "$*" >> "$FAKE_LOG"',
  'test "${FAKE_COSIGN_FAIL:-0}" = 0',
].join("\n");

const serverRecoveryAssets = [
  "ambitresearch-genie-1.3.1.tgz",
  "ambitresearch-genie-1.3.1.tgz.sig",
  "genie-server-sbom.cdx.json",
  "genie-server-sbom.cdx.json.sig",
  "genie.mcpb",
  "genie.mcpb.sig",
].join("\n");
const viewerRecoveryAssets = [
  "ambitresearch-genie-viewer-0.1.1.tgz",
  "ambitresearch-genie-viewer-0.1.1.tgz.sig",
  "genie-viewer-sbom.cdx.json",
  "genie-viewer-sbom.cdx.json.sig",
].join("\n");

const recoveryFinalizeEnv = {
  SERVER_TAG: "server-v1.3.1",
  VIEWER_TAG: "viewer-v0.1.1",
  CERTIFICATE_IDENTITY:
    "https://github.com/ambitresearch/genie/.github/workflows/release.yml@refs/heads/main",
  CERTIFICATE_OIDC_ISSUER: "https://token.actions.githubusercontent.com",
  FAKE_SERVER_DRAFT: "true",
  FAKE_SERVER_IMMUTABLE: "false",
  FAKE_VIEWER_DRAFT: "true",
  FAKE_VIEWER_IMMUTABLE: "false",
  FAKE_SERVER_ASSETS: serverRecoveryAssets,
  FAKE_VIEWER_ASSETS: viewerRecoveryAssets,
  FAKE_SERVER_PROVENANCE: "https://slsa.dev/provenance/v1",
  FAKE_VIEWER_PROVENANCE: "https://slsa.dev/provenance/v1",
};

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
    expect(release.match(/CERTIFICATE_IDENTITY:/g)).toHaveLength(8);
    expect([...release.matchAll(new RegExp(escapeRegex(workflowIdentity), "g"))]).toHaveLength(8);
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
    expect(dryRun).toContain('ci_version="0.0.0-ci.${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}"');
    expect(dryRun).toContain('npm pkg set "version=$ci_version"');
    expect(dryRun.indexOf('npm pkg set "version=$ci_version"')).toBeLessThan(
      dryRun.indexOf("npm pack --json"),
    );
    expect(dryRun).toContain("npm pack --json");
    expect(dryRun).toContain('npm publish "$tmp_dir/$filename" --dry-run');
    expect(dryRun).toContain("--provenance --access public --tag ci");

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
      expect(source).toContain("max_attempts=12");
      expect(source).toContain("sleep 5");
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
    expect(finalize).toContain("gh release view");
    expect(finalize).not.toContain("releases/tags/$tag");

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
      expect(source).toContain('[ "$published_digest" = "$BUILD_DIGEST" ]');
      expect(source).toContain("max_attempts=12");
      expect(source).toContain("sleep 5");
    }
  });

  it("recovers incomplete draft releases from main without republishing npm", () => {
    const parsed = parse(release) as {
      concurrency?: {
        group?: string;
        "cancel-in-progress"?: boolean;
      };
      on?: {
        workflow_dispatch?: {
          inputs?: Record<string, { required?: boolean; type?: string }>;
        };
      };
      jobs?: Record<string, { permissions?: Record<string, string> }>;
    };
    expect(parsed.on?.workflow_dispatch?.inputs).toMatchObject({
      server_tag: { required: true, type: "string" },
      viewer_tag: { required: true, type: "string" },
    });
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(parsed.concurrency?.group).toContain("github.event_name == 'pull_request'");
    expect(parsed.concurrency?.group).toContain("release-production");
    expect(parsed.jobs?.["recovery-guard"]?.permissions).toEqual({ contents: "write" });

    const guard = job(release, "recovery-guard", "recovery-docker-publish-ghcr");
    expect(guard).toContain("github.event_name == 'workflow_dispatch'");
    expect(guard).toContain("refs/heads/main");
    expect(guard).toContain("server-v*");
    expect(guard).toContain("viewer-v*");
    expect(guard).toContain("isDraft");
    expect(guard).toContain("isImmutable");
    expect(guard).toContain("gh release view");
    expect(guard).not.toContain("releases/tags/$tag");
    expect(guard).toContain("npm view @ambitresearch/genie dist-tags.latest");
    expect(guard).toContain("npm view @ambitresearch/genie-viewer dist-tags.latest");
    expect(guard).toContain('test "$server_latest" = "$server_version"');
    expect(guard).toContain('test "$viewer_latest" = "$viewer_version"');

    for (const [name, nextName, image] of [
      [
        "recovery-docker-publish-ghcr",
        "recovery-docker-publish-dockerhub",
        "ghcr.io/ambitresearch/genie",
      ],
      [
        "recovery-docker-publish-dockerhub",
        "recovery-finalize-releases",
        "docker.io/ambitresearch/genie",
      ],
    ] as const) {
      const source = job(release, name, nextName);
      expect(source).toContain("needs: recovery-guard");
      expect(source).toContain("ref: ${{ github.event.inputs.server_tag }}");
      expect(source).toContain("platforms: linux/amd64,linux/arm64");
      expect(source).toContain("sbom: true");
      expect(source).toContain("provenance: mode=max");
      expect(source).toContain(image);
      expect(source).toContain("recovery-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}");
      expect(source).toContain("cosign sign --yes");
      expect(source).toContain("cosign verify");
      expect(source).toContain("docker buildx imagetools create");
      expect(source).toContain('test "$promoted_digest" = "$BUILD_DIGEST"');
      expect(source).toContain("linux/amd64");
      expect(source).toContain("linux/arm64");
      expect(source).toContain('for tag in "$VERSION" latest');
      expect(source).toContain('[ "$published_digest" = "$BUILD_DIGEST" ]');
    }

    const finalize = job(release, "recovery-finalize-releases");
    expect(finalize).toContain("always()");
    expect(finalize).toContain("needs.recovery-guard.result");
    expect(finalize).toContain("needs.recovery-docker-publish-ghcr.result");
    expect(finalize).toContain("needs.recovery-docker-publish-dockerhub.result");
    expect(finalize).toContain("npm view");
    expect(finalize).toContain("dist.attestations.provenance.predicateType");
    expect(finalize).toContain("gh release download");
    expect(finalize).toContain("gh release view");
    expect(finalize).not.toContain("releases/tags/$tag");
    expect(finalize).toContain("cosign verify-blob --bundle");
    expect(finalize).toContain("genie-server-sbom.cdx.json");
    expect(finalize).toContain("genie-viewer-sbom.cdx.json");
    expect(finalize).toContain("genie.mcpb");

    const recovery = release.slice(release.indexOf("  recovery-guard:"));
    expect(recovery).not.toContain("npm publish");
    expect(recovery).not.toContain("softprops/action-gh-release");
    expect(recovery).not.toContain("gh release upload");
    const verify = finalize.indexOf("Verify existing npm provenance and signed release assets");
    const publish = finalize.indexOf(
      'gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false',
    );
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(publish);
  });

  it.each([
    { name: "accepts the current mutable component pair", env: {}, status: 0 },
    {
      name: "rejects a non-main dispatch",
      env: { GITHUB_REF: "refs/heads/fix/release" },
      status: 1,
    },
    {
      name: "rejects a malformed server tag",
      env: { SERVER_TAG: "v1.3.1" },
      status: 1,
    },
    {
      name: "rejects a malformed viewer tag",
      env: { VIEWER_TAG: "v0.1.1" },
      status: 1,
    },
    {
      name: "rejects a server version that is not npm latest",
      env: { FAKE_SERVER_LATEST: "1.4.0" },
      status: 1,
    },
    {
      name: "rejects a viewer version that is not npm latest",
      env: { FAKE_VIEWER_LATEST: "0.2.0" },
      status: 1,
    },
    {
      name: "rejects an already-published server release",
      env: { FAKE_SERVER_DRAFT: "false" },
      status: 1,
    },
    {
      name: "rejects an immutable server draft",
      env: { FAKE_SERVER_IMMUTABLE: "true" },
      status: 1,
    },
    {
      name: "rejects an already-published viewer release",
      env: { FAKE_VIEWER_DRAFT: "false" },
      status: 1,
    },
    {
      name: "rejects an immutable viewer draft",
      env: { FAKE_VIEWER_IMMUTABLE: "true" },
      status: 1,
    },
    {
      name: "rejects a server release whose tag and target disagree",
      env: { FAKE_SERVER_TARGET_SHA: "sha-other" },
      status: 1,
    },
    {
      name: "rejects a viewer release whose tag and target disagree",
      env: { FAKE_VIEWER_TARGET_SHA: "sha-other" },
      status: 1,
    },
    {
      name: "rejects component tags from different commits",
      env: { FAKE_VIEWER_TAG_SHA: "sha-other", FAKE_VIEWER_TARGET_SHA: "sha-other" },
      status: 1,
    },
  ])("executes the recovery guard and $name", ({ env, status }) => {
    const result = runReleaseStep(
      "recovery-guard",
      "Require main and matching draft component releases",
      {
        commands: recoveryGuardCommands,
        env: { ...recoveryGuardEnv, ...env },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
  });

  it.each([
    {
      jobName: "recovery-docker-publish-ghcr",
      image: "ghcr.io/ambitresearch/genie",
      signatureStep: "Sign and verify recovered GHCR digest",
      platformStep: "Verify recovered GHCR platforms",
      promotionStep: "Promote verified GHCR recovery digest",
      liveStep: "Verify live GHCR recovery tags",
    },
    {
      jobName: "recovery-docker-publish-dockerhub",
      image: "docker.io/ambitresearch/genie",
      signatureStep: "Sign and verify recovered Docker Hub digest",
      platformStep: "Verify recovered Docker Hub platforms",
      promotionStep: "Promote verified Docker Hub recovery digest",
      liveStep: "Verify live Docker Hub recovery tags",
    },
  ])(
    "$jobName executes platform and digest checks before accepting promotion",
    ({ jobName, image, signatureStep, platformStep, promotionStep, liveStep }) => {
      const fullManifest = JSON.stringify({
        manifests: [
          { platform: { os: "linux", architecture: "amd64" } },
          { platform: { os: "linux", architecture: "arm64" } },
        ],
      });
      const incompleteManifest = JSON.stringify({
        manifests: [{ platform: { os: "linux", architecture: "amd64" } }],
      });
      const expectedDigest = "sha256:expected";

      const signature = runReleaseStep(jobName, signatureStep, {
        commands: { cosign: transientCosignCommand, sleep: fakeSleepCommand },
        env: {
          BUILD_DIGEST: expectedDigest,
          CERTIFICATE_IDENTITY:
            "https://github.com/ambitresearch/genie/.github/workflows/release.yml@refs/heads/main",
          CERTIFICATE_OIDC_ISSUER: "https://token.actions.githubusercontent.com",
          SIGNING_SHA: "sha-reviewed-workflow",
          FAKE_COSIGN_SUCCESS_ATTEMPT: "3",
        },
      });
      expect(signature.status, `${signature.stdout}\n${signature.stderr}`).toBe(0);
      const signatureCalls = signature.log.trim().split("\n");
      expect(signatureCalls.filter((call) => call.startsWith("cosign sign "))).toEqual([
        `cosign sign --yes ${image}@${expectedDigest}`,
      ]);
      const verifyCalls = signatureCalls.filter((call) => call.startsWith("cosign verify "));
      expect(verifyCalls).toHaveLength(3);
      for (const call of verifyCalls) {
        expect(call).toContain(
          `--certificate-identity=https://github.com/ambitresearch/genie/.github/workflows/release.yml@refs/heads/main`,
        );
        expect(call).toContain(
          "--certificate-oidc-issuer=https://token.actions.githubusercontent.com",
        );
        expect(call).toContain("--certificate-github-workflow-sha=sha-reviewed-workflow");
        expect(call).toContain(`${image}@${expectedDigest}`);
      }
      expect(signatureCalls.filter((call) => call === "sleep 5")).toHaveLength(2);

      const missingSignature = runReleaseStep(jobName, signatureStep, {
        commands: { cosign: transientCosignCommand, sleep: fakeSleepCommand },
        env: {
          BUILD_DIGEST: expectedDigest,
          CERTIFICATE_IDENTITY:
            "https://github.com/ambitresearch/genie/.github/workflows/release.yml@refs/heads/main",
          CERTIFICATE_OIDC_ISSUER: "https://token.actions.githubusercontent.com",
          SIGNING_SHA: "sha-reviewed-workflow",
          FAKE_COSIGN_SUCCESS_ATTEMPT: "99",
        },
      });
      expect(missingSignature.status).not.toBe(0);
      expect(
        missingSignature.log
          .trim()
          .split("\n")
          .filter((call) => call.startsWith("cosign verify ")),
      ).toHaveLength(12);

      const platform = runReleaseStep(jobName, platformStep, {
        commands: { docker: dockerPlatformCommand },
        env: {
          BUILD_DIGEST: expectedDigest,
          EXPECTED_IMAGE: image,
          FAKE_MANIFEST: fullManifest,
        },
      });
      expect(platform.status).toBe(0);
      expect(platform.log).toBe(
        `docker buildx imagetools inspect ${image}@${expectedDigest} --raw\n`,
      );
      expect(
        runReleaseStep(jobName, platformStep, {
          commands: { docker: dockerPlatformCommand },
          env: {
            BUILD_DIGEST: expectedDigest,
            EXPECTED_IMAGE: image,
            FAKE_MANIFEST: incompleteManifest,
          },
        }).status,
      ).not.toBe(0);

      const promotion = runReleaseStep(jobName, promotionStep, {
        commands: { docker: dockerPromotionCommand },
        env: {
          BUILD_DIGEST: expectedDigest,
          EXPECTED_IMAGE: image,
          VERSION: "1.3.1",
          FAKE_PROMOTION_DIGEST: expectedDigest,
        },
      });
      expect(promotion.status).toBe(0);
      expect(promotion.log).toBe(
        `docker buildx imagetools create --tag ${image}:1.3.1 --tag ${image}:latest --metadata-file promotion.json ${image}@${expectedDigest}\n`,
      );
      expect(
        runReleaseStep(jobName, promotionStep, {
          commands: { docker: dockerPromotionCommand },
          env: {
            BUILD_DIGEST: expectedDigest,
            EXPECTED_IMAGE: image,
            VERSION: "1.3.1",
            FAKE_PROMOTION_DIGEST: "sha256:wrong",
          },
        }).status,
      ).not.toBe(0);

      const live = runReleaseStep(jobName, liveStep, {
        commands: { docker: dockerLiveTagCommand, sleep: fakeSleepCommand },
        env: {
          BUILD_DIGEST: expectedDigest,
          EXPECTED_IMAGE: image,
          VERSION: "1.3.1",
          FAKE_VERSION_DIGEST: expectedDigest,
          FAKE_LATEST_DIGEST: expectedDigest,
        },
      });
      expect(live.status).toBe(0);
      expect(live.log).toBe(
        [
          `docker buildx imagetools inspect ${image}:1.3.1`,
          `docker buildx imagetools inspect ${image}:latest`,
          "",
        ].join("\n"),
      );
      expect(
        runReleaseStep(jobName, liveStep, {
          commands: { docker: dockerLiveTagCommand, sleep: fakeSleepCommand },
          env: {
            BUILD_DIGEST: expectedDigest,
            EXPECTED_IMAGE: image,
            VERSION: "1.3.1",
            FAKE_VERSION_DIGEST: expectedDigest,
            FAKE_LATEST_DIGEST: "sha256:wrong",
          },
        }).status,
      ).not.toBe(0);

      const delayedLiveTags = runReleaseStep(jobName, liveStep, {
        commands: { docker: dockerLiveTagCommand, sleep: fakeSleepCommand },
        env: {
          BUILD_DIGEST: expectedDigest,
          EXPECTED_IMAGE: image,
          VERSION: "1.3.1",
          FAKE_VERSION_DIGEST: expectedDigest,
          FAKE_LATEST_DIGEST: expectedDigest,
          FAKE_VERSION_SUCCESS_ATTEMPT: "3",
          FAKE_LATEST_SUCCESS_ATTEMPT: "3",
        },
      });
      expect(delayedLiveTags.status, `${delayedLiveTags.stdout}\n${delayedLiveTags.stderr}`).toBe(
        0,
      );
      const delayedCalls = delayedLiveTags.log.trim().split("\n");
      expect(
        delayedCalls.filter((call) => call === `docker buildx imagetools inspect ${image}:1.3.1`),
      ).toHaveLength(3);
      expect(
        delayedCalls.filter((call) => call === `docker buildx imagetools inspect ${image}:latest`),
      ).toHaveLength(3);
      expect(delayedCalls.filter((call) => call === "sleep 5")).toHaveLength(4);

      const staleLiveTag = runReleaseStep(jobName, liveStep, {
        commands: { docker: dockerLiveTagCommand, sleep: fakeSleepCommand },
        env: {
          BUILD_DIGEST: expectedDigest,
          EXPECTED_IMAGE: image,
          VERSION: "1.3.1",
          FAKE_VERSION_DIGEST: expectedDigest,
          FAKE_LATEST_DIGEST: expectedDigest,
          FAKE_LATEST_SUCCESS_ATTEMPT: "99",
        },
      });
      expect(staleLiveTag.status).not.toBe(0);
      expect(
        staleLiveTag.log
          .trim()
          .split("\n")
          .filter((call) => call === `docker buildx imagetools inspect ${image}:latest`),
      ).toHaveLength(12);
    },
    30_000,
  );

  it("keeps releases draft when any recovery prerequisite fails", () => {
    const step = "Require every recovery job";
    const successful = {
      GUARD_RESULT: "success",
      GHCR_RESULT: "success",
      DOCKERHUB_RESULT: "success",
    };
    expect(runReleaseStep("recovery-finalize-releases", step, { env: successful }).status).toBe(0);

    for (const failed of Object.keys(successful)) {
      const result = runReleaseStep("recovery-finalize-releases", step, {
        env: { ...successful, [failed]: "failure" },
      });
      expect(result.status, failed).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("keeping releases draft");
    }
  });

  it("executes provenance and signed-asset verification and fails closed", () => {
    const step = "Verify existing npm provenance and signed release assets";
    const commands = {
      gh: recoveryFinalizeGhCommand,
      npm: recoveryFinalizeNpmCommand,
      cosign: recoveryFinalizeCosignCommand,
    };
    const valid = runReleaseStep("recovery-finalize-releases", step, {
      commands,
      env: recoveryFinalizeEnv,
    });
    expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);
    const cosignCalls = valid.log.split("\n").filter((line) => line.startsWith("cosign "));
    const verifiedArtifacts = [
      { tag: "server-v1.3.1", artifact: "ambitresearch-genie-1.3.1.tgz" },
      { tag: "server-v1.3.1", artifact: "genie-server-sbom.cdx.json" },
      { tag: "server-v1.3.1", artifact: "genie.mcpb" },
      { tag: "viewer-v0.1.1", artifact: "ambitresearch-genie-viewer-0.1.1.tgz" },
      { tag: "viewer-v0.1.1", artifact: "genie-viewer-sbom.cdx.json" },
    ];
    expect(cosignCalls).toHaveLength(verifiedArtifacts.length);
    for (const { tag, artifact } of verifiedArtifacts) {
      const call = cosignCalls.find((line) => line.includes(`/${tag}/${artifact}.sig`));
      expect(call, `${tag}/${artifact}`).toBeDefined();
      expect(call).toContain(`--certificate-identity=${recoveryFinalizeEnv.CERTIFICATE_IDENTITY}`);
      expect(call).toContain(
        `--certificate-oidc-issuer=${recoveryFinalizeEnv.CERTIFICATE_OIDC_ISSUER}`,
      );
      expect(call?.endsWith(`/${tag}/${artifact}`)).toBe(true);
    }

    const missingSignature = runReleaseStep("recovery-finalize-releases", step, {
      commands,
      env: {
        ...recoveryFinalizeEnv,
        FAKE_SERVER_ASSETS: serverRecoveryAssets.replace("\ngenie.mcpb.sig", ""),
      },
    });
    expect(missingSignature.status).not.toBe(0);
    expect(`${missingSignature.stdout}\n${missingSignature.stderr}`).toContain(
      "missing genie.mcpb.sig; keeping releases draft",
    );

    const invalidProvenance = runReleaseStep("recovery-finalize-releases", step, {
      commands,
      env: { ...recoveryFinalizeEnv, FAKE_VIEWER_PROVENANCE: "invalid" },
    });
    expect(
      invalidProvenance.status,
      `${invalidProvenance.stdout}\n${invalidProvenance.stderr}\n${invalidProvenance.log}`,
    ).not.toBe(0);
    const invalidSignature = runReleaseStep("recovery-finalize-releases", step, {
      commands,
      env: { ...recoveryFinalizeEnv, FAKE_COSIGN_FAIL: "1" },
    });
    expect(
      invalidSignature.status,
      `${invalidSignature.stdout}\n${invalidSignature.stderr}\n${invalidSignature.log}`,
    ).not.toBe(0);
  });

  it("retries finalization without republishing an already-published component", () => {
    const verificationStep = "Verify existing npm provenance and signed release assets";
    const verificationCommands = {
      gh: recoveryFinalizeGhCommand,
      npm: recoveryFinalizeNpmCommand,
      cosign: recoveryFinalizeCosignCommand,
    };
    const partiallyPublishedEnv = {
      ...recoveryFinalizeEnv,
      FAKE_SERVER_DRAFT: "false",
      FAKE_VIEWER_DRAFT: "true",
    };
    const firstAttempt = runReleaseStep("recovery-finalize-releases", verificationStep, {
      commands: verificationCommands,
      env: { ...partiallyPublishedEnv, GITHUB_RUN_ATTEMPT: "1" },
    });
    expect(firstAttempt.status).not.toBe(0);
    expect(`${firstAttempt.stdout}\n${firstAttempt.stderr}`).toContain(
      "published before recovery finalization",
    );

    const laterAttempt = runReleaseStep("recovery-finalize-releases", verificationStep, {
      commands: verificationCommands,
      env: { ...partiallyPublishedEnv, GITHUB_RUN_ATTEMPT: "2" },
    });
    expect(laterAttempt.status, `${laterAttempt.stdout}\n${laterAttempt.stderr}`).toBe(0);

    const retry = runReleaseStep(
      "recovery-finalize-releases",
      "Publish recovered component releases",
      {
        commands: { gh: recoveryFinalizeGhCommand },
        env: {
          ...recoveryFinalizeEnv,
          FAKE_SERVER_DRAFT: "false",
          FAKE_VIEWER_DRAFT: "true",
        },
      },
    );
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(retry.log).not.toContain("edit server-v1.3.1");
    expect(retry.log).toContain("edit viewer-v0.1.1");

    const editFailure = runReleaseStep(
      "recovery-finalize-releases",
      "Publish recovered component releases",
      {
        commands: { gh: recoveryFinalizeGhCommand },
        env: {
          ...recoveryFinalizeEnv,
          FAKE_EDIT_FAIL_TAG: "viewer-v0.1.1",
        },
      },
    );
    expect(editFailure.status).not.toBe(0);

    const immutableStep = "Verify recovered releases are published and immutable";
    expect(
      runReleaseStep("recovery-finalize-releases", immutableStep, {
        commands: { gh: recoveryFinalizeGhCommand },
        env: {
          ...recoveryFinalizeEnv,
          FAKE_SERVER_DRAFT: "false",
          FAKE_SERVER_IMMUTABLE: "true",
          FAKE_VIEWER_DRAFT: "false",
          FAKE_VIEWER_IMMUTABLE: "true",
        },
      }).status,
    ).toBe(0);
    expect(
      runReleaseStep("recovery-finalize-releases", immutableStep, {
        commands: { gh: recoveryFinalizeGhCommand },
        env: {
          ...recoveryFinalizeEnv,
          FAKE_SERVER_DRAFT: "false",
          FAKE_SERVER_IMMUTABLE: "true",
          FAKE_VIEWER_DRAFT: "false",
          FAKE_VIEWER_IMMUTABLE: "false",
        },
      }).status,
    ).not.toBe(0);
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
