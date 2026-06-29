/**
 * `.genieignore` parser — gitignore-style exclusion rules for kit file listing.
 *
 * Default excludes: `node_modules`, `.git`, `dist`.
 * Lines starting with `#` are comments; blank lines are skipped;
 * a leading `!` negates the pattern (not yet implemented — documented for
 * forward-compat).
 *
 * Patterns are matched against forward-slash-delimited, root-relative paths.
 * A pattern without a `/` matches the basename of any path segment.
 * A pattern with a `/` matches from the root.
 * Glob wildcards `*` (any non-slash chars) and `**` (any path) are supported.
 */

const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist"];

/** Parsed ignore rules for matching against file paths. */
export interface IgnoreRules {
  /** Returns true if the given root-relative path should be excluded. */
  ignores(relativePath: string): boolean;
}

/** Convert a simple glob pattern to a RegExp. */
function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++; // skip second *
      if (pattern[i + 1] === "/") i++; // skip trailing /
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Check whether a pattern contains glob metacharacters. */
function isGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/**
 * Parse a `.genieignore` file into an {@link IgnoreRules} matcher.
 * If the file content is `undefined` (file doesn't exist), the default
 * excludes apply.
 */
export function parseGenieignore(content: string | undefined): IgnoreRules {
  const patterns: string[] = [...DEFAULT_EXCLUDES];

  if (content !== undefined) {
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      patterns.push(line);
    }
  }

  return {
    ignores(relativePath: string): boolean {
      const segments = relativePath.split("/");
      const basename = segments[segments.length - 1] ?? "";

      for (const pattern of patterns) {
        if (isGlob(pattern)) {
          // Glob pattern — match against basename (no slash in pattern)
          // or against full path (slash in pattern)
          if (pattern.includes("/")) {
            if (globToRegex(pattern).test(relativePath)) return true;
          } else {
            if (globToRegex(pattern).test(basename)) return true;
          }
        } else if (pattern.includes("/")) {
          // Path-rooted pattern: match from root
          if (relativePath === pattern || relativePath.startsWith(pattern + "/")) {
            return true;
          }
        } else {
          // Basename pattern: match any segment
          if (segments.includes(pattern)) {
            return true;
          }
        }
      }
      return false;
    },
  };
}
