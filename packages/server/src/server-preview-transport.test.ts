import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => ({
  UI_EXTENSION_ID: "io.modelcontextprotocol/ui",
  MCP_APP_MIME: "text/html;profile=mcp-app",
  closeAll: vi.fn(),
  registerPreviewTool: vi.fn((_server: unknown, _options: unknown) => ({
    closeAll: preview.closeAll,
  })),
}));

const grid = vi.hoisted(() => ({
  registerGridResource: vi.fn((_server: unknown, _options: unknown) => {}),
  normalizePreviewsBaseUrl: vi.fn((raw: string | undefined) => {
    if (raw === undefined || raw.trim() === "") return undefined;
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
    } catch {
      return undefined;
    }
  }),
}));

const cardAssets = vi.hoisted(() => {
  const instance = {
    address: "127.0.0.1" as const,
    port: 57321,
    registerKit: vi.fn(),
    getKit: vi.fn(),
    frameOrigins: vi.fn(() => []),
    close: vi.fn(async () => {}),
  };
  return {
    instance,
    startCardAssetBroker: vi.fn(async () => instance),
  };
});

const lifecycle = vi.hoisted(() => ({
  disposerResults: [] as Promise<PromiseSettledResult<void>>[],
}));

vi.mock("./tools/preview.js", () => preview);
vi.mock("./ui/grid-resource.js", () => grid);
vi.mock("./ui/card-asset-broker.js", () => ({
  startCardAssetBroker: cardAssets.startCardAssetBroker,
}));
vi.mock("./transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport.js")>();
  return {
    ...actual,
    registerServerDisposer: (
      server: Parameters<typeof actual.registerServerDisposer>[0],
      disposer: Parameters<typeof actual.registerServerDisposer>[1],
    ): void => {
      actual.registerServerDisposer(server, () => {
        const result = Promise.resolve().then(disposer);
        lifecycle.disposerResults.push(
          result.then(
            () => ({ status: "fulfilled", value: undefined }),
            (reason: unknown) => ({ status: "rejected", reason }),
          ),
        );
        return result;
      });
    },
  };
});

import { createServer } from "./server.js";
import { startTransport } from "./transport.js";

