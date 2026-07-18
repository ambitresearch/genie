/**
 * Unit tests for the M2-09 cost-assert pricing table (`./pricing.ts`).
 *
 * Pure-function tests only — no network, no `GENIE_LLM_*` env. The real
 * dollars-and-cents behaviour (summed across a live 5-component + refine run)
 * is exercised by `test/m2-generation.test.ts` AC6; this file pins the
 * arithmetic and the fallback-pricing safety net in isolation.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL as CONJURE_DEFAULT_MODEL } from "../../server/src/tools/conjure.js";
import { DEFAULT_MODEL as REFINE_DEFAULT_MODEL } from "../../server/src/tools/refine.js";

import {
  DEFAULT_MODEL_ALIAS,
  FALLBACK_PRICING,
  PRICING_TABLE,
  estimateCostUsd,
} from "./pricing.js";

describe("PRICING_TABLE", () => {
  it("DEFAULT_MODEL_ALIAS matches conjure.ts/refine.ts DEFAULT_MODEL", () => {
    // pricing.ts's DEFAULT_MODEL_ALIAS is a re-declared literal, not an import
    // from @ambitresearch/genie (pricing.ts stays runtime-dependency-free — see its
    // module doc). That means nothing enforces the two stay in sync EXCEPT
    // this assertion: import the tools' real exported constants directly (by
    // relative source path, same as m2-generation.test.ts — both conjure.js
    // and refine.js only *type*-import the LLM client, so this has no eager
    // GENIE_LLM_* side effect) and pin equality. If a future change to either
    // tool's default model alias isn't mirrored here, this test — not just
    // the "has an entry" check below — fails.
    expect(DEFAULT_MODEL_ALIAS).toBe(CONJURE_DEFAULT_MODEL);
    expect(DEFAULT_MODEL_ALIAS).toBe(REFINE_DEFAULT_MODEL);
  });

  it("has an entry for every model alias conjure/refine accept by default", () => {
    // conjure.ts / refine.ts DEFAULT_MODEL — the alias AC3 requires the 5
    // components to be generated against. Pinned as a literal (not imported
    // from @ambitresearch/genie) so this table can't silently drift out of having an
    // entry for it without a test noticing.
    expect(PRICING_TABLE[DEFAULT_MODEL_ALIAS]).toBeDefined();
  });

  it("every entry has non-negative per-million rates", () => {
    for (const [alias, pricing] of Object.entries(PRICING_TABLE)) {
      expect(pricing.promptPerMillion, `${alias}.promptPerMillion`).toBeGreaterThanOrEqual(0);
      expect(pricing.completionPerMillion, `${alias}.completionPerMillion`).toBeGreaterThanOrEqual(
        0,
      );
    }
  });
});

describe("estimateCostUsd", () => {
  it("computes promptTokens/1e6 * promptPerMillion + completionTokens/1e6 * completionPerMillion", () => {
    const cost = estimateCostUsd("design-default", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    const pricing = PRICING_TABLE["design-default"]!;
    expect(cost).toBeCloseTo(pricing.promptPerMillion + pricing.completionPerMillion, 10);
  });

  it("zero tokens costs exactly $0 regardless of model", () => {
    expect(estimateCostUsd("design-default", { promptTokens: 0, completionTokens: 0 })).toBe(0);
    expect(estimateCostUsd("design-best", { promptTokens: 0, completionTokens: 0 })).toBe(0);
    expect(estimateCostUsd("totally-unknown-alias", { promptTokens: 0, completionTokens: 0 })).toBe(
      0,
    );
  });

  it("scales linearly with token count", () => {
    const one = estimateCostUsd("design-default", {
      promptTokens: 100_000,
      completionTokens: 50_000,
    });
    const doubled = estimateCostUsd("design-default", {
      promptTokens: 200_000,
      completionTokens: 100_000,
    });
    expect(doubled).toBeCloseTo(one * 2, 10);
  });

  it("design-local (offline Ollama) is priced at $0 — no per-token cost", () => {
    expect(
      estimateCostUsd("design-local", { promptTokens: 5_000_000, completionTokens: 5_000_000 }),
    ).toBe(0);
  });

  it("an unrecognized model alias falls back to FALLBACK_PRICING, never silently to $0", () => {
    // Safety-net requirement: AC6 is a budget CIRCUIT BREAKER. If a caller
    // passes a model this table has never heard of, under-pricing it (or
    // treating it as free) would let a genuinely expensive call slip past the
    // $5 guard undetected. The fallback must be at least as expensive as the
    // priciest known tier so it never UNDER-counts.
    const known = Object.values(PRICING_TABLE).map(
      (p) => p.promptPerMillion + p.completionPerMillion,
    );
    const fallbackTotal = FALLBACK_PRICING.promptPerMillion + FALLBACK_PRICING.completionPerMillion;
    expect(fallbackTotal).toBeGreaterThanOrEqual(Math.max(...known));

    const viaUnknown = estimateCostUsd("some-model-nobody-configured", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(viaUnknown).toBeCloseTo(fallbackTotal, 10);
  });
});
