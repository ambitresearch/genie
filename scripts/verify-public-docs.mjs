import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const PUBLIC_MARKDOWN_FILES = [
  "docs/404.md",
  "docs/developer/architecture.md",
  "docs/developer/contributing.md",
  "docs/developer/design-system.md",
  "docs/developer/documentation.md",
  "docs/developer/index.md",
  "docs/developer/releases.md",
  "docs/developer/security.md",
  "docs/harness/README.md",
  "docs/harness/claude-code.md",
  "docs/harness/claude-desktop.md",
  "docs/harness/cline.md",
  "docs/harness/codex.md",
  "docs/harness/continue.md",
  "docs/harness/copilot.md",
  "docs/harness/cursor.md",
  "docs/index.md",
  "docs/supply-chain.md",
  "docs/user/harnesses.md",
  "docs/user/index.md",
  "docs/user/installation.md",
  "docs/user/troubleshooting.md",
  "docs/user/workflow.md",
];

const retainedNonSiteMarkdown = new Set(["docs/designs/design-6/design.md"]);
const binaryExtensions = new Set([
  ".avif",
  ".eot",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2",
]);
const forbiddenArtifactPaths = [/^(?:\.deliverables|designs|research)(?:\/|$)/i];
const forbiddenContent = [
  /docs\/(?:github|plan|superpowers|traceability)(?:\/|\.md)/i,
  /docs\/research\/(?!_explainer-viewer\.html|_genie-viewer\.html)/i,
  /[a-z0-9-]+\.local\b/i,
  /[a-z0-9.-]+\.ts\.net\b/i,
  /\/Users\/(?!you(?:\/|$))[^/\s]+(?:\/|$)/,
  /\/home\/(?!you(?:\/|$))[^/\s]+(?:\/|$)/,
  /[a-z]:\\Users\\(?!you(?:\\|$))[^\\\s]+(?:\\|$)/i,
  /(?:GITHUB_PERSONAL_ACCESS_TOKEN|TRUENAS_API_KEY|HA_AGENT_KEY|HONCHO_API_KEY|shellprivatevars)/,
];

const privateIpv4Patterns = [
  /(?<![\d.])10(?:\.\d{1,3}){3}(?![\d.])/,
  /(?<![\d.])172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}(?![\d.])/,
  /(?<![\d.])192\.168(?:\.\d{1,3}){2}(?![\d.])/,
  /(?<![\d.])100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}(?![\d.])/,
  /(?<![a-z0-9%])192%2e168%2e\d{1,3}%2e\d{1,3}(?![a-z0-9%])/i,
  /(?<![a-z0-9])0xc0\.0xa8\.(?:0x)?[\da-f]+\.(?:0x)?[\da-f]+(?![a-z0-9])/i,
];
const privateIpv6Patterns = [
  /(?<![\da-f:])f[cd][\da-f]{2}(?::[\da-f]{0,4}){1,7}(?![\da-f:])/i,
  /(?<![\da-f:])fe[89ab][\da-f](?::[\da-f]{0,4}){1,7}(?![\da-f:])/i,
];

const integerHostPattern =
  /(?:https?:\/\/|\bconnect\s+to\s+|\bhost(?:name)?\s*[=:]\s*)(\d{8,10})\b/gi;
const privateIpv4IntegerRanges = [
  [167772160, 184549375],
  [1681915904, 1686110207],
  [2886729728, 2887778303],
  [3232235520, 3232301055],
];

async function filesUnder(root, predicate, options = {}) {
  const { skipHidden = false } = options;
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (skipHidden && entry.name.startsWith(".")) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path, predicate, options)));
    else if (predicate(path)) files.push(path);
  }
  return files;
}

export function unexpectedMarkdownFiles(markdownFiles) {
  const allowed = new Set([...PUBLIC_MARKDOWN_FILES, ...retainedNonSiteMarkdown]);
  return markdownFiles.filter((path) => !allowed.has(path)).sort();
}

export function forbiddenMatches(path, content) {
  const matches = forbiddenContent
    .filter((pattern) => pattern.test(content))
    .map((pattern) => ({ path, pattern: pattern.source }));
  matches.push(
    ...privateIpv4Patterns
      .filter((pattern) => pattern.test(content))
      .map((pattern) => ({ path, pattern: pattern.source })),
  );
  matches.push(
    ...privateIpv6Patterns
      .filter((pattern) => pattern.test(content))
      .map((pattern) => ({ path, pattern: pattern.source })),
  );
  integerHostPattern.lastIndex = 0;
  for (const match of content.matchAll(integerHostPattern)) {
    const value = Number(match[1]);
    if (privateIpv4IntegerRanges.some(([start, end]) => value >= start && value <= end)) {
      matches.push({ path, pattern: "private IPv4 integer host" });
    }
  }
  return matches;
}

export function forbiddenArtifactPath(path) {
  return forbiddenArtifactPaths.some((pattern) => pattern.test(path));
}

export async function verifyPublicDocs(root = repoRoot) {
  const markdown = (
    await filesUnder(resolve(root, "docs"), (path) => path.endsWith(".md"), { skipHidden: true })
  ).map((path) => relative(root, path).replaceAll("\\", "/"));
  const unexpected = unexpectedMarkdownFiles(markdown);
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected Markdown would cross the public-docs boundary:\n${unexpected.join("\n")}`,
    );
  }

  const distRoot = resolve(root, "docs/.vitepress/dist");
  const artifacts = await filesUnder(distRoot, () => true);
  const violations = [];
  for (const artifact of artifacts) {
    const artifactPath = relative(distRoot, artifact).replaceAll("\\", "/");
    if (forbiddenArtifactPath(artifactPath)) {
      violations.push({ path: artifactPath, pattern: "forbidden artifact route" });
      continue;
    }
    if (binaryExtensions.has(extname(artifact).toLowerCase())) continue;
    const content = await readFile(artifact, "utf8");
    violations.push(...forbiddenMatches(artifactPath, content));
  }
  if (violations.length > 0) {
    throw new Error(
      `Forbidden internal content reached the Pages artifact:\n${violations.map(({ path, pattern }) => `${path}: ${pattern}`).join("\n")}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyPublicDocs();
  process.stdout.write("Public documentation boundary verified.\n");
}