describe("createServer preview transport policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.disposerResults.length = 0;
  });

  it("threads an embedded HTTP transport kind into preview registration", () => {
    createServer({ transportKind: "http", previewLocality: "local" });

    expect(preview.registerPreviewTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transportKind: "http", locality: "local" }),
    );
    const previewOptions = preview.registerPreviewTool.mock.calls[0]?.[1] as {
      getCardAssetBroker?: unknown;
    };
    const gridOptions = grid.registerGridResource.mock.calls[0]?.[1] as {
      getCardAssetBroker?: unknown;
    };
    expect(previewOptions.getCardAssetBroker).toBeUndefined();
    expect(gridOptions.getCardAssetBroker).toBeUndefined();
    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();
    expect(preview.closeAll).not.toHaveBeenCalled();
  });

  it("threads an injected viewer booter into preview registration", () => {
    const viewerBooter = vi.fn();

    createServer({ viewerBooter });

    expect(preview.registerPreviewTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ booter: viewerBooter }),
    );
  });

  it("shares one lazily started card broker across preview and grid registration", async () => {
    const server = createServer({ transportKind: "stdio" });
    const previewOptions = preview.registerPreviewTool.mock.calls[0]?.[1] as {
      getCardAssetBroker?: () => Promise<typeof cardAssets.instance>;
    };
    const gridOptions = grid.registerGridResource.mock.calls[0]?.[1] as {
      getCardAssetBroker?: () => Promise<typeof cardAssets.instance>;
    };

    expect(previewOptions.getCardAssetBroker).toBeTypeOf("function");
    expect(gridOptions.getCardAssetBroker).toBe(previewOptions.getCardAssetBroker);
    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();

    const [fromPreview, fromGrid] = await Promise.all([
      previewOptions.getCardAssetBroker!(),
      gridOptions.getCardAssetBroker!(),
    ]);
    expect(fromPreview).toBe(cardAssets.instance);
    expect(fromGrid).toBe(cardAssets.instance);
    expect(cardAssets.startCardAssetBroker).toHaveBeenCalledOnce();

    const client = new Client({ name: "direct-client", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.close();

    await vi.waitFor(() => expect(cardAssets.instance.close).toHaveBeenCalledOnce());
  });

  it("does not start the card broker for a tools-only client", async () => {
    const server = createServer({ transportKind: "stdio" });
    const client = new Client({ name: "tools-only", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.listTools();
    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();

    await client.close();
    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();
    expect(cardAssets.instance.close).not.toHaveBeenCalled();
  });

  it("does not create or expose a loopback broker provider for remote deployments", async () => {
    const server = createServer({ transportKind: "http", previewLocality: "remote" });
    const previewOptions = preview.registerPreviewTool.mock.calls[0]?.[1] as {
      getCardAssetBroker?: unknown;
    };
    const gridOptions = grid.registerGridResource.mock.calls[0]?.[1] as {
      getCardAssetBroker?: unknown;
    };

    expect(previewOptions.getCardAssetBroker).toBeUndefined();
    expect(gridOptions.getCardAssetBroker).toBeUndefined();
    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();

    const client = new Client({ name: "direct-client", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.close();

    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();
    expect(cardAssets.instance.close).not.toHaveBeenCalled();
  });

  it("omits the broker provider when a stdio embedder explicitly declares remote locality", () => {
    createServer({ transportKind: "stdio", previewLocality: "remote" });

    expect(
      (preview.registerPreviewTool.mock.calls[0]?.[1] as { getCardAssetBroker?: unknown })
        .getCardAssetBroker,
    ).toBeUndefined();
    expect(
      (grid.registerGridResource.mock.calls[0]?.[1] as { getCardAssetBroker?: unknown })
        .getCardAssetBroker,
    ).toBeUndefined();
    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();
  });

  it("resolves an omitted transport at startup before lazily starting the broker", async () => {
    const server = createServer();
    const previewOptions = preview.registerPreviewTool.mock.calls[0]?.[1] as {
      locality?: "local" | "remote";
      getCardAssetBroker?: () => Promise<typeof cardAssets.instance>;
    };
    const gridOptions = grid.registerGridResource.mock.calls[0]?.[1] as {
      getCardAssetBroker?: () => Promise<typeof cardAssets.instance>;
    };

    expect(preview.registerPreviewTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transportKind: undefined, locality: undefined }),
    );
    expect(previewOptions.getCardAssetBroker).toBeTypeOf("function");
    expect(gridOptions.getCardAssetBroker).toBe(previewOptions.getCardAssetBroker);

    await expect(previewOptions.getCardAssetBroker!()).rejects.toThrow(/local stdio/i);
    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();

    await startTransport(server, {
      kind: "stdio",
      stdioInput: new PassThrough(),
      stdioOutput: new PassThrough(),
    });

    await expect(previewOptions.getCardAssetBroker!()).resolves.toBe(cardAssets.instance);
    expect(cardAssets.startCardAssetBroker).toHaveBeenCalledOnce();
    await server.close();
  });

  it("retries broker startup after a shared rejected attempt", async () => {
    const startupFailure = new Error("temporary bind failure");
    cardAssets.startCardAssetBroker.mockRejectedValueOnce(startupFailure);
    const server = createServer({ transportKind: "stdio" });
    const getCardAssetBroker = (
      preview.registerPreviewTool.mock.calls[0]?.[1] as {
        getCardAssetBroker?: () => Promise<typeof cardAssets.instance>;
      }
    ).getCardAssetBroker!;

    const firstAttempt = await Promise.allSettled([getCardAssetBroker(), getCardAssetBroker()]);
    expect(firstAttempt).toEqual([
      { status: "rejected", reason: startupFailure },
      { status: "rejected", reason: startupFailure },
    ]);
    expect(cardAssets.startCardAssetBroker).toHaveBeenCalledOnce();

    await expect(getCardAssetBroker()).resolves.toBe(cardAssets.instance);
    expect(cardAssets.startCardAssetBroker).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("settles broker disposal when startup rejects during shutdown", async () => {
    const startupFailure = new Error("bind failed during shutdown");
    let rejectStartup: (reason: unknown) => void = () => {};
    cardAssets.startCardAssetBroker.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectStartup = reject;
      }),
    );
    const server = createServer({ transportKind: "stdio" });
    const getCardAssetBroker = (
      preview.registerPreviewTool.mock.calls[0]?.[1] as {
        getCardAssetBroker?: () => Promise<typeof cardAssets.instance>;
      }
    ).getCardAssetBroker!;
    const brokerRequest = getCardAssetBroker();
    const client = new Client({ name: "shutdown-client", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.close();
    await vi.waitFor(() => expect(lifecycle.disposerResults).toHaveLength(2));
    rejectStartup(startupFailure);

    await expect(brokerRequest).rejects.toBe(startupFailure);
    await expect(lifecycle.disposerResults[0]).resolves.toEqual({
      status: "fulfilled",
      value: undefined,
    });
    expect(cardAssets.instance.close).not.toHaveBeenCalled();
  });

  it("rejects delayed broker acquisition after transport shutdown", async () => {
    const server = createServer({ transportKind: "stdio" });
    const getCardAssetBroker = (
      preview.registerPreviewTool.mock.calls[0]?.[1] as {
        getCardAssetBroker?: () => Promise<typeof cardAssets.instance>;
      }
    ).getCardAssetBroker!;
    const client = new Client({ name: "delayed-preview-client", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.close();
    await vi.waitFor(() => expect(lifecycle.disposerResults).toHaveLength(2));
    await Promise.all(lifecycle.disposerResults);

    await expect(getCardAssetBroker()).rejects.toThrow(/disposed/i);
    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();
    expect(cardAssets.instance.close).not.toHaveBeenCalled();
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
