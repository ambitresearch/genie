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

// #257 — `conjure`/`refine` receive a NON-starting accessor. Capturing what they
// were handed is the only way to observe it, so intercept just the registrar and
// leave the rest of each module intact.
const conjure = vi.hoisted(() => ({ registerConjureTool: vi.fn() }));
const refine = vi.hoisted(() => ({ registerRefineTool: vi.fn() }));

vi.mock("./tools/preview.js", () => preview);
vi.mock("./ui/grid-resource.js", () => grid);
vi.mock("./tools/conjure.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools/conjure.js")>()),
  registerConjureTool: conjure.registerConjureTool,
}));
vi.mock("./tools/refine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools/refine.js")>()),
  registerRefineTool: refine.registerRefineTool,
}));
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

  // #257 — generation must not acquire a listening socket (AC9). `conjure`/`refine`
  // get a NON-starting accessor: undefined until the viewer's own broker is up, and
  // the broker instance once it is. Calling the starting provider from `conjure`
  // would bind a loopback port as a side effect of a verb documented as pure.
  it("hands conjure and refine a broker accessor that cannot start the broker", async () => {
    createServer({ transportKind: "stdio" });

    const conjureDeps = conjure.registerConjureTool.mock.calls[0]?.[1] as {
      getRunningCardAssetBroker?: () => typeof cardAssets.instance | undefined;
    };
    const refineDeps = refine.registerRefineTool.mock.calls[0]?.[1] as {
      getRunningCardAssetBroker?: () => typeof cardAssets.instance | undefined;
    };
    expect(conjureDeps.getRunningCardAssetBroker).toBeTypeOf("function");
    expect(refineDeps.getRunningCardAssetBroker).toBeTypeOf("function");

    // Reading it is inert: no port is bound, and the caller simply sees "no broker".
    expect(conjureDeps.getRunningCardAssetBroker!()).toBeUndefined();
    expect(refineDeps.getRunningCardAssetBroker!()).toBeUndefined();
    expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();

    // The viewer path starts it; only then does the accessor see an instance.
    const gridOptions = grid.registerGridResource.mock.calls[0]?.[1] as {
      getCardAssetBroker?: () => Promise<typeof cardAssets.instance>;
    };
    await gridOptions.getCardAssetBroker!();

    expect(conjureDeps.getRunningCardAssetBroker!()).toBe(cardAssets.instance);
    expect(refineDeps.getRunningCardAssetBroker!()).toBe(cardAssets.instance);
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
    const previewBooter = vi.fn();

    createServer({ previewBooter });

    expect(preview.registerPreviewTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ booter: previewBooter }),
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

  // #257 is delivered for the local stdio tier only, and this pins that boundary so
  // it stays a decision rather than drift. Where no loopback broker is created, the
  // accessor `conjure`/`refine` hold must stay permanently empty: they then publish no
  // draft, emit no `previewUrl`, and the viewer keeps its inline `srcdoc` preview. A
  // loopback URL would be worse than nothing here — it names a port on the SERVER host,
  // which the user's browser cannot reach.
  it.each([
    ["an HTTP transport", { transportKind: "http" as const }, undefined],
    [
      "an explicitly remote locality",
      { transportKind: "stdio" as const, previewLocality: "remote" as const },
      undefined,
    ],
    ["a configured previews base URL", { transportKind: "stdio" as const }, "https://cdn.test"],
  ])(
    "leaves the draft-publishing accessor permanently empty for %s",
    async (_label, options, baseUrl) => {
      if (baseUrl !== undefined) vi.stubEnv("GENIE_PREVIEWS_BASE_URL", baseUrl);
      try {
        const server = createServer(options);
        const conjureDeps = conjure.registerConjureTool.mock.calls[0]?.[1] as {
          getRunningCardAssetBroker?: () => typeof cardAssets.instance | undefined;
        };
        const refineDeps = refine.registerRefineTool.mock.calls[0]?.[1] as {
          getRunningCardAssetBroker?: () => typeof cardAssets.instance | undefined;
        };

        // The accessor still exists, so the verbs need no transport-aware branch...
        expect(conjureDeps.getRunningCardAssetBroker).toBeTypeOf("function");
        expect(refineDeps.getRunningCardAssetBroker).toBeTypeOf("function");
        // ...and nothing can ever fill it, because no starting provider was handed out.
        expect(
          (grid.registerGridResource.mock.calls[0]?.[1] as { getCardAssetBroker?: unknown })
            .getCardAssetBroker,
        ).toBeUndefined();

        const client = new Client({ name: "narrowed", version: "0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        await client.listTools();
        await client.close();

        expect(conjureDeps.getRunningCardAssetBroker!()).toBeUndefined();
        expect(refineDeps.getRunningCardAssetBroker!()).toBeUndefined();
        expect(cardAssets.startCardAssetBroker).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

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
