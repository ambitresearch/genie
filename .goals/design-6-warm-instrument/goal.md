# Goal: Design 6 warm instrument prototype

## User Request

Use the goal skill. Generate a 6th option with the recommended hybrid direction, build a working prototype this time, and create a new folder inside `docs/designs/`.

## Refined Goal

Create a new `docs/designs/design-6/` direction for Genie called **Warm Instrument**. It should combine `design-1`'s warmth and craft, `design-4`'s restrained app shell, `option-2`'s prompt-first onboarding, `option-1`'s workbench layout, and `option-3`'s review/approval flow. The output must include static SVG mocks and a working static prototype that can be opened locally without a server or network calls.

## Acceptance Criteria

- [ ] Criterion 1: `docs/designs/design-6/` exists and contains a `design.md` that names the direction, explains the hybrid rationale, defines color/type/spacing rules, and preserves Genie terminology and hard rules.
- [ ] Criterion 2: `docs/designs/design-6/tokens.css` exists and defines the minimal token set needed by the prototype.
- [ ] Criterion 3: Four SVG mocks exist in the new folder: `00-front-door.svg`, `01-ui-kit-browser.svg`, `02-preview-refine.svg`, and `03-embedded-modes.svg`.
- [ ] Criterion 4: A working static prototype exists in the new folder, opens via `file://` without build steps, and lets a reviewer navigate at least front door, workbench, and review states.
- [ ] Criterion 5: The design uses clay/gilt accent only for generation/refine moments; structure stays ink/neutral.
- [ ] Criterion 6: Embedded-tier guidance in the design/prototype respects `default-src 'none'`, no web fonts, and no network dependencies.

## Scope Boundaries

**In scope:**

- New design artifacts under `docs/designs/design-6/`.
- Static SVG mocks.
- One dependency-free local prototype.
- Minimal documentation needed to review the design direction.

**Out of scope:**

- Changing application source code outside `docs/designs/design-6/`.
- Adding new npm packages or build tooling.
- Replacing or editing existing design folders.
- Implementing production UI components.
- Opening a PR or pushing changes.

## Applicable Project Conventions

**Quality gate command:**

- `pnpm format:check` for document/artifact formatting when practical.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` are full repo gates, but this goal is design-artifact only.

**Commit convention:**

- Conventional commits.
- Builder commits must use `type(scope): [B] description`.
- Inspector commits must use `chore(scope): [I] description`.
- Assisted-by trailer required: `Assisted-by: Claude:Sonnet-4.6` for Builder and `Assisted-by: Claude:Haiku-4.5` for Inspector.

**Guidelines:**

- `AGENTS.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- Existing design folder conventions in `docs/designs/design-1/` through `docs/designs/design-4/`.

**Rules:**

- Preserve interop terms verbatim: `DesignSync`, `Claude Design`, `@dsCard`, `_ds_*`, `design-sync`.
- Use "UI kit" for the user's component library. Genie may have its own "design system." Starter templates are "blueprints."
- Clay/gilt accent appears only on generation and refine moments.
- Embedded-tier CSP is law: `default-src 'none'`, no web fonts, `connect-src 'none'`.
- Cards must be byte-identical across `file://`, `localhost`, and `ui://`.
- Skybridge is parked and must not be used.
