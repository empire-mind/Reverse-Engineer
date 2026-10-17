#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { InvestigationMemory } from "../lib/memory.mjs";
import { UNTRUSTED } from "../lib/presentation.mjs";
import { WORKBENCH_VERSION } from "../lib/runtime.mjs";
import { absoluteLocalPath } from "../lib/workflows.mjs";
import {
  createToolLifetime,
  ownServerResources,
  registerMemoryTools,
  reportServerError,
  serveOwnedServer,
} from "../lib/mcp-server.mjs";

export function createMemoryServer(memory) {
  const server = new McpServer(
    { name: "rea-investigation-memory", version: WORKBENCH_VERSION },
    {
      instructions: `${UNTRUSTED} Records are historical. Import verified canonical bundle paths into REA for complete evidence; preserve confidence, limitations and unknowns. Follow next_offset for memory pages.`,
    },
  );
  const lifetime = createToolLifetime();
  registerMemoryTools(server, memory, (handler) => lifetime.wrap(handler));
  return ownServerResources(server, lifetime, memory);
}

async function serve() {
  const { values } = parseArgs({ options: { memory: { type: "string" } } });
  const memoryRoot = absoluteLocalPath(
    values.memory ?? process.env.REA_WORKBENCH_MEMORY,
    "--memory or REA_WORKBENCH_MEMORY",
  );
  const memory = new InvestigationMemory(memoryRoot);
  const server = createMemoryServer(memory);
  await serveOwnedServer(
    server,
    new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 1024 * 1024,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  serve().catch(reportServerError);
