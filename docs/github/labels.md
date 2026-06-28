# genie — Label Catalog

Hex colours follow GitHub's recommended palette. All labels are namespaced
`<category>:<value>` where applicable so they can be filtered in bulk.

## Type — what kind of work

| Label             | Hex       | Meaning                                    |
|-------------------|-----------|--------------------------------------------|
| `type:feature`    | `#1d76db` | Net-new functionality                      |
| `type:bug`        | `#d73a4a` | Defect against documented behaviour        |
| `type:chore`      | `#cfd3d7` | Repo housekeeping, no behaviour change     |
| `type:docs`       | `#0075ca` | Documentation only                         |
| `type:test`       | `#0e8a16` | New / improved tests, no prod-code change  |
| `type:refactor`   | `#a2eeef` | Internal restructure, behaviour preserved  |
| `type:infra`      | `#5319e7` | CI, build, release pipeline                |
| `type:security`   | `#b60205` | Vulnerability fix or hardening             |
| `type:perf`       | `#fbca04` | Performance work                           |
| `type:a11y`       | `#7057ff` | Accessibility work                         |
| `type:dx`         | `#bfd4f2` | Developer experience                       |

## Area — which subsystem

| Label                       | Hex       |
|-----------------------------|-----------|
| `area:mcp-server`           | `#006b75` |
| `area:mcp-tools`            | `#008672` |
| `area:mcp-resources`        | `#00a86b` |
| `area:mcp-prompts`          | `#1d8e3a` |
| `area:mcp-ui`               | `#0e8a16` |
| `area:llm`                  | `#5319e7` |
| `area:generation`           | `#7057ff` |
| `area:projects`             | `#1f883d` |
| `area:storage`              | `#f9d0c4` |
| `area:viewer`               | `#fef2c0` |
| `area:mcpb`                 | `#fbca04` |
| `area:harness:claude-code`  | `#a67c00` |
| `area:harness:claude-desktop` | `#a67c00` |
| `area:harness:codex`        | `#a67c00` |
| `area:harness:copilot`      | `#a67c00` |
| `area:harness:cursor`       | `#a67c00` |
| `area:harness:cline`        | `#a67c00` |
| `area:harness:continue`     | `#a67c00` |
| `area:ci`                   | `#cccccc` |
| `area:docs`                 | `#bfdadc` |

## Priority

| Label              | Hex       | Meaning                          |
|--------------------|-----------|----------------------------------|
| `priority:P0-critical` | `#b60205` | Blocks release / live-site bug   |
| `priority:P1-high`     | `#d93f0b` | Must be in current milestone     |
| `priority:P2-medium`   | `#fbca04` | Should be in current milestone   |
| `priority:P3-low`      | `#c2e0c6` | Nice to have                     |

## Size — estimate bucket

| Label       | Hex       | Effort window |
|-------------|-----------|---------------|
| `size:XS`   | `#c5def5` | < 1 h         |
| `size:S`    | `#7ec7f0` | 1–4 h         |
| `size:M`    | `#1d76db` | 4–8 h         |
| `size:L`    | `#0e3f7c` | 1–3 d         |
| `size:XL`   | `#0a1d4f` | > 3 d         |

## Status

| Label                | Hex       |
|----------------------|-----------|
| `status:ready`       | `#0e8a16` |
| `status:in-progress` | `#fbca04` |
| `status:blocked`     | `#b60205` |
| `status:needs-decision` | `#d4c5f9` |

## SemVer impact

| Label            | Hex       |
|------------------|-----------|
| `semver:breaking` | `#b60205` |
| `semver:minor`    | `#fbca04` |
| `semver:patch`    | `#c2e0c6` |

## Community

| Label              | Hex       |
|--------------------|-----------|
| `good-first-issue` | `#7057ff` |
| `help-wanted`      | `#008672` |
