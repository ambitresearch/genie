# Releases and supply-chain verification

After the exact `main` commit passes CI, Release Please creates component tags such as
`server-v1.3.0` and `viewer-v0.1.0` plus **draft** GitHub Releases. Downstream production
jobs build, sign, verify, attach, and publish the release artifacts while those releases
remain mutable. A final job verifies every applicable publish path, expected release asset,
npm version, and promoted container tag before publishing the GitHub Releases. This order is
required when immutable releases are enabled because assets cannot be added after publication.

Each release path is fail-closed:

- npm tarballs publish with GitHub OIDC provenance.
- npm tarballs, CycloneDX SBOMs, and `genie.mcpb` receive keyless Sigstore bundles.
- Signed tarballs, SBOMs, and the Desktop bundle attach while the component release is draft.
- GHCR and Docker Hub images carry SBOM/provenance attestations and keyless signatures.
- Container images first receive run-scoped staging tags; their verified digests are then
  promoted to version and `latest` tags and read back from each live registry.
  GitHub component tags already exist at this point, and npm publishes the exact pre-signed
  tarball directly without a tag-promotion phase.
- Any failed or skipped applicable publish job keeps both GitHub Releases draft for operators
  to resolve before finalization.

## Recovering an incomplete production release

Use the Release workflow's manual trigger only when npm and the signed GitHub assets already
succeeded, both component releases are still mutable drafts from the same release commit, and
one or both container registry jobs failed. Select the `main` branch and enter the existing
`server-vX.Y.Z` and `viewer-vX.Y.Z` tags. A branch dispatch is rejected because it would change
the keyless certificate identity from the documented `release.yml@refs/heads/main` identity.
The workflow serializes normal production releases and recoveries under one non-cancelling lock,
and the guard requires both input versions to remain the current npm `latest` versions. An older
draft therefore cannot repoint either container registry's `latest` tag.

The recovery path checks both drafts and their tag targets, checks out the exact server tag,
then independently rebuilds amd64/arm64 images for GHCR and Docker Hub with SBOM and max
provenance attestations. Each registry digest is signed, verified, and inspected for both
platforms before that exact digest is promoted to the version and `latest` tags. The recovery
does **not** publish npm or replace any GitHub asset. Its final job instead verifies both live
npm provenance attestations and downloads and verifies every existing release blob against its
Sigstore bundle. Only after both registry jobs and all read-back checks pass does it publish the
component releases and require GitHub to report them immutable.

If a registry leg fails, use **Re-run failed jobs** so the successful independent leg is not
rebuilt. Do not rerun an old workflow revision after its release workflow has changed; merge the
recovery implementation to `main` first so the Cosign identity and reviewed workflow SHA remain
authoritative.

See [Supply-chain security](../supply-chain.md) for the exact verification commands,
certificate identity, pinned action inventory, and pnpm trust policy.
