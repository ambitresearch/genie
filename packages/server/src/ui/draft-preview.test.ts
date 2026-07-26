import { describe, expect, it, vi } from "vitest";

import { publishDraftPreview } from "./draft-preview.js";
import type { CardAssetBroker, CardAssetDraft } from "./card-asset-broker.js";

function draftStub(url: string, expired: readonly string[] = []): CardAssetDraft {
  return Object.freeze({
    token: "t".repeat(32),
    hostname: "127.0.0.1",
    authority: "127.0.0.1:4173",
    origin: "http://127.0.0.1:4173",
    url,
    expired: Object.freeze([...expired]),
  });
}

function brokerStub(
  url = "http://127.0.0.1:4173/d/abc",
  expired: readonly string[] = [],
): {
  broker: CardAssetBroker;
  registerDraft: ReturnType<typeof vi.fn>;
} {
  const registerDraft = vi.fn(() => draftStub(url, expired));
  return { broker: { registerDraft } as unknown as CardAssetBroker, registerDraft };
}

const IDENTITY = { componentName: "Button", group: "inputs" };

const CARD = "<!doctype html><style>.a{color:red}</style><p>card</p>";

function files(overrides: { path: string; content: string }[] = []): {
  path: string;
  content: string;
}[] {
  return [
    { path: "components/inputs/Button/Button.html", content: CARD },
    { path: "components/inputs/Button/Button.css", content: ".a{}" },
    ...overrides,
  ];
}

describe("publishDraftPreview", () => {
  it("publishes the component's own <Name>.html and returns its URL", () => {
    const { broker, registerDraft } = brokerStub("http://127.0.0.1:4173/d/deadbeef");

    const { url } = publishDraftPreview(broker, files(), IDENTITY);

    expect(url).toBe("http://127.0.0.1:4173/d/deadbeef");
    expect(registerDraft).toHaveBeenCalledExactlyOnceWith(CARD);
  });

  it("returns undefined without a broker so non-local transports are unaffected", () => {
    // Remote/HTTP hosts never get a loopback broker; the viewer must fall back
    // to `srcdoc` rather than pointing a frame at an origin that does not exist.
    expect(publishDraftPreview(undefined, files(), IDENTITY).url).toBeUndefined();
  });

  it("ignores non-preview HTML that merely sits in the component directory", () => {
    // `dark-mode.html` is a legal generated file but is not the card; publishing
    // it would preview the wrong document.
    const { broker, registerDraft } = brokerStub();
    const withDecoy = [
      { path: "components/inputs/Button/dark-mode.html", content: "<p>decoy</p>" },
      ...files(),
    ];

    publishDraftPreview(broker, withDecoy, IDENTITY);

    expect(registerDraft).toHaveBeenCalledExactlyOnceWith(CARD);
  });

  it("ignores a canonical-looking card belonging to a different component", () => {
    // `NAMED_HTML_PATH` only says "some component's card", so the first match wins. A generation
    // that emits `components/other/Decoy/Decoy.html` ahead of its own card would publish the
    // decoy, while the viewer's own `findPreviewFile` still shows the real one — the reviewer
    // approves bytes the preview never rendered.
    const { broker, registerDraft } = brokerStub();
    const withDecoy = [
      { path: "components/other/Decoy/Decoy.html", content: "<p>decoy</p>" },
      ...files(),
    ];

    publishDraftPreview(broker, withDecoy, { componentName: "Button", group: "inputs" });

    expect(registerDraft).toHaveBeenCalledExactlyOnceWith(CARD);
  });

  it("returns undefined when the identity names no file in the result", () => {
    const { broker, registerDraft } = brokerStub();

    expect(
      publishDraftPreview(broker, files(), { componentName: "Missing", group: "inputs" }).url,
    ).toBeUndefined();
    expect(registerDraft).not.toHaveBeenCalled();
  });

  it("refuses an identity whose path is legal for a file but not for a card", () => {
    // `schema.ts`'s `PATH_PATTERN` leaves the `<Name>` directory segment UNBOUNDED
    // (`[A-Z][A-Za-z0-9]+`) while `NAMED_HTML_PATH` caps it at 64 characters, so a 65-character
    // name yields a `files[].path` the file schema accepts and the card predicate rejects.
    // Re-checking the constructed path keeps that divergence from deciding what gets published,
    // rather than trusting an identity the signature cannot constrain.
    const { broker, registerDraft } = brokerStub();
    const long = `A${"b".repeat(64)}`;
    expect(long).toHaveLength(65);
    const oversized = [
      { path: `components/inputs/${long}/${long}.html`, content: "<p>oversized</p>" },
    ];

    expect(
      publishDraftPreview(broker, oversized, { componentName: long, group: "inputs" }).url,
    ).toBeUndefined();
    expect(registerDraft).not.toHaveBeenCalled();
  });

  it("returns undefined when no card file is present instead of throwing", () => {
    const { broker, registerDraft } = brokerStub();

    expect(
      publishDraftPreview(broker, [{ path: "components/a/B/B.css", content: "x" }], {
        componentName: "B",
        group: "a",
      }).url,
    ).toBe(undefined);
    expect(registerDraft).not.toHaveBeenCalled();
  });

  it("never fails a completed generation because publishing failed", () => {
    // The component was generated successfully; a broker problem must degrade to
    // the `srcdoc` path, not turn a good result into a tool error.
    const broker = {
      registerDraft: vi.fn(() => {
        throw new Error("Card asset broker is closed.");
      }),
    } as unknown as CardAssetBroker;

    expect(publishDraftPreview(broker, files(), IDENTITY).url).toBeUndefined();
  });

  it("skips base64 files so binary content is never decoded as markup", () => {
    const { broker, registerDraft } = brokerStub();
    const encoded = [
      { path: "components/inputs/Button/Button.html", content: "AAAA", encoding: "base64" },
    ];

    expect(publishDraftPreview(broker, encoded, IDENTITY).url).toBeUndefined();
    expect(registerDraft).not.toHaveBeenCalled();
  });

  it("forwards the broker's eviction list so the viewer can retire dead previews (#257)", () => {
    // The real broker names what it dropped in `expired`; publishing must pass that
    // through verbatim, or the viewer keeps fetching evicted drafts that 404. A stub
    // that omits `expired` makes this read `undefined` — the exact shape lie #257 fixes.
    const dead = `http://127.0.0.1:4173/d/${"a".repeat(32)}`;
    const { broker } = brokerStub("http://127.0.0.1:4173/d/deadbeef", [dead]);

    expect(publishDraftPreview(broker, files(), IDENTITY).expired).toEqual([dead]);
  });

  it("reports a frozen empty eviction list, never undefined, when nothing was dropped (#257)", () => {
    // `PublishedDraftPreview.expired` is a required frozen array and the real broker
    // always supplies one; the fixture must too, so a future stub that drops it fails here.
    const { broker } = brokerStub();
    const { expired } = publishDraftPreview(broker, files(), IDENTITY);
    expect(expired).toEqual([]);
    expect(Object.isFrozen(expired)).toBe(true);
  });
});
