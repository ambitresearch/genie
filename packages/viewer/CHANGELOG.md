# Changelog

## 0.1.0 (2026-07-19)


### ⚠ BREAKING CHANGES

* minimum supported Node.js is now 22.

### Features

* M0 scaffold — bootable MCP server, toolchain, CI, governance ([#1](https://github.com/ambitresearch/genie/issues/1)) ([c72e237](https://github.com/ambitresearch/genie/commit/c72e2372bfc9b8679204a1d79a2cd17771727e3c))
* **release:** npm publish pipeline for @ambitresearch/genie + @ambitresearch/genie-viewer (M5-06, DRO-278) ([3c7ab2e](https://github.com/ambitresearch/genie/commit/3c7ab2efbde3a49fa9c93ec3f30fc3fecd187502))
* **server:** add chat-invocation preview workflow ([#178](https://github.com/ambitresearch/genie/issues/178)) ([268f740](https://github.com/ambitresearch/genie/commit/268f740dd75ffe7bbef07f1c168956b5e132ecc7))
* **server:** preview tool — returns _meta.ui.resourceUri (M4-05) ([#166](https://github.com/ambitresearch/genie/issues/166)) ([6f4f353](https://github.com/ambitresearch/genie/commit/6f4f35337c0f1181e9da02e8ed4962f132a3998b))
* **server:** register ui://genie/grid MCP-Apps resource (M4-06) ([#168](https://github.com/ambitresearch/genie/issues/168)) ([4e51c7b](https://github.com/ambitresearch/genie/commit/4e51c7b237960a2d9bfc2417e62bec5456e66040))
* **viewer:** @ambitresearch/genie-viewer package scaffold + genie-viewer CLI (DRO-263 / M4-01) ([a82a05b](https://github.com/ambitresearch/genie/commit/a82a05b07e375d10b0f888db8ad37d960984342c))
* **viewer:** boot Vite dev server in genie-viewer CLI (M4-08) ([#159](https://github.com/ambitresearch/genie/issues/159)) ([95052ce](https://github.com/ambitresearch/genie/commit/95052cec85d313d83a4ba24b8c30beae51eac1ee))
* **viewer:** iframe grid renderer (M4-03) ([#164](https://github.com/ambitresearch/genie/issues/164)) ([f9b40de](https://github.com/ambitresearch/genie/commit/f9b40de5c47477defa200c0a877bda370a2c34e6))
* **viewer:** per-card HMR via WebSocket and postMessage (M4-04) ([6b9d3bc](https://github.com/ambitresearch/genie/commit/6b9d3bcf13ff79c54f200bc988d5d0de71fdb475))
* **viewer:** Vite multi-page config — one entry per preview.html (DRO-264 / M4-02) ([#158](https://github.com/ambitresearch/genie/issues/158)) ([bc3893e](https://github.com/ambitresearch/genie/commit/bc3893eef58ccf144d97b0010d284730be17e025))


### Bug Fixes

* **release:** migrate packages to Ambit Research ([#213](https://github.com/ambitresearch/genie/issues/213)) ([de44af9](https://github.com/ambitresearch/genie/commit/de44af92cc92decf72c5d96c4fca0d4dfbe028de))
* **release:** synchronize CLI package versions ([#212](https://github.com/ambitresearch/genie/issues/212)) ([d4952d2](https://github.com/ambitresearch/genie/commit/d4952d2f4cec34f2e39fbf014ae8c4deced22db7))
* **server:** render previews in Codex Desktop canvas ([#180](https://github.com/ambitresearch/genie/issues/180)) ([#181](https://github.com/ambitresearch/genie/issues/181)) ([801a69c](https://github.com/ambitresearch/genie/commit/801a69c654cb4abbe0a2e5a81509e8acfbc851ae))
* **viewer:** serve viewer.js as a classic script, not type="module" (DRO-749) ([#165](https://github.com/ambitresearch/genie/issues/165)) ([7896663](https://github.com/ambitresearch/genie/commit/78966636d333f491f8c33cc9023279146f766bb7))
