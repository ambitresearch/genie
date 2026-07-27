import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Every file git tracks under `root`, relative to it.
 *
 * Repo-wide contract tests have to answer "which files does this repository
 * publish?", and a `readdirSync` walk answers a different question: which files
 * happen to sit on this disk. The gap is not theoretical. `.genie/` and
 * `reports/` are gitignored and present in a normal checkout, and `CLAUDE.md`
 * asks every agent to keep a gitignored `.claude/TASKS.md` scratchpad — so a
 * private note stating a Node version could fail a public-documentation
 * contract on one machine and pass on the next.
 *
 * The walks this replaces each carried the same hand-written set of build
 * directories. That denylist is a proxy for "untracked", and like every other
 * hand-maintained list this review has removed, it drifts: it needs extending
 * for each new artefact directory, and it silently admits everything it has not
 * been told about yet. Asking git needs no maintenance and cannot fall behind,
 * because the same answer decides what CI checks out.
 */
export function trackedFiles(root: string): string[] {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .sort();
}

/**
 * The git-index spelling of `file`, relative to `root`.
 *
 * `trackedFiles` returns git's answer, and git separates with `/` on every
 * platform. `path.join` separates with `path.sep`, which is `\` on Windows, so
 * a constant built with `join(...)` and compared against a tracked entry
 * matches on POSIX and quietly stops matching on Windows. Every such constant
 * in this package is a self-exclusion, so that failure is not "one file is
 * skipped" — the lock matches ITSELF, reports itself as an offender, and fails
 * for a reason unrelated to the contract it guards.
 *
 * Callers pass `fileURLToPath(import.meta.url)`, so the answer is derived from
 * where the file actually is rather than restated as a literal, and it keeps
 * following the file when it moves.
 */
export function trackedPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
