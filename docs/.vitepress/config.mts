import { defineConfig } from "vitepress";

const harnessItems = [
  { text: "Capability overview", link: "/harness/README" },
  { text: "Claude Code", link: "/harness/claude-code" },
  { text: "Claude Desktop", link: "/harness/claude-desktop" },
  { text: "Cursor", link: "/harness/cursor" },
  { text: "Codex CLI", link: "/harness/codex" },
  { text: "GitHub Copilot", link: "/harness/copilot" },
  { text: "Continue", link: "/harness/continue" },
  { text: "Cline", link: "/harness/cline" },
] as const;

export default defineConfig({
  title: "genie",
  description: "User and developer documentation for the genie MCP server",
  base: "/genie/",
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: [".deliverables/**", "designs/**", "research/**"],
  head: [["link", { rel: "icon", href: "/genie/favicon.svg" }]],
  themeConfig: {
    logo: "/favicon.svg",
    siteTitle: "genie",
    nav: [
      { text: "User Guide", link: "/user/" },
      { text: "Developer Guide", link: "/developer/" },
    ],
    sidebar: {
      "/user/": [
        {
          text: "User Guide",
          items: [
            { text: "Overview", link: "/user/" },
            { text: "Installation", link: "/user/installation" },
            { text: "Connect a coding agent", link: "/user/harnesses" },
            { text: "Component workflow", link: "/user/workflow" },
            { text: "Troubleshooting", link: "/user/troubleshooting" },
          ],
        },
        { text: "Harness reference", collapsed: true, items: harnessItems },
      ],
      "/harness/": [{ text: "Harness reference", items: harnessItems }],
      "/developer/": [
        {
          text: "Developer Guide",
          items: [
            { text: "Overview", link: "/developer/" },
            { text: "Architecture", link: "/developer/architecture" },
            { text: "Contributing", link: "/developer/contributing" },
            { text: "Security model", link: "/developer/security" },
            { text: "Releases", link: "/developer/releases" },
            { text: "Design system", link: "/developer/design-system" },
            { text: "Maintaining the docs", link: "/developer/documentation" },
            { text: "Supply-chain security", link: "/supply-chain" },
          ],
        },
      ],
    },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/ambitresearch/genie" }],
    editLink: {
      pattern: "https://github.com/ambitresearch/genie/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright 2026 Roshan Gautam",
    },
  },
});
