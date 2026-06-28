# AGENTS.md — genie agent working contract

> **Read this first, every issue.** This is the canonical SDLC every agent follows
> when working a genie issue. Individual issues link here and add only their own
> acceptance criteria + a compact Definition of Done. When the workflow changes, it
> changes *here* — not in 66 issues.
>
> Compatible with Copilot/Cursor/Codex/Claude Code agent runners that auto-read a
> root `AGENTS.md`. If your runner doesn't, the delegating issue will point you here.

---

## 0. Before you touch code — orient

1. **Read the issue fully** — Summary, Acceptance Criteria (AC), Design Reference, DoD.
2. **Read `CLAUDE.md`** (repo root) for project context + the hard rules below.
3. **Read the linked design/plan docs** the issue references (`docs/plan/`, `docs/designs/design-6/`).
4. **Restate the task** in your PR-to-be description: what you're building, which ACs
   you'll satisfy, what's explicitly out of scope.
5. If the issue is **ambiguous, contradicts existing patterns, or the data model is
   unclear — STOP and ask** on the issue thread. Do not guess on architecture.

## 1. Plan

- Write a short plan **as a comment on the issue** before coding: the files you'll
  touch, the test cases you'll write first, and the verification approach.
- Branch from `main`: `git checkout -b <type>/<issue-id>-<short-slug>`
  (e.g. `feat/M4-03-iframe-grid-renderer`). Types: `feat|fix|chore|test|refactor|docs|perf`.
- Keep the diff **right-sized**: the smallest change that cleanly satisfies the ACs.
  Don't smuggle unrelated work in. If you find adjacent breakage, file a follow-up issue.

## 2. Test-Driven Development (non-negotiable)

- **Write the failing test first.** Red → green → refactor. The test encodes the AC.
- Cover: happy path, every branch, error paths, and edge cases (null/empty/boundary).
  100% of the new code paths in this issue get a test. No "I'll add tests later."
- Match the project's test framework + naming (see `CLAUDE.md` → Testing). Unit tests
  for pure logic; integration/E2E for multi-component flows; eval tests for LLM/prompt
  changes.
- A regression (existing behavior the diff could break) **must** get a regression test.

## 3. Visual validation (UI issues only)

If the issue has a **## Design Reference** section, it produces visible output:

1. Run the thing. Render the surface (browser, viewer, or `ui://` host).
2. **Screenshot your build.** Use the Playwright/Chrome MCP or `mcp__Claude_Preview`.
3. **Diff against the mock** named in the Design Reference (an SVG in `docs/designs/design-6/`).
   Compare layout, hierarchy, spacing, and — critically — the **genie identity rules**
   (clay/gilt accent ONLY on generate/refine moments; structure stays ink/neutral).
4. Note any deliberate deviation from the mock in the PR description with a reason.
5. **Caveat:** screenshots compress the cream palette toward white. Verify color values
   with `preview_inspect` / computed styles, not by eyeballing a JPEG.

## 4. Test against the local live service

