import type { ValidatedComponent } from "./schema.js";
import { isTextMime, isValidBase64Content, resolveMime } from "../store/kit-files.js";

export type GeneratedFileWithEncoding = ValidatedComponent["files"][number] & {
  /** Encoding required when forwarding `content` to write_files as inline data. */
  encoding: "utf-8" | "base64";
};

/** Normalize model-supplied MIME/encoding from the path used by the kit store. */
export function normalizeGeneratedFiles(
  files: ValidatedComponent["files"],
): GeneratedFileWithEncoding[] {
  return files.map((file) => {
    const mimeType = resolveMime(file.path);
    return {
      ...file,
      mimeType,
      encoding: isTextMime(mimeType) ? "utf-8" : "base64",
    };
  });
}

/** Reject binary generated files whose content cannot be safely decoded. */
export function validateGeneratedBinaryContent(
  component: ValidatedComponent,
  ignoredPaths: ReadonlySet<string> = new Set(),
): string | undefined {
  for (const [index, file] of component.files.entries()) {
    if (ignoredPaths.has(file.path)) continue;
    const mimeType = resolveMime(file.path);
    if (!isTextMime(mimeType) && !isValidBase64Content(file.content)) {
      return (
        `- /files/${index}/content must be valid base64 for binary file ` +
        `"${file.path}" (${mimeType}).`
      );
    }
  }
  return undefined;
}
