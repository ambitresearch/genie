/**
 * Stand-in for `dist/llm/schema.js` (M2-02 `schema.test.ts`'s CLI-entrypoint
 * test). Plain `.mjs`, not `.ts` — the point of using this fixture rather
 * than importing `../../src/llm/schema.ts` directly is that the *real*
 * `pnpm build` postbuild step only ever runs `emit-component-schema.mjs`
 * against already-`tsc`-compiled JavaScript (see package.json's `build`
 * script: `tsc -p tsconfig.json && node scripts/emit-component-schema.mjs`),
 * never against a `.ts` source file. Testing the CLI entrypoint against a
 * plain `.mjs` fixture with the same shape as compiled output matches that
 * real invocation exactly, without depending on the test-runner process
 * (plain `node`, not vitest) being able to type-strip/transform TypeScript —
 * a capability this repo's own `dev` script doesn't rely on for `.ts` files
 * (it uses `tsx`, not plain `node`) and whose exact version floor across the
 * CI matrix's Node 22 vs Node 24 legs isn't a bet worth making here.
 */
export const COMPONENT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "GenieComponentFixture",
  type: "object",
  properties: {
    componentName: { type: "string" },
  },
};
