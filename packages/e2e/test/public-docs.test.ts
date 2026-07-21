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

  it("documents the guarded landing-page workflow with canonical typography", () => {
    const home = readRootFile("docs/index.md");
    const styles = readRootFile("docs/.vitepress/theme/style.css");
    const theme = readRootFile("docs/.vitepress/theme/index.ts");
    const packageJson = JSON.parse(readRootFile("package.json")) as {
      readonly devDependencies?: Readonly<Record<string, string>>;
    };
    const applyPosition = home.indexOf("02 / Apply");
    const previewPosition = home.indexOf("03 / Preview");

    expect(home).toContain('<div class="genie-actions" role="group" aria-label="Get started">');
    expect(home).toContain('<ol class="genie-steps" role="list">');
    expect(applyPosition).toBeGreaterThan(-1);
    expect(previewPosition).toBeGreaterThan(-1);
    expect(applyPosition).toBeLessThan(previewPosition);
    expect(home).toContain("generate proposed files");
    expect(theme).toContain('import "@fontsource-variable/inter/wght.css";');
    expect(theme).toContain('import "@fontsource-variable/jetbrains-mono/wght.css";');
    expect(theme).toContain('import "@fontsource-variable/newsreader/wght.css";');
    expect(theme).toContain('import "@fontsource-variable/newsreader/wght-italic.css";');
    expect(packageJson.devDependencies?.["@fontsource-variable/inter"]).toBe("5.2.8");
    expect(packageJson.devDependencies?.["@fontsource-variable/jetbrains-mono"]).toBe("5.2.8");
    expect(packageJson.devDependencies?.["@fontsource-variable/newsreader"]).toBe("5.2.10");
    expect(styles).toMatch(
      /font-family:\s*"Inter Variable",\s*Inter,\s*ui-sans-serif,\s*system-ui,\s*-apple-system,/,
    );
    expect(styles).toContain(
      'font-family: "Newsreader Variable", Newsreader, Georgia, "Times New Roman", serif;',
    );
    expect(styles).toMatch(
      /font-family:\s*"JetBrains Mono Variable",\s*"JetBrains Mono",\s*ui-monospace,/,
    );
    expect(styles).not.toMatch(/font-family:\s*"JetBrains Mono",\s*ui-monospace,/);
    expect(styles).toMatch(/\.genie-steps code[^}]*"JetBrains Mono Variable"/s);
    expect(styles).not.toMatch(
      /\.genie-(?:kicker|section-label|scroll|steps li > span|paths span)[^{]*{[^}]*JetBrains Mono/s,
    );
    expect(styles).toContain('url("/genie/images/genie-alpine-atmospheric.webp")');
    expect(existsSync(resolve(ROOT, "docs/public/images/genie-alpine-atmospheric.webp"))).toBe(
      true,
    );
    expect(styles).not.toMatch(/\.guide-(?:grid|card)/);
    expect(styles).not.toMatch(
      /\.genie-(?:workflow h2|steps h3|paths strong)[^{]*{[^}]*Newsreader/s,
    );
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

    expect(workflow).toContain(
      "  build:\n    permissions:\n      contents: read\n      pages: read",
    );
    expect(workflow).toContain("pages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("pnpm docs:build");
    expect(workflow).toContain("pnpm docs:verify");
    expect(workflow).toContain("group: pages-${{ github.ref }}");
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

  it("documents storage and release sequencing accurately", () => {
    const installation = readRootFile("docs/user/installation.md");
    expect(installation).toContain("Node.js 22.19 or newer for the npm/source path");
    expect(installation).toContain("Published images run the HTTP transport");
    expect(installation).toContain(
      "| `GENIE_HOME`          | `.genie` below the working directory.",
    );
    const envExample = readRootFile(".env.example");
    expect(envExample).toContain("Optional; OAuth is disabled when unset");
    expect(envExample).toContain("Not used by stdio");
    const releases = readRootFile("docs/developer/releases.md");
    expect(releases).toContain("GitHub component tags already exist at this point");
    expect(releases).toContain("without a tag-promotion phase");
  });
});
