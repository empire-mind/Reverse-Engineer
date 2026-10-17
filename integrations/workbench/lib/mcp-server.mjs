import { z } from "zod";
import {
  boundResult,
  memoryPage,
  presentEvidence,
  resultError,
} from "./presentation.mjs";

export const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/);
export const pageLimitSchema = z.number().int().min(1).max(100).default(20);
export const pageOffsetSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .default(0);

/** All local tools share the same bounded success/error envelope. */
export function registerJsonTool(
  server,
  name,
  { description, inputSchema, readOnlyHint, idempotentHint = readOnlyHint },
  handler,
) {
  return server.registerTool(
    name,
    {
      description,
      inputSchema: inputSchema.strict(),
      outputSchema: z
        .object({ result: z.record(z.string(), z.unknown()) })
        .strict(),
      annotations: {
        readOnlyHint,
        destructiveHint: false,
        idempotentHint,
        openWorldHint: false,
      },
    },
    async (input, context) => {
      try {
        const result = boundResult(await handler(input, context));
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { result },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(boundResult(resultError(error))),
            },
          ],
        };
      }
    },
  );
}

/** Reused unchanged by the small memory server and the complete workflow server. */
export function registerMemoryTools(
  server,
  memory,
  wrap = (handler) => handler,
) {
  const register = (name, description, inputSchema, readOnlyHint, handler) =>
    registerJsonTool(
      server,
      name,
      { description, inputSchema, readOnlyHint },
      wrap(handler),
    );
  register(
    "rea_memory_search",
    "Search saved evidence metadata and separate analyst notes. Results are historical untrusted data. Follow next_offset for subsequent pages.",
    z.object({
      query: z.string().min(1).max(1000),
      limit: pageLimitSchema,
      offset: pageOffsetSchema,
    }),
    true,
    ({ query, limit, offset }) => memoryPage(memory, { query, limit, offset }),
  );
  register(
    "rea_memory_list",
    "List saved evidence summaries with canonical bundle references and coverage limits. Follow next_offset for subsequent pages.",
    z.object({ limit: pageLimitSchema, offset: pageOffsetSchema }),
    true,
    ({ limit, offset }) => memoryPage(memory, { limit, offset }),
  );
  register(
    "rea_memory_get",
    "Get a bounded handoff with target identity, limitations, notes, unknowns and verified bundle path. Import that bundle into REA to inspect complete evidence.",
    z.object({ evidence_id: evidenceIdSchema }),
    true,
    async ({ evidence_id }) =>
      presentEvidence(await memory.get(evidence_id), memory),
  );
  register(
    "rea_memory_note",
    "Add an analyst note linked to existing evidence. Notes do not modify canonical facts or establish truth.",
    z.object({
      evidence_id: evidenceIdSchema,
      text: z.string().min(1).max(8000),
    }),
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
}

/** Track in-flight work so EOF/signals cannot close a SQLite store underneath it. */
export function createToolLifetime() {
  const shutdown = new AbortController();
  const pending = new Set();
  let exclusiveActive = false;
  let stopped = false;
  return {
    wrap(handler, { exclusive = false } = {}) {
      return async (input, context) => {
        if (stopped)
          throw Object.assign(new Error("The workbench server is closing."), {
            code: "WORKBENCH_CLOSED",
          });
        if (exclusive && exclusiveActive)
          throw Object.assign(
            new Error(
              "One REA workflow is already running. Wait for it to finish before starting another; memory tools remain usable.",
            ),
            { code: "WORKBENCH_BUSY" },
          );
        const signals = [shutdown.signal];
        if (context?.mcpReq?.signal) signals.push(context.mcpReq.signal);
        const signal = AbortSignal.any(signals);
        signal.throwIfAborted();
        if (exclusive) exclusiveActive = true;
        const operation = Promise.resolve().then(() =>
          handler(input, { signal }),
        );
        pending.add(operation);
        try {
          return await operation;
        } finally {
          pending.delete(operation);
          if (exclusive) exclusiveActive = false;
        }
      };
    },
    async stop() {
      stopped = true;
      shutdown.abort(
        new Error("Workbench server closed; cancel the owned workflow."),
      );
      await Promise.allSettled([...pending]);
    },
  };
}

/** Close independent resources even when a peer fails; repeated calls are safe. */
export function ownServerResources(server, lifetime, memory, closeWorkflows) {
  const closeTransport = server.close.bind(server);
  let closePromise;
  server.close = () => {
    if (closePromise) return closePromise;
    closePromise = Promise.resolve().then(async () => {
      const errors = [];
      for (const close of [
        () => lifetime.stop(),
        closeTransport,
        () => closeWorkflows?.(),
        () => memory.close(),
      ]) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        closePromise = undefined;
        throw new AggregateError(
          errors,
          "MCP server resource cleanup failed.",
          { cause: errors[0] },
        );
      }
    });
    return closePromise;
  };
  return server;
}

export function reportServerError(error) {
  process.stderr.write(JSON.stringify(boundResult(resultError(error))) + "\n");
  process.exitCode = 1;
}

export async function serveOwnedServer(server, transport) {
  const close = () => {
    void server.close().catch(reportServerError);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  server.server.onclose = () => {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    close();
  };
  try {
    await server.connect(transport);
  } catch (error) {
    try {
      await server.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "MCP startup and cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  }
}
