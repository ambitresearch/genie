# Releases and supply-chain verification

Release Please creates component tags such as `server-v1.3.0` and `viewer-v0.1.0` only
after the exact `main` commit passes CI. Production jobs publish npm packages, signed
release blobs, and multi-architecture container images.

Each release path is fail-closed:

- npm tarballs publish with GitHub OIDC provenance.
- npm tarballs, CycloneDX SBOMs, and `genie.mcpb` receive keyless Sigstore bundles.
- GHCR and Docker Hub images carry SBOM/provenance attestations and keyless signatures.
- Artifacts are verified before final tags are promoted.

See [Supply-chain security](../supply-chain.md) for the exact verification commands,
certificate identity, pinned action inventory, and pnpm trust policy.
