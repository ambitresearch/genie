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

See [Supply-chain security](../supply-chain.md) for the exact verification commands,
certificate identity, pinned action inventory, and pnpm trust policy.
