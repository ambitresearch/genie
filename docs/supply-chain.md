# Supply-chain security

This document records genie's software-supply-chain controls: how CI/CD actions are
pinned, how published artifacts are signed and attested, the pnpm install policy, and
the accepted residual risks. It closes the supply-chain gaps found by the M6-03
re-audit (GitHub issue #207) and reconciles the release-signing scope of issue #69
(M6-04 / DRO-292).

## 1. Pinned GitHub Actions

Every third-party action in `.github/workflows/` is pinned to a full 40-character
commit SHA, with the human-readable version recorded in a trailing `# vX.Y.Z` comment
for provenance and review. Mutable tags (`@v4`, `@main`, …) are never used, so a tag
being force-moved to a malicious commit cannot silently enter a build.

| Action | Pinned commit | Version |
| --- | --- | --- |
| `actions/checkout` | `34e114876b0b11c390a56381ad16ebd13914f8d5` | v4.3.1 |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 |
| `pnpm/action-setup` | `b906affcce14559ad1aafd4ab0e942779e9f58b1` | v4.2.0 |
| `googleapis/release-please-action` | `5c625bfb5d1ff62eadeeb3772007f7f66fdcf071` | v4.4.1 |
| `softprops/action-gh-release` | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` | v2.6.2 |
| `docker/setup-qemu-action` | `c7c53464625b32c7a7e944ae62b3e17d2b600130` | v3.7.0 |
| `docker/setup-buildx-action` | `8d2750c68a42422c14e847fe6c8ac0403b4cbd6f` | v3.12.0 |
| `docker/login-action` | `c94ce9fb468520275223c153574b00df6fe4bcc9` | v3.7.0 |
| `docker/build-push-action` | `10e90e3645eae34f1e60eeb005ba3a3d33f178e8` | v6.19.2 |
| `sigstore/cosign-installer` | `398d4b0eeef1380460a10c8013a76f728fb906ac` | v3.9.1 |

`.github/workflows/runner-guard.yml` uses no third-party actions (inline `run:` steps
only), so it has nothing to pin.

### Updating a pin

To bump an action, resolve the new release tag to its commit SHA (for annotated tags,
resolve to the tag's target commit, not the tag object), then update both the `@<sha>`
ref and the `# vX.Y.Z` comment together. Review the upstream changelog for the range
being adopted before merging.

## 2. Published-artifact signing and attestation

`.github/workflows/release.yml` publishes four artifact classes, each with its own
integrity evidence:

- **npm packages** (`@genie/server`, `@genie/viewer`): published with
  `npm publish --provenance --access public`. npm provenance produces a signed SLSA
  attestation via GitHub OIDC (`id-token: write`), linking each published tarball to the
  exact source commit and workflow run. Provenance requires the source repository to be
  public before the first live publish.
- **npm SBOMs**: a CycloneDX JSON SBOM is generated for each package with
  `@cyclonedx/cdxgen` (a lockfile-pinned, integrity-hashed devDependency run via
  `pnpm exec`; `-t pnpm --required-only` so it reads the workspace `pnpm-lock.yaml` and
  records only the shipped runtime dependency tree) and attached to that package's GitHub
  Release as a downloadable asset (`genie-server-sbom.cdx.json`,
  `genie-viewer-sbom.cdx.json`). The SBOM is generated before `npm publish` (so a tooling
  failure surfaces before the irreversible publish) and written to a workspace-level `sbom/`
  directory, never inside the package, so it cannot be swept into the published npm tarball.
  `cdxgen` is used instead of `cyclonedx-npm` because this
  is a pnpm workspace with `workspace:*` specifiers and no `package-lock.json`, which the
  npm-lock-based generator cannot parse.
- **Container images** (GHCR + Docker Hub): built multi-arch (amd64/arm64) from the
  CI-verified release tag. `docker/build-push-action` is configured with `sbom: true`
  and `provenance: mode=max`, so each pushed image manifest carries an embedded
  CycloneDX SBOM and a max-detail SLSA provenance attestation. Each image digest is then
  signed keyless with cosign (`cosign sign --yes …@<digest>`) using GitHub OIDC — no
  long-lived signing key is stored.
- **Claude Desktop bundle** (`genie.mcpb`): built from the release tag and attached to
  the server GitHub Release.

### Verifying a release

- npm provenance: `npm audit signatures` after install, or inspect the provenance
  attestation on the package's npmjs.com page.
- Container signature:
  `cosign verify <image>@<digest> --certificate-identity-regexp '.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com`
  (constrain the identity regexp to this repo's workflow ref for a stricter check).
- Image SBOM/provenance: `docker buildx imagetools inspect <image> --format '{{ json .SBOM }}'`
  and `… '{{ json .Provenance }}'`, or `cosign download sbom <image>@<digest>`.

## 3. pnpm install policy

`pnpm-workspace.yaml` sets:

- **`blockExoticSubdeps: true`** — rejects non-registry transitive dependencies (git,
  tarball, http, or link specifiers pulled in by a subdependency). All first-party
  internal links are `workspace:*` **direct** dependencies, which remain allowed; only
  *exotic subdeps* are blocked. This is the pnpm 11 default, set explicitly so the policy
  is also pinned under the pnpm 10.x line the repo currently uses.
- **`minimumReleaseAge: 4320`** — a 3-day cooldown that refuses to install any published
  version younger than 4320 minutes. This blunts the "publish a malicious patch and hope
  a build pulls it before takedown" window on fresh installs and lockfile updates. It does
  **not** apply to `--frozen-lockfile` installs, which every CI leg uses, so reproducible
  CI cannot break from the cooldown. Because the cooldown is enforced during resolution,
  regenerating the lockfile while an already-locked or newly-selected version is <3 days
  old will fail until that version matures; a maintainer bumping dependencies inside the
  window can add the specific package to `minimumReleaseAgeExclude` (below) or pass a
  one-off `--config.minimumReleaseAge=0` for a reviewed lockfile update.
- **`minimumReleaseAgeExclude`** — exempts the `@cline/cli-*` platform binaries from the
  cooldown. They are an exactly-pinned, dev/test-only E2E dependency (`packages/e2e`) that
  tracks a fast-moving upstream and never ships in a published artifact, so the cooldown
  adds no supply-chain value there while otherwise blocking routine lockfile maintenance.
  Every other dependency still honours `minimumReleaseAge`.

`package.json` also sets `pnpm.overrides.typescript: "$typescript"`. `cdxgen` pulls in
`typescript` as an optional transitive dependency (via `@appthreat/atom-parsetools`);
without the override pnpm re-binds the workspace's optional `typescript` peers (notably
`vue`) onto that newer version. The override pins the entire tree to the root
`typescript` devDependency spec, so adding the SBOM tool does not silently change the
TypeScript version the runtime packages build against.

### Omitted: `trustPolicy: no-downgrade`

The M6-03 follow-up proposed a `trustPolicy: no-downgrade` setting. This is **not a real
pnpm 10.34 setting** — pnpm exposes only the numeric `trustPolicyIgnoreAfter`, not a
`no-downgrade` mode — so adding it would be a no-op at best and a parse error at worst.
The equivalent downgrade/tamper protection is already provided by:

- the committed `pnpm-lock.yaml` (lockfileVersion 9.0), in which every dependency is
  integrity-pinned to a `sha512` registry tarball;
- `pnpm install --frozen-lockfile` in every CI leg, which fails if the lockfile and
  manifest disagree; and
- npm provenance on genie's own published packages.

Revisit if pnpm ships a first-class no-downgrade trust policy.

## 4. Dependency vulnerability scanning

The lockfile is scanned with OSV Scanner (`osv-scanner scan source -r .`); the last
recorded scan reported no known vulnerabilities across the lockfile packages. `pnpm audit
--prod` is used opportunistically, but the npm audit advisory endpoint has intermittently
returned HTTP 410, so OSV Scanner is the primary gate.

## 5. Accepted residual risks

- **Tool-output trust boundary**: `conjure` returns model-controlled content. It is
  treated as untrusted data at the MCP host boundary — never concatenated into privileged
  prompts, and persisted only through the separate plan-guarded write flow. See
  `docs/security-audit-v1.md` (AC3).
- **`postMessage("*")` in the viewer**: the embedded viewer posts MCP-App protocol
  notifications to its parent with `targetOrigin: "*"`. No file contents, secrets, or
  generated payloads are sent — only initialize/size/ping/teardown protocol data. Pinning
  the parent origin is deferred until the MCP-Apps host contract exposes one reliably.

## References

- `docs/security-audit-v1.md` — M6-03 security audit and remediation.
- GitHub issue #207 — supply-chain gaps this document closes.
- GitHub issue #69 (M6-04 / DRO-292) — release signing scope reconciled here.
