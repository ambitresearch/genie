import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const readRootFile = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

describe("public documentation surface", () => {
  it("publishes only the curated user and developer guides", () => {
    expect(existsSync(resolve(ROOT, "docs/user/index.md"))).toBe(true);
    expect(existsSync(resolve(ROOT, "docs/developer/index.md"))).toBe(true);

    for (const internalPath of [
      "docs/plan/02-brd.md",
      "docs/github/issues/M6-05-public-docs-site.md",
      "docs/research/skybridge.md",
      "docs/superpowers/specs/2026-07-05-genie-chat-invocation-design.md",
      "docs/traceability.md",
      "docs/designs/design-1/design.md",
      "docs/designs/design-2/design.md",
      "docs/designs/design-3/design.md",
      "docs/designs/design-4/design.md",
      "docs/designs/design/option-1-workbench-grid.svg",
      "docs/security-audit-v1.md",
    ]) {
      expect(existsSync(resolve(ROOT, internalPath)), internalPath).toBe(false);
    }
  });

  it("preserves the final design reference and tracked prototypes", () => {
    for (const publicReference of [
      "docs/designs/design-6/design.md",
      "docs/designs/design-6/prototype.html",
      "docs/research/_explainer-viewer.html",
      "docs/research/_genie-viewer.html",
    ]) {
      expect(existsSync(resolve(ROOT, publicReference)), publicReference).toBe(true);
    }

    expect(readRootFile("docs/index.md")).not.toContain("guide-card--accent");
  });

  it("configures the two guides for the public Pages URL", () => {
    const config = readRootFile("docs/.vitepress/config.mts");

    expect(config).toContain('base: "/genie/"');
    expect(config).toContain('provider: "local"');
    expect(config).toContain('{ text: "User Guide", link: "/user/" }');
    expect(config).toContain('{ text: "Developer Guide", link: "/developer/" }');
    expect(config).toContain('{ text: "Capability overview", link: "/harness/README" }');
    expect(config).toContain('"/user/":');
    expect(config).toContain('"/developer/":');
  });

  it("keeps the Pages workflow least-privileged and SHA-pinned", () => {
    const workflow = readRootFile(".github/workflows/docs.yml");

    expect(workflow).toContain("pages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("pnpm docs:build");
    expect(workflow).toContain("pnpm docs:verify");
    expect(workflow).toContain("path: docs/.vitepress/dist");
    expect(workflow).toContain("actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b");
    expect(workflow).toContain(
      "actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b",
    );
    expect(workflow).toContain("actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e");
  });

  it("keeps documentation on the repository's pinned Node toolchain", () => {
    const packageJson = JSON.parse(readRootFile("package.json")) as {
      readonly scripts?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
    };

    expect(packageJson.scripts?.["docs:dev"]).toBe("vitepress dev docs");
    expect(packageJson.scripts?.["docs:build"]).toBe("vitepress build docs");
    expect(packageJson.scripts?.["docs:preview"]).toBe("vitepress preview docs");
    expect(packageJson.scripts?.["docs:verify"]).toBe("node scripts/verify-public-docs.mjs");
    expect(packageJson.devDependencies?.vitepress).toBe("2.0.0-alpha.18");
    expect(readRootFile("docs/developer/documentation.md")).toContain(
      "Move back to a stable VitePress release",
    );
    expect(existsSync(resolve(ROOT, "mkdocs.yml"))).toBe(false);
    expect(existsSync(resolve(ROOT, "requirements-docs.txt"))).toBe(false);
  });

  it("describes the shipped product instead of the obsolete M1 scaffold", () => {
    const readme = readRootFile("README.md");

    expect(readme).not.toContain("Status: scaffold (M1 in progress)");
    expect(readme).toContain("[User Guide](https://ambitresearch.github.io/genie/user/)");
    expect(readme).toContain("[Developer Guide](https://ambitresearch.github.io/genie/developer/)");
  });

  it("uses root-safe links on the custom 404 page", () => {
    const notFound = readRootFile("docs/404.md");

    expect(notFound).toContain(
      "[Return to the documentation home](https://ambitresearch.github.io/genie/)",
    );
    expect(notFound).toContain("[User Guide](https://ambitresearch.github.io/genie/user/)");
    expect(notFound).toContain(
      "[Developer Guide](https://ambitresearch.github.io/genie/developer/)",
    );
  });
});
