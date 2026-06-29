import { describe, it, expect } from "vitest";
import { parseGenieignore } from "./genieignore.js";

describe("parseGenieignore", () => {
  it("excludes node_modules, .git, dist by default when no file exists", () => {
    const rules = parseGenieignore(undefined);
    expect(rules.ignores("node_modules/foo/bar.js")).toBe(true);
    expect(rules.ignores(".git/objects/abc")).toBe(true);
    expect(rules.ignores("dist/bundle.js")).toBe(true);
    expect(rules.ignores("src/index.ts")).toBe(false);
  });

  it("includes default excludes even when a .genieignore exists", () => {
    const rules = parseGenieignore("build");
    expect(rules.ignores("node_modules/pkg/index.js")).toBe(true);
    expect(rules.ignores(".git/HEAD")).toBe(true);
    expect(rules.ignores("dist/out.js")).toBe(true);
    expect(rules.ignores("build/main.js")).toBe(true);
  });

  it("skips blank lines and comments", () => {
    const rules = parseGenieignore("# this is a comment\n\n  \nbuild");
    expect(rules.ignores("build/file.js")).toBe(true);
    expect(rules.ignores("src/app.ts")).toBe(false);
  });

  it("matches basename patterns against any path segment", () => {
    const rules = parseGenieignore("__pycache__");
    expect(rules.ignores("__pycache__/foo.pyc")).toBe(true);
    expect(rules.ignores("src/__pycache__/bar.pyc")).toBe(true);
    expect(rules.ignores("src/main.py")).toBe(false);
  });

  it("matches path-rooted patterns from root", () => {
    const rules = parseGenieignore("build/temp");
    expect(rules.ignores("build/temp")).toBe(true);
    expect(rules.ignores("build/temp/file.js")).toBe(true);
    expect(rules.ignores("other/build/temp")).toBe(false);
  });

  it("does not exclude files that merely contain a pattern name", () => {
    const rules = parseGenieignore("build");
    expect(rules.ignores("rebuild.ts")).toBe(false);
    expect(rules.ignores("build-tools.ts")).toBe(false);
  });

  it("matches glob * patterns against basenames", () => {
    const rules = parseGenieignore("*.log");
    expect(rules.ignores("debug.log")).toBe(true);
    expect(rules.ignores("src/error.log")).toBe(true);
    expect(rules.ignores("src/app.ts")).toBe(false);
    expect(rules.ignores("logfile.txt")).toBe(false);
  });

  it("matches glob ? patterns", () => {
    const rules = parseGenieignore("?.ts");
    expect(rules.ignores("a.ts")).toBe(true);
    expect(rules.ignores("ab.ts")).toBe(false);
  });

  it("matches glob ** patterns across directories", () => {
    const rules = parseGenieignore("src/**/test");
    expect(rules.ignores("src/test")).toBe(true);
    expect(rules.ignores("src/foo/test")).toBe(true);
    expect(rules.ignores("src/foo/bar/test")).toBe(true);
    expect(rules.ignores("lib/test")).toBe(false);
  });
});
