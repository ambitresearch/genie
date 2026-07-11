#!/usr/bin/env node
/**
 * Postbuild integration gate for the packaged MCP App shell.
 *
 * Blocks `@genie/viewer` package resolution, loads the compiled server, and
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
  if (request === "@genie/viewer/package.json") {
    viewerResolutionAttempted = true;
    const error = new Error("blocked optional @genie/viewer resolution");
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

  const result = await client.readResource({ uri: "ui://genie/grid" });
  const html = String(result.contents[0]?.text ?? "");
  if (viewerResolutionAttempted) {
    throw new Error("packaged grid resource attempted to resolve optional @genie/viewer");
  }
  if (!html.includes("ui/initialize") || !html.includes("ui/notifications/tool-result")) {
    throw new Error("packaged grid resource is missing the executable MCP App bridge");
  }
} finally {
  Module._resolveFilename = originalResolveFilename;
  await client?.close();
}

process.stdout.write(
  "verify-packaged-viewer: bare MCP App shell is executable without @genie/viewer\n",
);
