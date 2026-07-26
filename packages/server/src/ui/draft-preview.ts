import { NAMED_HTML_PATH } from "../llm/validate.js";
import type { CardAssetBroker } from "./card-asset-broker.js";

/** The minimum a generated/refined file must expose to be previewable. */
interface PreviewableFile {
  path: string;
  content: string;
  encoding?: string;
}

/**
 * Publish an unwritten draft's card as its own document and return its URL (#257).
 *
 * A draft rendered through `<iframe srcdoc>` inherits the embedder's CSP, whose
 * `style-src` hash allow-list was computed from files already in the kit — so a
 * draft's own inline `<style>` can never be in it and the reviewer approves a
 * component they never actually saw styled. Serving the draft from the card
 * asset broker gives it a real response policy derived from its own bytes, on
 * the origin the host already authorizes for kit cards.
 *
 * Publishing is best-effort by design: it is a fidelity improvement layered on a
 * generation that already succeeded, so every failure path returns `undefined`
 * and leaves the caller on the `srcdoc` fallback.
 */
export function publishDraftPreview(
  broker: CardAssetBroker | undefined,
  files: readonly PreviewableFile[],
): string | undefined {
  if (broker === undefined) return undefined;

  // `NAMED_HTML_PATH` is the same predicate generation validates against, so the
  // card is identified exactly once in the codebase. Sibling HTML such as
  // `dark-mode.html` is legal but is not the preview.
  const card = files.find(
    (file) => NAMED_HTML_PATH.test(file.path) && (file.encoding ?? "utf-8") === "utf-8",
  );
  if (card === undefined) return undefined;

  try {
    return broker.registerDraft(card.content).url;
  } catch {
    return undefined;
  }
}
