import { describe, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => ({
  UI_EXTENSION_ID: "io.modelcontextprotocol/ui",
  MCP_APP_MIME: "text/html;profile=mcp-app",
  closeAll: vi.fn(),
  registerPreviewTool: vi.fn(() => ({ closeAll: preview.closeAll })),
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
    expect(preview.closeAll).not.toHaveBeenCalled();
  });
});
