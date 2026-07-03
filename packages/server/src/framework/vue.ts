/**
 * `VueAdapter` (M2-08 · DRO-255 · AC3) — a **stub**. Constructs fine and exposes
 * its identity + default viewport (so `conjure`'s adapter selection never breaks
 * for `framework: "vue"`), but every codegen method throws a structured
 * {@link NotYetImplementedError} pointing at the v2 tracking issue.
 *
 * Full Vue codegen is explicitly out of scope for M2-08 (issue "Out of Scope":
 * "Full Vue / HTML implementations (v2)"). Implementing this adapter is tracked
 * separately — see {@link VUE_TRACKING_ISSUE}.
 */
import {
  NotYetImplementedError,
  type AdapterFile,
  type FrameworkAdapter,
  type Framework,
  type RenderInput,
  type Viewport,
} from "./interface.js";

/** v2 tracking issue for implementing the Vue adapter (AC3). */
export const VUE_TRACKING_ISSUE = "https://github.com/roshangautam/genie/issues/129";

export class VueAdapter implements FrameworkAdapter {
  readonly framework: Framework = "vue";
  readonly defaultViewport: Viewport = { width: 400, height: 300 };

  /**
   * Metadata (not codegen), so it is available even though Vue codegen is
   * stubbed: `conjure` (pure LLM generation) can still target Vue by naming the
   * framework and its source shape in the prompt.
   */
  readonly promptDirective: string = [
    "Target framework: vue",
    'Emit an idiomatic Vue 3 Single File Component (.vue) using <script setup lang="ts">, ' +
      "typing props with defineProps.",
  ].join("\n");

  renderSource(_input: RenderInput): AdapterFile {
    throw new NotYetImplementedError("vue", VUE_TRACKING_ISSUE);
  }

  renderPreview(_input: RenderInput): Promise<AdapterFile> {
    // Reject (not throw synchronously) so callers `await`ing the Promise see the
    // same structured error whether they call this or a sync method.
    return Promise.reject(new NotYetImplementedError("vue", VUE_TRACKING_ISSUE));
  }

  extractDts(_input: RenderInput): Promise<AdapterFile> {
    return Promise.reject(new NotYetImplementedError("vue", VUE_TRACKING_ISSUE));
  }
}
