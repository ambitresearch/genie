import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forbiddenArtifactPath,
  forbiddenMatches,
  PUBLIC_MARKDOWN_FILES,
  unexpectedMarkdownFiles,
  verifyPublicDocs,
} from "../../../scripts/verify-public-docs.mjs";

describe("public documentation boundary", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("rejects an unexpected Markdown file instead of publishing it", () => {
    expect(unexpectedMarkdownFiles([...PUBLIC_MARKDOWN_FILES, "docs/internal-note.md"])).toEqual([
      "docs/internal-note.md",
    ]);
  });

  it("accepts the explicit published Markdown set", () => {
    expect(unexpectedMarkdownFiles([...PUBLIC_MARKDOWN_FILES])).toEqual([]);
  });

  it.each(["docs/.vitepress/cache/index.md", "docs/.deliverables/staging/notes.md"])(
    "ignores explicit generated Markdown path %s",
    (path) => {
      expect(unexpectedMarkdownFiles([...PUBLIC_MARKDOWN_FILES, path])).toEqual([]);
    },
  );

  it("rejects Markdown hidden below the docs root", async () => {
    const root = await mkdtemp(join(tmpdir(), "genie-public-docs-hidden-source-"));
    tempRoots.push(root);
    const hiddenMarkdown = join(root, "docs/.internal/notes.md");
    await mkdir(join(hiddenMarkdown, ".."), { recursive: true });
    await mkdir(join(root, "docs/.vitepress/dist"), { recursive: true });
    await writeFile(hiddenMarkdown, "internal notes");

    await expect(verifyPublicDocs(root)).rejects.toThrow("Unexpected Markdown");
  });

  it.each([
    ["private host", "connect to homeassistant.local"],
    ["private address", "connect to 192.168.1.180"],
    ["secret name", "export TRUENAS_API_KEY"],
    ["internal plan", "read docs/plan/02-brd.md"],
    ["private 10/8 address", "connect to 10.20.30.40"],
    ["private 172.16/12 address", "connect to 172.20.30.40"],
    ["personal absolute path", "read /Users/alice/private.txt"],
    ["personal home without trailing slash", "read /Users/alice"],
    ["placeholder prefix collision", "read /Users/you-example/private.txt"],
    ["Linux personal absolute path", "read /home/alice/private.txt"],
    ["Linux personal home without trailing slash", "read /home/alice"],
    ["Linux placeholder prefix collision", "read /home/you-example/private.txt"],
    ["Windows personal absolute path", String.raw`read C:\Users\alice\private.txt`],
    ["Windows personal home without trailing slash", String.raw`read C:\Users\alice`],
    ["Windows placeholder prefix collision", String.raw`read C:\Users\you-example\private.txt`],
    ["repository token name", "export GITHUB_PERSONAL_ACCESS_TOKEN"],
    ["percent-encoded private host", "open https://192%2e168%2e1%2e180/path"],
    ["hexadecimal private host", "open http://0xc0.0xa8.0x1.0x1/path"],
    ["integer private URL host", "open http://3232235777/path"],
    ["integer host assignment", "host=3232235777"],
    ["integer hostname assignment", "hostname=3232235777"],
    ["integer connect target", "connect to 3232235777"],
    ["IPv6 ULA host", "open http://[fd00::1]/path"],
    ["IPv6 ULA fc00/7 host", "connect to fc12:3456::1"],
    ["IPv6 link-local host", "open http://[fe80::1]/path"],
    ["IPv6 upper link-local range", "hostname=febf::1"],
  ])("detects %s in the built artifact", (_name, content) => {
    expect(forbiddenMatches("docs/.vitepress/dist/index.html", content)).not.toEqual([]);
  });

  it.each([
    "210.20.30.40",
    "110.20.30.40",
    "/Users/you/private.txt",
    "/home/you/private.txt",
    String.raw`C:\Users\you\private.txt`,
    "2001:db8::1",
    "2606:4700:4700::1111",
  ])("does not reject public or documented placeholder value %s", (content) => {
    expect(forbiddenMatches("docs/.vitepress/dist/index.html", content)).toEqual([]);
  });

  it.each(["designs/private.html", "research/notes.json", ".deliverables/debug.txt"])(
    "rejects forbidden built route %s",
    (path) => {
      expect(forbiddenArtifactPath(path)).toBe(true);
    },
  );

  it.each([
    ["SVG", "leak.svg"],
    ["CSS", "assets/leak.css"],
    ["source map", "assets/leak.js.map"],
    ["hidden artifact", ".well-known/leak.txt"],
  ])("fails verification when %s contains private content", async (_name, artifactPath) => {
    const root = await mkdtemp(join(tmpdir(), "genie-public-docs-boundary-"));
    tempRoots.push(root);
    const dist = join(root, "docs/.vitepress/dist");
    const artifact = join(dist, artifactPath);
    await mkdir(join(artifact, ".."), { recursive: true });
    await writeFile(artifact, "connect to 192.168.1.180");

    await expect(verifyPublicDocs(root)).rejects.toThrow("Forbidden internal content");
  });

  it("rejects a retained design route if VitePress publishes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "genie-public-docs-route-"));
    tempRoots.push(root);
    const artifact = join(root, "docs/.vitepress/dist/designs/design-6/design.html");
    await mkdir(join(artifact, ".."), { recursive: true });
    await writeFile(artifact, "public-looking content");

    await expect(verifyPublicDocs(root)).rejects.toThrow("forbidden artifact route");
  });
});
