/**
 * Pricing table for the M2-09 cost-assert (DRO-256 AC6).
 *
 * `packages/e2e/test/m2-generation.test.ts` sums `promptTokens +
 * completionTokens` across every `conjure`/`refine` call it makes in one run
 * and fails the run if the total cost would exceed a 5 USD budget cap (AC6).
 * This module owns the USD-per-token rates that arithmetic needs.
 *
 * ── Why hand-maintained, not fetched from the gateway ────────────────────────
 * LiteLLM (the reference gateway, M2-05 / DRO-252) does expose per-request
 * cost via `response._hidden_params.response_cost` on some deployments, but
 * that is a LiteLLM-specific field — genie's own contract (D-H) is "any
 * OpenAI-compatible endpoint", and a raw OpenAI/Ollama passthrough will not
 * set it. A static table keyed by genie's own model *aliases* (not raw
 * provider model ids) is the one thing guaranteed to exist for every
 * deployment this test can run against, at the cost of the operator having to
 * keep it current — an explicit, documented tradeoff, not an oversight.
 *
 * ── Rates (checked against public list pricing, 2026-07-03) ──────────────────
 * The three aliases `conjure`/`refine` resolve by default (M2-05 / DRO-252,
 * `deploy/litellm/config.yaml`):
 *   - design-default → Sonnet-class hosted model
 *   - design-best    → Opus-class hosted model (pricier, higher quality)
 *   - design-local   → operator's own Ollama install — $0/token by definition
 * Sonnet/Opus list rates move between point releases; this table intentionally
 * prices toward the CURRENT (checked-date) public list rate for each tier
 * rather than any specific dated snapshot, so a minor point-release rename
 * doesn't quietly stop tracking reality. Re-verify against your own gateway's
 * billing docs before relying on this for real spend accounting — it exists to
 * make the $5 e2e guard (AC6) meaningful, not to be genie's production billing
 * source of truth (that's `llm_cost_usd_total`, RFC §12.1 #9, computed from the
 * endpoint's own usage data where available).
 */

/** USD rate per 1,000,000 tokens, split prompt vs completion (providers price
 * these two directions differently — completion tokens typically cost more). */
export interface ModelPricing {
  promptPerMillion: number;
  completionPerMillion: number;
}

/** The model alias `conjure`/`refine` default to (`DEFAULT_MODEL` in both
 * tools) — re-declared as a literal here (not imported from `@genie/server`)
 * so this pricing module has zero RUNTIME dependency on the server package.
 * `pricing.test.ts` closes the drift gap that zero-runtime-dependency choice
 * opens: it imports `conjure.ts`/`refine.ts`'s actual `DEFAULT_MODEL` exports
 * (a type-checked, test-time-only import) and asserts both equal this literal
 * — so a future change to either tool's default that isn't mirrored here
 * fails that test, not silently. */
export const DEFAULT_MODEL_ALIAS = "design-default";

/**
 * Per-alias USD/million-token rates. Keyed by genie's OWN model aliases
 * (`design-default` / `design-best` / `design-local`), matching what
 * `conjure`/`refine`'s `model` field actually carries — never a raw provider
 * model id, which varies per deployment (M2-05 §"Model alias resolution").
 */
export const PRICING_TABLE: Record<string, ModelPricing> = {
  // Sonnet-class — conjure/refine's default (checked 2026-07-03: current
  // Sonnet-tier list pricing, USD per million tokens).
  "design-default": { promptPerMillion: 3, completionPerMillion: 15 },
  // Opus-class — slower, higher quality, priced well above Sonnet-tier.
  "design-best": { promptPerMillion: 15, completionPerMillion: 75 },
  // Operator's own local/offline Ollama install (deploy/litellm/config.yaml:
  // `ollama_chat/qwen3-coder:30b`) — no per-token cost by definition.
  "design-local": { promptPerMillion: 0, completionPerMillion: 0 },
};

/**
 * Priced at/above the most expensive KNOWN tier (`design-best`) so an alias
 * this table has never heard of can never silently UNDER-count against the $5
 * cap (AC6 is a circuit breaker — the safe failure mode is "over-estimate and
 * trip early", never "under-estimate and miss a runaway spend"). Exported so
 * `pricing.test.ts` can assert the safety invariant directly instead of
 * re-deriving it.
 */
export const FALLBACK_PRICING: ModelPricing = PRICING_TABLE["design-best"]!;

/**
 * USD cost of one completion's token usage against `model`'s rate (AC6's
 * `promptTokens + completionTokens * pricing` aggregation, computed per-call
 * and summed by the caller across the run). Falls back to
 * {@link FALLBACK_PRICING} — never `$0` — for a model alias not in
 * {@link PRICING_TABLE}, so a typo'd or newly-added alias fails the budget
 * guard loudly (a spuriously-tripped $5 cap) rather than silently passing an
 * unpriced, potentially-expensive call through as free.
 */
export function estimateCostUsd(
  model: string,
  usage: { promptTokens: number; completionTokens: number },
): number {
  const pricing = PRICING_TABLE[model] ?? FALLBACK_PRICING;
  return (
    (usage.promptTokens / 1_000_000) * pricing.promptPerMillion +
    (usage.completionTokens / 1_000_000) * pricing.completionPerMillion
  );
}
