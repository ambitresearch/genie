#!/usr/bin/env node
/**
 * Postbuild integration gate for the packaged MCP App shell.
 *
 * Blocks `@ambitresearch/genie-viewer` package resolution, loads the compiled server, and
 * reads the bare grid resource through a real in-memory MCP client. The build
 * fails unless copied `dist/ui/viewer-static` assets supply the executable
 * initialize/tool-result bridge without the optional viewer package.
 */
import Module from "node:module";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const originalResolveFilename = Module._resolveFilename;
let viewerResolutionAttempted = false;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "@ambitresearch/genie-viewer/package.json") {
    viewerResolutionAttempted = true;
    const error = new Error("blocked optional @ambitresearch/genie-viewer resolution");
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

let client;
try {
  const { createServer } = await import("../dist/server.js");
  const server = createServer({ transportKind: "stdio" });
  client = new Client({ name: "packaged-viewer-check", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listResources();
  const grid = listed.resources.find((resource) => resource.uri.startsWith("ui://genie/grid?"));
  if (grid === undefined) {
    throw new Error("packaged server did not advertise the MCP App grid resource");
  }
  const gridUri = new URL(grid.uri);
  if (
    gridUri.searchParams.get("v") !== "2" ||
    !/^[a-f0-9]{32}$/.test(gridUri.searchParams.get("instance") ?? "")
  ) {
    throw new Error("packaged grid resource is missing its process cache-busting identity");
  }

  const result = await client.readResource({ uri: grid.uri });
  const html = String(result.contents[0]?.text ?? "");
  if (viewerResolutionAttempted) {
    throw new Error(
      "packaged grid resource attempted to resolve optional @ambitresearch/genie-viewer",
    );
  }
  if (!html.includes("ui/initialize") || !html.includes("ui/notifications/tool-result")) {
    throw new Error("packaged grid resource is missing the executable MCP App bridge");
  }
} finally {
  Module._resolveFilename = originalResolveFilename;
  await client?.close();
}

process.stdout.write(
  "verify-packaged-viewer: bare MCP App shell is executable without @ambitresearch/genie-viewer\n",
);