- Don't trust unit tests alone for anything touching the running server.
- Boot the local stack (see `CLAUDE.md` → dev environment / the issue's notes) and
  exercise the change end-to-end against it: real MCP tool call, real `ui://` fetch,
  real configured-LLM-endpoint round-trip (against the gateway, never a hardcoded key).
- Capture the command(s) you ran + the observed output in the PR description.

## 5. Adversarial self-review (before opening the PR)

Put on the reviewer's hat and try to **break your own change** before a peer sees it:

- Re-read the diff line by line. Does each line earn its place?
- What's the worst input? What's the blast radius if this fails in production?
- Did you leave debug logs, TODOs, dead code, or a widened scope?
- Are the **hard rules** (below) all intact? Secrets, interop terms, identity rule?
- Run the **full** test suite + linter/typecheck, not just your new tests. Green?
- If a `codex` CLI or a second agent is available, ask for an adversarial pass *now*
  and fix what it finds before the PR exists.

Only when you can't find anything left to fix do you open the PR.

## 6. Open the PR

- `gh pr create` against `main`. Title: Conventional Commit style
  (`feat(viewer): iframe grid renderer (M4-03)`).
- Body must include: **Closes #<issue>**, the AC checklist (each ticked with evidence),
  test output, local-service verification, and — for UI — the before/mock/after shots.
- Link the screenshot-vs-mock comparison for UI issues.
- Keep commits clean and bisectable (squash WIP noise).

## 7. Peer-AI review loop (stay in the loop until approved)

**The designated PR reviewer is GitHub Copilot** — it's the only agent GitHub lets you
formally *request* as a reviewer. Claude and Codex can be *assigned the implementation
work* on an issue, but the review request always goes to Copilot.

- **Request Copilot review** on the PR (GitHub → Reviewers → Copilot, or
  `gh pr edit <n> --add-reviewer @copilot`). This is mandatory, not optional.
- **Address every comment.** Reply on the thread, push fixes, re-request review.
- **Do not merge with open comments.** Iterate until Copilot leaves **zero unresolved
  comments and an explicit approval.** Silence is not approval.
- **Self-review guard:** if *you* are Copilot and you implemented this PR, you cannot be
  your own reviewer — request a human review from Roshan instead, and say so on the PR.
- If you and the reviewer deadlock, escalate to Roshan on the thread — don't merge to
  break a tie.

## 8. Merge

- Merge **only after** explicit reviewer approval + all required CI status checks green.
- Use the repo's merge policy (squash unless told otherwise). Delete the branch.

## 9. Monitor CI post-merge

- Watch the `main` CI run triggered by your merge: `gh run watch` / `gh run list`.
- **If CI fails because of your change:** open a **follow-up fix PR immediately**
  (`fix/<issue-id>-ci-followup`), same loop (TDD → review → merge). Do not leave `main` red.
- **If CI is green** (or the failure is pre-existing and unrelated, verified): **close
  the issue** with a comment linking the merged PR + the green run.

## 10. Done means done

The issue closes only when: PR merged, reviewer approved, CI green on `main`, ACs all
satisfied with evidence, docs updated if behavior changed. Anything less stays open.

---

## Hard rules — break these and the PR is rejected

1. **Preserve Anthropic interop terms verbatim when referencing interop:** `DesignSync`,
   `Claude Design`, `@dsCard`, `_ds_*`, `design-sync`. genie's native surface uses
   its own 13 verbs, `@genie`, `.genie/`, and `genie://`; Anthropic shapes belong
   only in explanatory prose or a future opt-in interop bridge.
2. **Terminology:** the user's component library is a **"UI kit"** (not "design
   system"). genie's *own* locked visual language *is* its "design system." Starter
   templates are **"blueprints."**
3. **Identity / accent rule:** clay/gilt accent (`#c87c5e` / `#ac5a40`) appears **only**
   on generation + refine moments. Structure (chrome, browser, layout) stays
   ink / ink-blue / neutral.
4. **Secrets are never committed.** `HA_AGENT_KEY`, `HONCHO_API_KEY`, `TRUENAS_API_KEY`,
   LLM endpoint keys → env / `user_config` only. Model calls go through the configured
   OpenAI-compatible endpoint, never a hardcoded key or private URL in source.
5. **Embedded-tier CSP is law:** `default-src 'none'`, no web fonts, `connect-src 'none'`.
   Cards must be **byte-identical across `file://` / `localhost` / `ui://`** (RFC G-5).
6. **Skybridge is parked**, not adopted — gated on a pre-M4 spike (RFC §15.8). Don't
   build the viewer on it until that spike clears CSP + G-5.

## Conventions quick-ref

| Thing | Value |
|---|---|
| Repo | `roshangautam/genie` (private) |
| Implementer agents | Claude · Codex · Copilot (any can be assigned an issue) |
| PR reviewer | **Copilot** (only agent GitHub lets you *request* as reviewer) |
| Default branch | `main` (protected: 1 review + status checks) |
| Branch naming | `<type>/<issue-id>-<slug>` |
| Commits | Conventional Commits |
| npm scope | `@genie/*` (e.g. `@genie/viewer`) |
| Issue backlog | `docs/github/issues/` |
| Mock map | `docs/github/MOCK-MAP.md` |
| Design mocks | `docs/designs/design-6/*.svg` |
| Co-author trailer | `Co-Authored-By: Claude <noreply@anthropic.com>` |
