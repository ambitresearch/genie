export function collectPnpmOptionalDependencyEdges(
  workspaceBom: Record<string, any>,
  lockfile: Record<string, any>,
  manifest: Record<string, any>,
  packageRelativeDir: string,
): Map<string, string[]>;

export function selectPackageClosure(
  workspaceBom: Record<string, any>,
  manifest: Record<string, any>,
  additionalEdges?: Map<string, string[]>,
): Record<string, any>;
