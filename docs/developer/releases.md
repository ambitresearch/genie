# Releases and supply-chain verification

After the exact `main` commit passes CI, Release Please creates the component GitHub
release and tags such as `server-v1.3.0` and `viewer-v0.1.0`. Downstream production jobs
then build, sign, verify, attach, and publish the release artifacts.

Each release path is fail-closed:

- npm tarballs publish with GitHub OIDC provenance.
- npm tarballs, CycloneDX SBOMs, and `genie.mcpb` receive keyless Sigstore bundles.
- GHCR and Docker Hub images carry SBOM/provenance attestations and keyless signatures.
- Container images first receive run-scoped staging tags; their verified digests are then
  promoted to version and `latest` tags. GitHub component tags already exist at this point,
  and npm publishes the exact pre-signed tarball directly without a tag-promotion phase.

See [Supply-chain security](../supply-chain.md) for the exact verification commands,
certificate identity, pinned action inventory, and pnpm trust policy.
