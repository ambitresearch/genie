import { NAMED_HTML_PATH } from "../llm/validate.js";
import type { CardAssetBroker } from "./card-asset-broker.js";

/** Which component's card to publish, as reported by the generation itself. */
interface DraftIdentity {
  componentName: string;
  group: string;
}

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
  identity: DraftIdentity,
): string | undefined {
  if (broker === undefined) return undefined;

  // Scoped to THIS component, not to "some component's card". `NAMED_HTML_PATH`
  // only describes the canonical shape, so a result carrying
  // `components/other/Decoy/Decoy.html` ahead of its own card would publish the
  // decoy while the viewer still renders the real one — the reviewer would
  // approve bytes the preview never showed. Building the path from the identity
  // the generation already reported makes the choice unambiguous, and testing it
  // against `NAMED_HTML_PATH` keeps a malformed name or group from forming a path
  // at all rather than pasting it in unchecked. Sibling HTML such as
  // `dark-mode.html` is legal but is not the preview.
  const expected = `components/${identity.group}/${identity.componentName}/${identity.componentName}.html`;
  if (!NAMED_HTML_PATH.test(expected)) return undefined;
  const card = files.find(
    (file) => file.path === expected && (file.encoding ?? "utf-8") === "utf-8",
  );
  if (card === undefined) return undefined;

  try {
    return broker.registerDraft(card.content).url;
  } catch {
    return undefined;
  }
}
