import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => ({
  UI_EXTENSION_ID: "io.modelcontextprotocol/ui",
  MCP_APP_MIME: "text/html;profile=mcp-app",
  closeAll: vi.fn(),
  registerPreviewTool: vi.fn(() => ({ closeAll: preview.closeAll })),
}));

vi.mock("./tools/preview.js", () => preview);

import { createServer } from "./server.js";

describe("createServer preview transport policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("threads an embedded HTTP transport kind into preview registration", () => {
    createServer({ transportKind: "http", previewLocality: "local" });

    expect(preview.registerPreviewTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transportKind: "http", locality: "local" }),
    );
    expect(preview.closeAll).not.toHaveBeenCalled();
  });

  it("drains the preview registry when a directly connected transport closes", async () => {
    const server = createServer({ transportKind: "stdio" });
    const client = new Client({ name: "direct-client", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.close();

    await vi.waitFor(() => expect(preview.closeAll).toHaveBeenCalledOnce());
  });
});
