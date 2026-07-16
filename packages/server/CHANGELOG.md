# Changelog

## [1.2.0](https://github.com/roshangautam/genie/compare/server-v1.1.0...server-v1.2.0) (2026-07-14)


### Features

* **server:** add chat-invocation preview workflow ([#178](https://github.com/roshangautam/genie/issues/178)) ([268f740](https://github.com/roshangautam/genie/commit/268f740dd75ffe7bbef07f1c168956b5e132ecc7))
* **server:** OAuth 2.0 + Dynamic Client Registration (DRO-273/M5-01) ([#187](https://github.com/roshangautam/genie/issues/187)) ([dfe632b](https://github.com/roshangautam/genie/commit/dfe632b9d3f3d9bde28f3a0539e41fe438904c36))
* **server:** secure env and mounted-file secret handling (DRO-275) ([#185](https://github.com/roshangautam/genie/issues/185)) ([c85ea1a](https://github.com/roshangautam/genie/commit/c85ea1a46c6a51253fefbf74bf764ef04d028035))
* **server:** static Bearer token fallback (M5-02, DRO-274) ([#184](https://github.com/roshangautam/genie/issues/184)) ([336deee](https://github.com/roshangautam/genie/commit/336deee8b481901d7ed4584a35c34318e3b6610f))


### Bug Fixes

* **server:** render previews in Codex Desktop canvas ([#180](https://github.com/roshangautam/genie/issues/180)) ([#181](https://github.com/roshangautam/genie/issues/181)) ([801a69c](https://github.com/roshangautam/genie/commit/801a69c654cb4abbe0a2e5a81509e8acfbc851ae))

## [1.1.0](https://github.com/roshangautam/genie/compare/server-v1.0.0...server-v1.1.0) (2026-07-10)


### Features

* **server:** .genie/manifest.json writer — client-side compiler (M3-03) ([#147](https://github.com/roshangautam/genie/issues/147)) ([088f761](https://github.com/roshangautam/genie/commit/088f7617efee82362f18bf03a167280d9a0dc44a))
* **server:** .genie/sync.json verification anchor (DRO-262) ([#144](https://github.com/roshangautam/genie/issues/144)) ([2163ca2](https://github.com/roshangautam/genie/commit/2163ca2ba9b2f418c070b4d2d6ad92891fc49573))
* **server:** [@genie](https://github.com/genie) first-line marker validator (DRO-257) ([#142](https://github.com/roshangautam/genie/issues/142)) ([59d88da](https://github.com/roshangautam/genie/commit/59d88da5616d91b5a4ce932b42e5392554f0094d))
* **server:** 5-step atomic write orchestrator (DRO-261 / M3-05) ([#148](https://github.com/roshangautam/genie/issues/148)) ([609b7d8](https://github.com/roshangautam/genie/commit/609b7d8ff9311b00d92dac3ee8ad62154919a765))
* **server:** chokidar watcher for component tree (DRO-258) ([#146](https://github.com/roshangautam/genie/issues/146)) ([fda2961](https://github.com/roshangautam/genie/commit/fda296122ee188c9d784060c275562cd8a378d6d))
* **server:** harden ui:// grid CSP and sandbox (M4-07) ([6d21290](https://github.com/roshangautam/genie/commit/6d212901d8388ba282e10f4da6bb26c5846676b9))
* **server:** implement HtmlAdapter — vanilla-HTML framework adapter (DRO-617) ([#162](https://github.com/roshangautam/genie/issues/162)) ([ea80afb](https://github.com/roshangautam/genie/commit/ea80afb9d7ac2a247ab2a07fc462773d70d3982e))
* **server:** preview tool — returns _meta.ui.resourceUri (M4-05) ([#166](https://github.com/roshangautam/genie/issues/166)) ([6f4f353](https://github.com/roshangautam/genie/commit/6f4f35337c0f1181e9da02e8ed4962f132a3998b))
* **server:** register ui://genie/grid MCP-Apps resource (M4-06) ([#168](https://github.com/roshangautam/genie/issues/168)) ([4e51c7b](https://github.com/roshangautam/genie/commit/4e51c7b237960a2d9bfc2417e62bec5456e66040))
* **server:** validate full-scan facet — marker + thin + variants (DRO-260 / M3-04) ([#152](https://github.com/roshangautam/genie/issues/152)) ([a769c1f](https://github.com/roshangautam/genie/commit/a769c1f76d495289994d7cf92003a30892d0164f))
* **viewer:** per-card HMR via WebSocket and postMessage (M4-04) ([6b9d3bc](https://github.com/roshangautam/genie/commit/6b9d3bcf13ff79c54f200bc988d5d0de71fdb475))


### Bug Fixes

* **server:** address Copilot review findings on atomic sync orchestrator ([#150](https://github.com/roshangautam/genie/issues/150)) ([91204ce](https://github.com/roshangautam/genie/commit/91204ceb730a8b3a3c2d71b870104a9ca60cae73))
* **server:** create_kit scaffolds viewer assets into new kit root (DRO-764) ([#170](https://github.com/roshangautam/genie/issues/170)) ([cbdfe2d](https://github.com/roshangautam/genie/commit/cbdfe2d4dacbc60dab7972565ce3296c6128d98e))
* **server:** hue-aware color veto for validate pHash variantsIdentical (DRO-717) ([#157](https://github.com/roshangautam/genie/issues/157)) ([b56831f](https://github.com/roshangautam/genie/commit/b56831fbda51e2490ac6d76ebe8af0e13e5f22fb))
* **server:** validate full-scan honors marker viewport, not just meta.json (DRO-711) ([#154](https://github.com/roshangautam/genie/issues/154)) ([d485ec1](https://github.com/roshangautam/genie/commit/d485ec117379d5cb3887002e803703567adea0f3))

## 1.0.0 (2026-07-04)


### ⚠ BREAKING CHANGES

* minimum supported Node.js is now 22.

### Features

* **deploy:** reference LiteLLM model alias config (M2-05) ([#118](https://github.com/roshangautam/genie/issues/118)) ([857ba6d](https://github.com/roshangautam/genie/commit/857ba6dcf3e3796e53f14a068c5c0e8b3de83a28))
* M0 scaffold — bootable MCP server, toolchain, CI, governance ([#1](https://github.com/roshangautam/genie/issues/1)) ([c72e237](https://github.com/roshangautam/genie/commit/c72e2372bfc9b8679204a1d79a2cd17771727e3c))
* **server:** add bind_kit tool (M1-20) ([#100](https://github.com/roshangautam/genie/issues/100)) ([321b40b](https://github.com/roshangautam/genie/commit/321b40b9bec79c5f2eddf22701179000f7d3500e))
* **server:** add conjure tool — LLM component generation (M2-03) ([#125](https://github.com/roshangautam/genie/issues/125)) ([3d71205](https://github.com/roshangautam/genie/commit/3d712051c84948ea2ffdb5f59d8e78a17c307b06))
* **server:** add conjure_screen tool (M1-21) ([#105](https://github.com/roshangautam/genie/issues/105)) ([6e447d3](https://github.com/roshangautam/genie/commit/6e447d3b81e5cbbdb9c4e62696778a573f4080c3))
* **server:** add create_project tool ([#84](https://github.com/roshangautam/genie/issues/84)) ([b2879c7](https://github.com/roshangautam/genie/commit/b2879c746dd12605eec4f69a88f193e94894c213))
* **server:** add delete_files tool (M1-09) ([#107](https://github.com/roshangautam/genie/issues/107)) ([0594f8c](https://github.com/roshangautam/genie/commit/0594f8c16a9b8d2a616622d960c15bf81d28c7f3))
* **server:** add get_kit tool (M1-03) ([#95](https://github.com/roshangautam/genie/issues/95)) ([7d62c11](https://github.com/roshangautam/genie/commit/7d62c11c7ba0a15af98ea3b7c175af57612c7c89))
* **server:** add get_project tool (M1-17) ([#96](https://github.com/roshangautam/genie/issues/96)) ([1eeb3fa](https://github.com/roshangautam/genie/commit/1eeb3faca8afc57abb923c47456929f67179f6c7))
* **server:** add list_components tool (M1-15) ([#97](https://github.com/roshangautam/genie/issues/97)) ([521e41e](https://github.com/roshangautam/genie/commit/521e41e6f015d54dd06614a8cf7e703d3bd79918))
* **server:** add list_files tool (M1-04) ([#88](https://github.com/roshangautam/genie/issues/88)) ([c2c0732](https://github.com/roshangautam/genie/commit/c2c07320ed2c614bedf8f5415de4a315136f676a)), closes [#9](https://github.com/roshangautam/genie/issues/9)
* **server:** add list_kits tool (M1-02) ([#92](https://github.com/roshangautam/genie/issues/92)) ([ce1455c](https://github.com/roshangautam/genie/commit/ce1455c60f7c020e7086490f6a6cdf25449e953a))
* **server:** add list_projects tool (M1-16) ([#86](https://github.com/roshangautam/genie/issues/86)) ([9b57b10](https://github.com/roshangautam/genie/commit/9b57b10d542e6378d19eee1dfb98e1558992274a))
* **server:** add LLM client wrapper (M2-01) ([#115](https://github.com/roshangautam/genie/issues/115)) ([d053a4b](https://github.com/roshangautam/genie/commit/d053a4bf591861f5518e89179b39884005abc698))
* **server:** add plan tool (M1-07) ([#104](https://github.com/roshangautam/genie/issues/104)) ([eaf1bd9](https://github.com/roshangautam/genie/commit/eaf1bd9a627d9fa79f31474d32bb211f952395c2))
* **server:** add refine tool — LLM component iteration (M2-04) ([#127](https://github.com/roshangautam/genie/issues/127)) ([867000c](https://github.com/roshangautam/genie/commit/867000cf3ee32fd58607432659e31bedf6e4222b))
* **server:** add retry/backoff for LLM endpoint calls (M2-06) ([#126](https://github.com/roshangautam/genie/issues/126)) ([9de622e](https://github.com/roshangautam/genie/commit/9de622eec3d5d40a8f18095931d81adbe8b07f6c))
* **server:** add write_files tool (M1-08) ([#106](https://github.com/roshangautam/genie/issues/106)) ([d82f770](https://github.com/roshangautam/genie/commit/d82f770d2159c3eb0543b82af59f52ae09a8e94e))
* **server:** centralise plan-vs-write guard in one middleware (M1-13, DRO-239) ([a5fabda](https://github.com/roshangautam/genie/commit/a5fabda36013739eebcb28c0429a5ee3cf6a9c54))
* **server:** centralise plan-vs-write guard in one middleware (M1-13) ([#113](https://github.com/roshangautam/genie/issues/113)) ([a5fabda](https://github.com/roshangautam/genie/commit/a5fabda36013739eebcb28c0429a5ee3cf6a9c54))
* **server:** define COMPONENT_SCHEMA for structured LLM output (M2-02) ([#120](https://github.com/roshangautam/genie/issues/120)) ([1a1176f](https://github.com/roshangautam/genie/commit/1a1176f7975c6c947ee03c6ecbb703023c62c083))
* **server:** implement Vue framework adapter (DRO-616) ([#137](https://github.com/roshangautam/genie/issues/137)) ([e2d85fd](https://github.com/roshangautam/genie/commit/e2d85fd94cbb9c6a5e6fc0e5c2cd68842d7f5115))
* **server:** make list_components manifest-backed with ordering + pagination (M1-15) ([#110](https://github.com/roshangautam/genie/issues/110)) ([eeca9f4](https://github.com/roshangautam/genie/commit/eeca9f4faf55ab37775afc9857778a6e5224076b))
* **server:** multi-framework adapter — React first, Vue/HTML stubbed (M2-08) ([#131](https://github.com/roshangautam/genie/issues/131)) ([255b728](https://github.com/roshangautam/genie/commit/255b7280c9efa5a786be06cd183876d73e3ef60d)), closes [#32](https://github.com/roshangautam/genie/issues/32)
* **server:** route write_files onto a KitStore write primitive (M1-14a-1b / DRO-565) ([#121](https://github.com/roshangautam/genie/issues/121)) ([4435285](https://github.com/roshangautam/genie/commit/4435285f79247d352a35b8881eaf4858e416be41))
* **server:** strict Ajv validation for structured LLM outputs (M2-07) ([#124](https://github.com/roshangautam/genie/issues/124)) ([e924738](https://github.com/roshangautam/genie/commit/e924738b25d78f921626f01d4e9d55af47c65b23))


### Bug Fixes

* **server:** address remaining Copilot review findings on write_files (M1-08 follow-up) ([#108](https://github.com/roshangautam/genie/issues/108)) ([306cd42](https://github.com/roshangautam/genie/commit/306cd429ee42b6035108877fcb004539bcd63dcb))
* **server:** GitHost.deleteFile raises on directory target (parity with LocalFs) (DRO-568) ([#117](https://github.com/roshangautam/genie/issues/117)) ([6a676fc](https://github.com/roshangautam/genie/commit/6a676fcaa8b1fee8b59dc5cadd1fa0b767167560))
* **server:** map GitHost kit collisions to KitAlreadyExistsError (DRO-234 AC8) ([#90](https://github.com/roshangautam/genie/issues/90)) ([4659fc0](https://github.com/roshangautam/genie/commit/4659fc0647869f31769f1304543a56067ac1f503))
* **server:** preserve binary component files across a refine round-trip (M2-04 follow-up) ([e9e36b8](https://github.com/roshangautam/genie/commit/e9e36b85a2539c3c2bcf0cc789f7afe8fbcd1960))
* **server:** React preview bundle resolves React from host global, not require (DRO-624) ([#134](https://github.com/roshangautam/genie/issues/134)) ([3f0269e](https://github.com/roshangautam/genie/commit/3f0269e45d4aee7c0047d5ba7328f5745d4a391c))
* **server:** unify kitId guard + close empty-kitId cross-kit read; stream SRI hash (DRO-583) ([#122](https://github.com/roshangautam/genie/issues/122)) ([fd0c8b1](https://github.com/roshangautam/genie/commit/fd0c8b115b57d401127e39122aaafb85c73ad24c))
* **server:** wire withRetry into conjure/refine production call sites (M2-06 follow-up) ([#133](https://github.com/roshangautam/genie/issues/133)) ([56148d9](https://github.com/roshangautam/genie/commit/56148d9a0eb2255edd0edf72e677d51b9ccb1cb8))
