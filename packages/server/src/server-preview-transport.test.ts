import { describe, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => ({
  registerPreviewTool: vi.fn(),
}));

vi.mock("./tools/preview.js", () => preview);

import { createServer } from "./server.js";

describe("createServer preview transport policy", () => {
  it("threads an embedded HTTP transport kind into preview registration", () => {
    createServer({ transportKind: "http", previewLocality: "local" });

    expect(preview.registerPreviewTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transportKind: "http", locality: "local" }),
    );
  });
});
