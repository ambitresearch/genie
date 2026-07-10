import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureManifest } from "./ensure.js";

describe("ensureManifest", () => {
  it("returns the compiled manifest and persists the same manifest atomically", async () => {
    const kitDir = await mkdtemp(join(tmpdir(), "genie-ensure-manifest-"));
    const componentDir = join(kitDir, "components", "actions", "Button");
    await mkdir(componentDir, { recursive: true });
    await writeFile(
      join(componentDir, "Button.html"),
      '<!-- @genie group="actions" viewport="480x240" name="Button" -->\n' +
        "<!doctype html><html><body><button>Save</button></body></html>\n",
      "utf8",
    );

    const manifest = await ensureManifest(kitDir);
    const persisted = JSON.parse(
      await readFile(join(kitDir, ".genie", "manifest.json"), "utf8"),
    ) as unknown;

    expect(manifest.components).toHaveLength(1);
    expect(manifest.components[0]).toMatchObject({
      group: "actions",
      name: "Button",
      path: "components/actions/Button/Button.html",
    });
    expect(persisted).toEqual(manifest);
  });
});
