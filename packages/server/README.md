# @ambitresearch/genie

The genie MCP server provides harness-agnostic UI-component generation, refinement,
validation, and preview tools. See the [genie documentation](https://ambitresearch.github.io/genie/)
for installation, configuration, and harness-specific setup.

## Release verification

Releases include npm provenance plus signed tarballs, SBOMs, container images, and the
Claude Desktop bundle. After installing the package, run `npm audit signatures` to check
its registry signature and provenance. For release downloads, use `cosign verify-blob`
with the adjacent `.sig` bundle.

The [supply-chain verification guide](https://github.com/ambitresearch/genie/blob/main/docs/supply-chain.md#verifying-a-release)
contains the complete certificate identity, issuer, and container verification commands.
