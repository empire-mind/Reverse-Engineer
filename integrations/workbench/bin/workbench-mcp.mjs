#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { InvestigationMemory } from "../lib/memory.mjs";
import {
  createToolLifetime,
  evidenceIdSchema,
  ownServerResources,
  pageOffsetSchema,
  registerJsonTool,
  registerMemoryTools,
  reportServerError,
  serveOwnedServer,
} from "../lib/mcp-server.mjs";
import { UNTRUSTED } from "../lib/presentation.mjs";
import { WORKBENCH_VERSION } from "../lib/runtime.mjs";
import {
  absoluteLocalPath,
  ReaWorkbench,
  schemaPage,
} from "../lib/workflows.mjs";

/** Own the provided workbench and memory until all requests settle on shutdown. */
export function createWorkbenchServer(workbench, memory) {
  const server = new McpServer(
    { name: "rea-workbench", version: WORKBENCH_VERSION },
    {
      instructions: `${UNTRUSTED} Search memory before repeating analysis. Reuse verified saved evidence only for historical questions about the same artifact; explicitly reobserve changed/current targets. Analyze only the caller-selected absolute target and exact source paths. Preserve confidence, scope, limitations and unknowns. This server composes selected JavaScript analysis, canonical export/import, and historical resume; the separate upstream REA server exposes its complete native catalog. One REA workflow runs at a time; memory tools remain available. Follow next_offset and schema hashes for complete pages. Cancellation before export can leave no complete retained bundle; never claim otherwise.`,
    },
  );
  const lifetime = createToolLifetime();
  const register = (name, description, inputSchema, readOnlyHint, handler) =>
    registerJsonTool(
      server,
      name,
      { description, inputSchema, readOnlyHint },
      lifetime.wrap(handler, { exclusive: true }),
    );
  register(
    "rea_workbench_status",
    "Start and close one owned REA subprocess to report package identity and provider/tool availability. Server-reported available does not prove execution; this does not register a native host client.",
    z.object({}),
    true,
    async (_, options) => ({
      ...(await workbench.status(options)),
      concurrency_limit: 1,
    }),
  );
  register(
    "rea_workbench_tools",
    "Discover upstream REA tools by name/description and reported availability. Follow next_offset. This discovery tool never executes a selected native tool.",
    z.object({
      query: z.string().max(1000).default(""),
      available: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(30),
      offset: pageOffsetSchema,
    }),
    true,
    (input, options) => workbench.tools(input, options),
  );
  register(
    "rea_workbench_tool_schema",
    "Get the exact advertised JSON schema for a named upstream tool in bounded UTF-8 text pages. Concatenate schema_json pages, verify sha256, then parse. Use expected_sha256 on later pages. This does not execute the tool.",
    z.object({
      name: z.string().min(1).max(1024),
      section: z
        .enum(["tool", "inputSchema", "outputSchema"])
        .default("inputSchema"),
      offset: pageOffsetSchema,
      limit: z.number().int().min(4).max(16384).default(16384),
      expected_sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
    true,
    async ({ name, ...page }, options) =>
      schemaPage(await workbench.toolSchema(name, options), page),
  );
  const pathPattern =
    process.platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\)/ : /^\//;
  register(
    "rea_workbench_analyze_js",
    "Statically analyze one explicit local JavaScript application/ASAR and nonempty exact source selection, then export, authenticate, and retain canonical evidence in the configured memory store before closing the owned session. Does not execute the target. Writes new evidence and optional analyst notes; preserve returned source limits and unknowns.",
    z.object({
      target: z
        .string()
        .min(1)
        .regex(pathPattern)
        .regex(/^[^\u0000]+$/),
      source_paths: z
        .array(
          z
            .string()
            .min(1)
            .regex(/^[^\u0000]+$/),
        )
        .min(1),
      title: z.string().min(1).max(4096).optional(),
      question: z.string().min(1).max(8000).optional(),
    }),
    false,
    (input, options) => workbench.analyzeJavascript(input, options),
  );
  register(
    "rea_workbench_resume",
    "Verify and import a saved canonical bundle into a fresh REA session, then inspect a summary using authenticated parent evidence. No target is reanalyzed. May update local importer-validation metadata; unavailable views return a historical metadata handoff.",
    z.object({ evidence_id: evidenceIdSchema }),
    false,
    (input, options) => workbench.resume(input, options),
  );
  registerMemoryTools(server, memory, (handler) => lifetime.wrap(handler));
  return ownServerResources(server, lifetime, memory, () => workbench.close());
}

async function serve() {
  const { values } = parseArgs({
    options: {
      memory: { type: "string" },
      "timeout-ms": { type: "string", default: "60000" },
      "pass-env": { type: "string", multiple: true },
    },
  });
  const memoryRoot = absoluteLocalPath(
    values.memory ?? process.env.REA_WORKBENCH_MEMORY,
    "--memory or REA_WORKBENCH_MEMORY",
  );
  const workbench = new ReaWorkbench({
    memoryRoot,
    timeoutMs: Number(values["timeout-ms"]),
    passEnv: values["pass-env"],
  });
  const memory = new InvestigationMemory(memoryRoot);
  const server = createWorkbenchServer(workbench, memory);
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
