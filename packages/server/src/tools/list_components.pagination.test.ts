import { describe, expect, it } from "vitest";
import type { ComponentEntry } from "../store/interface.js";
import {
  ManifestParseError,
  compareComponents,
  selectComponents,
} from "../store/manifest.js";
import {
  MAX_COMPONENTS,
  decodeCursor,
  encodeCursor,
  paginateComponents,
} from "./list_components.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function entry(over: Partial<ComponentEntry>): ComponentEntry {
  return {
    name: "Button",
    group: "actions",
    path: "actions/button.html",
    viewport: "desktop",
    hash: "sha256-deadbeef",
    lastModified: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function manifest(components: Partial<ComponentEntry>[]): string {
  return JSON.stringify({ version: 1, components: components.map(entry) });
}

// ─── AC6 — deterministic ordering (pure comparator + selectComponents) ────────

describe("compareComponents (AC6 ordering)", () => {
  it("orders by group ASC, then name ASC, then path ASC", () => {
    const rows: ComponentEntry[] = [
      entry({ group: "b", name: "Z", path: "z" }),
      entry({ group: "a", name: "M", path: "m2" }),
      entry({ group: "a", name: "M", path: "m1" }), // tie on group+name → path breaks it
      entry({ group: "a", name: "A", path: "a" }),
    ];
    const sorted = [...rows].sort(compareComponents);
    expect(sorted.map((c) => `${c.group}/${c.name}/${c.path}`)).toEqual([
      "a/A/a",
      "a/M/m1",
      "a/M/m2",
      "b/Z/z",
    ]);
  });

  it("uses code-unit order (locale-independent): uppercase sorts before lowercase", () => {
    // localeCompare would typically put "a" before "B"; code-unit order puts
    // "B" (0x42) before "a" (0x61). AC6 requires the deterministic latter.
    const sorted = [entry({ group: "a" }), entry({ group: "B" })].sort(compareComponents);
    expect(sorted.map((c) => c.group)).toEqual(["B", "a"]);
  });
});

describe("selectComponents (parse + filter + sort)", () => {
  it("returns [] when the manifest is absent (undefined raw) — AC8", () => {
    expect(selectComponents("k", undefined)).toEqual([]);
  });

  it("returns [] for an empty/whitespace manifest body", () => {
    expect(selectComponents("k", "")).toEqual([]);
    expect(selectComponents("k", "   \n ")).toEqual([]);
  });

  it("returns [] when the group filter matches nothing — AC8", () => {
    const raw = manifest([{ group: "actions" }]);
    expect(selectComponents("k", raw, "nonexistent")).toEqual([]);
  });

  it("filters to an exact group match", () => {
    const raw = manifest([
      { group: "actions", name: "Button", path: "a/button.html" },
      { group: "forms", name: "Input", path: "f/input.html" },
    ]);
    const out = selectComponents("k", raw, "forms");
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("Input");
  });

  it("honours an empty-string group filter literally", () => {
    const raw = manifest([
      { group: "", name: "Ungrouped", path: "u.html" },
      { group: "actions", name: "Button", path: "b.html" },
    ]);
    const out = selectComponents("k", raw, "");
    expect(out.map((c) => c.name)).toEqual(["Ungrouped"]);
  });

  it("sorts deterministically regardless of manifest order — AC6", () => {
    const raw = manifest([
      { group: "forms", name: "Select", path: "f/select.html" },
      { group: "actions", name: "Button", path: "a/button.html" },
      { group: "actions", name: "Anchor", path: "a/anchor.html" },
    ]);
    const out = selectComponents("k", raw);
    expect(out.map((c) => `${c.group}/${c.name}`)).toEqual([
      "actions/Anchor",
      "actions/Button",
      "forms/Select",
    ]);
  });

  it("projects exactly the six AC5 fields, dropping forward-compat extras", () => {
    const raw = JSON.stringify({
      version: 2,
      components: [{ ...entry({}), rendererHint: "iframe", assetDeps: ["x.css"] }],
    });
    const out = selectComponents("k", raw);
    expect(Object.keys(out[0]!).sort()).toEqual([
      "group",
      "hash",
      "lastModified",
      "name",
      "path",
      "viewport",
    ]);
  });

  it("throws ManifestParseError on malformed JSON (corruption != empty kit)", () => {
    expect(() => selectComponents("k", "{ not json")).toThrow(ManifestParseError);
  });

  it("throws ManifestParseError when the shape is wrong", () => {
    expect(() => selectComponents("k", JSON.stringify({ components: "nope" }))).toThrow(
      ManifestParseError,
    );
  });
});

// ─── AC7 — pagination + cursor round-trip (pure) ──────────────────────────────

describe("cursor encode/decode", () => {
  it("round-trips a keyset cursor", () => {
    const e = entry({ group: "g", name: "n", path: "p" });
    expect(decodeCursor(encodeCursor(e))).toEqual({ g: "g", n: "n", p: "p" });
  });

  it("rejects a tampered cursor", () => {
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow(/Invalid cursor/);
    expect(() => decodeCursor(Buffer.from('{"g":1}').toString("base64url"))).toThrow(
      /wrong shape/,
    );
  });

  it("does not echo the full untrusted cursor into the error message", () => {
    // Regression (PR #110 review): a maliciously large / opaque cursor must not
    // be reflected verbatim into error text (log bloat + token leak-back). The
    // message stays diagnostic but bounded — the raw token never appears whole.
    const huge = "A".repeat(5000);
    let message = "";
    try {
      decodeCursor(huge);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Invalid cursor/);
    expect(message).not.toContain(huge);
    expect(message.length).toBeLessThan(120);
  });

});

describe("paginateComponents (AC7)", () => {
  function many(n: number): ComponentEntry[] {
    // Zero-padded names so code-unit order == numeric order for assertions.
    return Array.from({ length: n }, (_, i) =>
      entry({ group: "g", name: `c${String(i).padStart(4, "0")}`, path: `g/c${i}.html` }),
    ).sort(compareComponents);
  }

  it("returns the whole list and no cursor when at/under the cap", () => {
    const res = paginateComponents(many(MAX_COMPONENTS));
    expect(res.components).toHaveLength(MAX_COMPONENTS);
    expect(res.nextCursor).toBeUndefined();
  });

  it("caps the first page at MAX_COMPONENTS and returns a cursor when more remain", () => {
    const res = paginateComponents(many(MAX_COMPONENTS + 1));
    expect(res.components).toHaveLength(MAX_COMPONENTS);
    expect(res.nextCursor).toBeTypeOf("string");
  });

  it("round-trips a cursor to cover every element exactly once, in order", () => {
    const all = many(MAX_COMPONENTS * 2 + 7); // 519 → 3 pages
    const seen: ComponentEntry[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = paginateComponents(all, cursor);
      seen.push(...res.components);
      cursor = res.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(4); // guard against infinite loop
    } while (cursor !== undefined);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(all.length);
    // Exact ordered equality — no dupes, no gaps across the page boundary.
    expect(seen.map((c) => c.name)).toEqual(all.map((c) => c.name));
  });

  it("keyset cursor stays correct if entries before the cursor are deleted", () => {
    const all = many(MAX_COMPONENTS + 10);
    const first = paginateComponents(all);
    // Simulate the manifest shrinking: drop the first 5 (already-returned) rows.
    const shrunk = all.slice(5);
    const second = paginateComponents(shrunk, first.nextCursor);
    // Page 2 still starts right after page 1's last entry — no skips, no repeats.
    expect(second.components[0]?.name).toBe(all[MAX_COMPONENTS]?.name);
    expect(second.components.some((c) => first.components.includes(c))).toBe(false);
  });
});
