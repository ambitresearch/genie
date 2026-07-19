#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  generatePackageSbom(process.argv.slice(2));
}

function generatePackageSbom([packageDirArg, outputArg]) {
  if (!packageDirArg || !outputArg) {
    console.error("Usage: node scripts/generate-package-sbom.mjs <package-dir> <output-file>");
    process.exit(2);
  }

  const packageDir = resolve(repoRoot, packageDirArg);
  const packageJsonPath = join(packageDir, "package.json");
  const outputPath = isAbsolute(outputArg) ? outputArg : resolve(repoRoot, outputArg);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const require = createRequire(import.meta.url);
  const cdxgenRoot = dirname(require.resolve("@cyclonedx/cdxgen"));
  const cdxgenBin = join(cdxgenRoot, "bin", "cdxgen.js");
  const validateBin = join(cdxgenRoot, "bin", "validate.js");
  const tempDir = mkdtempSync(join(tmpdir(), "genie-package-sbom-"));
  const workspaceBomPath = join(tempDir, "workspace.cdx.json");

  try {
    execFileSync(
      process.execPath,
      [
        cdxgenBin,
        "-t",
        "pnpm",
        "--required-only",
        "--no-babel",
        "--no-install-deps",
        "--no-recurse",
        "--spec-version",
        "1.6",
        "-o",
        workspaceBomPath,
        repoRoot,
      ],
      {
        cwd: repoRoot,
        env: scrubEnvironment(process.env),
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    const workspaceBom = JSON.parse(readFileSync(workspaceBomPath, "utf8"));
    const packageBom = selectPackageClosure(workspaceBom, packageJson);
    writeFileSync(outputPath, `${JSON.stringify(packageBom, null, 2)}\n`);

    execFileSync(
      process.execPath,
      [
        validateBin,
        "--input",
        outputPath,
        "--strict",
        "--no-include-manual",
        "--min-severity",
        "critical",
        "--fail-severity",
        "critical",
      ],
      { cwd: repoRoot, env: scrubEnvironment(process.env), stdio: "inherit" },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function selectPackageClosure(workspaceBom, manifest) {
  const packageRoot = (workspaceBom.metadata?.component?.components ?? []).find(
    (component) => componentName(component) === manifest.name,
  );
  if (!packageRoot || packageRoot.version !== manifest.version) {
    throw new Error(
      `Workspace SBOM does not contain ${manifest.name}@${manifest.version}; found ${
        (workspaceBom.metadata?.component?.components ?? [])
          .map((component) => `${componentName(component)}@${component.version}`)
          .join(", ") || "no workspace packages"
      }`,
    );
  }

  const componentsByRef = new Map(
    (workspaceBom.components ?? []).map((component) => [component["bom-ref"], component]),
  );
  const dependenciesByRef = new Map(
    (workspaceBom.dependencies ?? []).map((dependency) => [dependency.ref, dependency]),
  );
  const packageDependency = dependenciesByRef.get(packageRoot["bom-ref"]);
  if (!packageDependency) {
    throw new Error(`Workspace SBOM has no dependency graph for ${manifest.name}`);
  }

  const runtimeNames = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const directRefs = (packageDependency.dependsOn ?? []).filter((ref) =>
    runtimeNames.has(packageNameFromPurl(ref)),
  );
  const foundRuntimeNames = new Set(directRefs.map(packageNameFromPurl));
  const missing = [...runtimeNames].filter((name) => !foundRuntimeNames.has(name));
  if (missing.length) {
    throw new Error(
      `Workspace SBOM is missing runtime dependencies for ${manifest.name}: ${missing.join(", ")}`,
    );
  }

  const includedRefs = new Set();
  const queue = [...directRefs];
  while (queue.length) {
    const ref = queue.shift();
    if (includedRefs.has(ref)) continue;
    if (!componentsByRef.has(ref)) {
      throw new Error(`Workspace SBOM dependency ${ref} has no component record`);
    }
    const dependency = dependenciesByRef.get(ref);
    if (!dependency) {
      throw new Error(`Workspace SBOM component ${ref} has no dependency graph entry`);
    }
    includedRefs.add(ref);
    for (const dependencyRef of dependency.dependsOn ?? []) {
      if (!includedRefs.has(dependencyRef)) queue.push(dependencyRef);
    }
  }

  const root = {
    ...packageRoot,
    description: manifest.description,
    author: typeof manifest.author === "string" ? manifest.author : manifest.author?.name,
    licenses: manifest.license ? [{ license: { id: manifest.license } }] : undefined,
    externalReferences: manifest.repository?.url
      ? [{ type: "vcs", url: manifest.repository.url }]
      : undefined,
    properties: (packageRoot.properties ?? []).filter(
      (property) => !property.name.startsWith("internal:"),
    ),
  };

  const components = [...includedRefs]
    .map((ref) => componentsByRef.get(ref))
    .sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));
  const dependencies = [
    { ref: root["bom-ref"], dependsOn: [...directRefs].sort() },
    ...[...includedRefs].sort().map((ref) => ({
      ref,
      dependsOn: (dependenciesByRef.get(ref)?.dependsOn ?? [])
        .filter((dependencyRef) => includedRefs.has(dependencyRef))
        .sort(),
    })),
  ];

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: workspaceBom.metadata?.tools,
      authors: workspaceBom.metadata?.authors,
      lifecycles: [{ phase: "build" }],
      component: root,
    },
    components,
    dependencies,
  };
}

function componentName(component) {
  return component.group ? `${component.group}/${component.name}` : component.name;
}

function packageNameFromPurl(ref) {
  const prefix = "pkg:npm/";
  if (!ref.startsWith(prefix)) return "";
  const value = ref.slice(prefix.length);
  const versionSeparator = value.lastIndexOf("@");
  return decodeURIComponent(versionSeparator > 0 ? value.slice(0, versionSeparator) : value);
}

function scrubEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        key !== "ACME_EMAIL" &&
        key !== "NODE_PATH" &&
        key !== "NODE_OPTIONS" &&
        key !== "CDXGEN_DEBUG_MODE" &&
        !/(?:TOKEN|KEY|PASSWORD|SECRET|AUTH)/i.test(key),
    ),
  );
}
