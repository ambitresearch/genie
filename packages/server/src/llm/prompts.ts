/**
 * System-prompt loader + versioning (M2-03 · AC5).
 *
 * `conjure` (and later `refine`, M2-04) must load their system prompt from a
 * versioned `*.system.md` file under `prompts/`, and log the prompt's version
 * on every model call (AC5 / AC10). This module owns both halves: reading the
 * markdown off disk once, and deriving a stable content-address for it.
 *
 * ── Why the git *blob* hash is the version ────────────────────────────────────
 * AC5 says "versioned (commit hash logged on every call)". A literal repo commit
 * hash is the wrong unit here: it changes when *any* file in the repo changes,
 * would be null in a shrink-wrapped npm tarball with no `.git`, and can't be
 * computed at runtime without shelling out to git. What we actually want is a
 * fingerprint of *this prompt's bytes* that (a) changes iff the prompt text
 * changes, (b) is computable offline from the file alone, and (c) is
 * independently verifiable. `git hash-object` is exactly that — the SHA-1 of
 * `"blob <byteLength>\0<content>"` — so `promptVersion` for a given file equals
 * `git hash-object <file>`, letting a reviewer confirm which prompt shipped from
 * a log line alone. The prompt CHANGELOG.md carries the human narrative; this
 * hash is the machine-checkable pin.
 *
 * ── Resolution ────────────────────────────────────────────────────────────────
 * Prompts sit next to this module (`llm/prompts/*.system.md`) and are copied
 * into `dist/llm/prompts/` by the build's copy-prompts step, so resolving
 * relative to `import.meta.url` works identically under `tsx` (src) and `node`
 * (dist). Read once and memoized: the file is immutable for the process's life,
 * and re-reading + re-hashing on every `conjure` call would be pointless I/O on
 * genie's hottest path.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/** The system prompt for `conjure` (AC5). */
export const GENERATE_COMPONENT_SYSTEM_PROMPT_FILE = "generate-component.system.md";

/** The system prompt for `refine` (M2-04 · DRO-251). Loaded + versioned by the
 * exact same machinery as the `conjure` prompt — `refine` logs its git blob hash
 * as `promptVersion` on every model call too. */
export const REFINE_COMPONENT_SYSTEM_PROMPT_FILE = "refine-component.system.md";

/** A loaded prompt: its text and the content-address logged as its version. */
export interface LoadedPrompt {
  /** The prompt's file name (e.g. `generate-component.system.md`). */
  file: string;
  /** Full markdown text of the prompt. */
  text: string;
  /**
   * The prompt's version — the git blob hash of {@link text}, identical to
   * `git hash-object <file>`. Logged as `promptVersion` on every model call
   * (AC5). Changes iff the prompt's bytes change.
   */
  version: string;
}

/**
 * The git blob object id of `content` — `sha1("blob " + byteLength + "\0" +
 * content)`, byte-for-byte what `git hash-object` computes. Exported for direct
 * testing against a known `git hash-object` value.
 */
export function gitBlobHash(content: string): string {
  const bytes = Buffer.from(content, "utf-8");
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf-8");
  return createHash("sha1")
    .update(Buffer.concat([header, bytes]))
    .digest("hex");
}

// Memoize by file name — each prompt is immutable for the process lifetime.
const cache = new Map<string, LoadedPrompt>();

/**
 * Load a prompt from `llm/prompts/<file>`, returning its text and version.
 * Memoized: the first call reads + hashes; subsequent calls return the cached
 * result. Throws if the file is missing (a packaging bug worth failing loudly on
 * — a prompt-less generation verb has nothing to send the model).
 */
export function loadPrompt(file: string): LoadedPrompt {
  const cached = cache.get(file);
  if (cached) return cached;

  const text = readFileSync(join(PROMPTS_DIR, file), "utf-8");
  const loaded: LoadedPrompt = { file, text, version: gitBlobHash(text) };
  cache.set(file, loaded);
  return loaded;
}

/** Convenience: load the `conjure` system prompt (AC5). */
export function loadGenerateComponentSystemPrompt(): LoadedPrompt {
  return loadPrompt(GENERATE_COMPONENT_SYSTEM_PROMPT_FILE);
}

/** Convenience: load the `refine` system prompt (M2-04 · DRO-251). */
export function loadRefineComponentSystemPrompt(): LoadedPrompt {
  return loadPrompt(REFINE_COMPONENT_SYSTEM_PROMPT_FILE);
}
