/**
 * Seed a kit that `store.getKit` resolves, without paying for `createKit`.
 *
 * #269 makes `write_files` re-check the kit immediately before it commits. The
 * tests that exercise the write path call `createPlan`/`writeFiles` directly,
 * beneath the tool layer, and historically only `mkdir`'d the destination
 * directory — a directory alone was enough, because nothing ever asked the
 * store whether the kit existed. Now something does, so those fixtures need a
 * kit that genuinely resolves.
 *
 * The obvious fixture is `store.createKit`, but that also scaffolds the viewer
 * shell (`viewer.js` alone is ~256 KB) via `loadViewerAssets`, which re-reads
 * the whole static directory from disk on EVERY call — there is no cache
 * (`src/store/viewer-assets.ts:100`). Measured in `write_files.test.ts` that is
 * ~830 ms per test, which tripled the file's runtime and pushed several tests
 * past vitest's 5 s default timeout.
 *
 * `getKit` (`src/store/local.ts:506-515`) reads ONLY `<kitDir>/.kit.json`, and
 * `createKit`'s own comment calls that exclusive write "the only publication
 * point `getKit`/`listKits` key off" — so writing just that file is the
 * documented minimum, not a shortcut around the store's contract. The viewer
 * scaffold is irrelevant to the assertions in these suites.
 *
 * `createKit` itself stays covered end-to-end by the wire-level tests in
 * `write_files.test.ts` and by `test/store-conformance.test.ts`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { KIT_TYPE } from "../../src/store/interface.js";

export async function seedKit(kitsRoot: string, kitId: string, name = kitId): Promise<string> {
  const dir = join(kitsRoot, kitId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, ".kit.json"),
    JSON.stringify(
      { id: kitId, name, type: KIT_TYPE, createdAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  return dir;
}
