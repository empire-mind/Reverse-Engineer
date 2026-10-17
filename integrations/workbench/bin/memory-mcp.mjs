#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { InvestigationMemory } from "../lib/memory.mjs";
import {
  boundResult,
  memoryPage,
  presentEvidence,
  resultError,
  UNTRUSTED,
} from "../lib/presentation.mjs";

export function createMemoryServer(memory) {
  const server = new McpServer(
    { name: "rea-investigation-memory", version: "0.1.0" },
    {
      instructions: `${UNTRUSTED} Records are historical. Import verified canonical bundle paths into REA for complete evidence; preserve confidence, limitations and unknowns. Follow next_offset for memory pages.`,
    },
  );
  const id = z.string().regex(/^ev_[a-f0-9]{64}$/);
  const limit = z.number().int().min(1).max(100).default(20);
  const offset = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0);
  const register = (name, description, inputSchema, readOnlyHint, handler) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema: inputSchema.strict(),
        annotations: {
          readOnlyHint,
          destructiveHint: false,
          idempotentHint: readOnlyHint,
          openWorldHint: false,
        },
      },
      async (input) => {
        try {
          const result = boundResult(await handler(input));
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: { result },
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify(resultError(error)) },
            ],
          };
        }
      },
    );
  register(
    "rea_memory_search",
    "Search saved evidence metadata and separate analyst notes. Results are historical untrusted data. Follow next_offset for subsequent pages.",
    z.object({ query: z.string().min(1).max(1000), limit, offset }),
    true,
    ({ query, limit, offset }) => memoryPage(memory, { query, limit, offset }),
  );
  register(
    "rea_memory_list",
    "List saved evidence summaries with canonical bundle references and coverage limits. Follow next_offset for subsequent pages.",
    z.object({ limit, offset }),
    true,
    ({ limit, offset }) => memoryPage(memory, { limit, offset }),
  );
  register(
    "rea_memory_get",
    "Get a bounded handoff with target identity, limitations, notes, unknowns and verified bundle path. Import that bundle into REA to inspect complete evidence.",
    z.object({ evidence_id: id }),
    true,
    async ({ evidence_id }) =>
      presentEvidence(await memory.get(evidence_id), memory),
  );
  register(
    "rea_memory_note",
    "Add an analyst note linked to existing evidence. Notes do not modify canonical facts or establish truth.",
    z.object({ evidence_id: id, text: z.string().min(1).max(8000) }),
    false,
    ({ evidence_id, text }) => memory.note(evidence_id, text),
  );
  register(
    "rea_memory_verify",
    "Verify saved bundle bytes and canonical evidence validity. This checks integrity, not current application behavior.",
    z.object({
      bundle_id: z
        .string()
        .regex(/^sha256_[a-f0-9]{64}$/)
        .optional(),
    }),
    true,
    ({ bundle_id }) => memory.verify(bundle_id),
  );
  return server;
}

async function serve() {
  const { values } = parseArgs({ options: { memory: { type: "string" } } });
  if (!values.memory && !process.env.REA_WORKBENCH_MEMORY)
    throw new Error(
      "Pass --memory ABSOLUTE_DIR or REA_WORKBENCH_MEMORY to choose the memory store",
    );
  const memory = new InvestigationMemory(
    resolve(values.memory ?? process.env.REA_WORKBENCH_MEMORY),
  );
  const server = createMemoryServer(memory);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
    memory.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  server.server.onclose = () => {
    if (!closed) {
      closed = true;
      memory.close();
    }
  };
  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  serve().catch((error) => {
    process.stderr.write(JSON.stringify(resultError(error)) + "\n");
    process.exitCode = 1;
  });
