/**
 * `HtmlAdapter` (M2-08 · DRO-255 · AC3) — a **stub**. Constructs fine and exposes
 * its identity + default viewport (so `conjure`'s adapter selection never breaks
 * for `framework: "html"`), but every codegen method throws a structured
 * {@link NotYetImplementedError} pointing at the v2 tracking issue.
 *
 * Full vanilla-HTML codegen is explicitly out of scope for M2-08 (issue "Out of
 * Scope": "Full Vue / HTML implementations (v2)"). Implementing this adapter is
 * tracked separately — see {@link HTML_TRACKING_ISSUE}.
 */
import {
  NotYetImplementedError,
  type AdapterFile,
  type FrameworkAdapter,
  type Framework,
  type RenderInput,
  type Viewport,
} from "./interface.js";

/** v2 tracking issue for implementing the vanilla-HTML adapter (AC3). */
export const HTML_TRACKING_ISSUE = "https://github.com/roshangautam/genie/issues/130";

export class HtmlAdapter implements FrameworkAdapter {
  readonly framework: Framework = "html";
  readonly defaultViewport: Viewport = { width: 400, height: 300 };

  /**
   * Metadata (not codegen), so it is available even though HTML codegen is
   * stubbed: `conjure` (pure LLM generation) can still target vanilla HTML by
   * naming the framework and its source shape in the prompt.
   */
  readonly promptDirective: string = [
    "Target framework: html",
    "Emit a self-contained vanilla HTML component: semantic markup with inline " +
      "<style>, and vanilla JS in a <script> only if interactivity is required.",
  ].join("\n");

  renderSource(_input: RenderInput): AdapterFile {
    throw new NotYetImplementedError("html", HTML_TRACKING_ISSUE);
  }

  renderPreview(_input: RenderInput): Promise<AdapterFile> {
    // Reject (not throw synchronously) so callers `await`ing the Promise see the
    // same structured error whether they call this or a sync method.
    return Promise.reject(new NotYetImplementedError("html", HTML_TRACKING_ISSUE));
  }

  extractDts(_input: RenderInput): Promise<AdapterFile> {
    return Promise.reject(new NotYetImplementedError("html", HTML_TRACKING_ISSUE));
  }
}
