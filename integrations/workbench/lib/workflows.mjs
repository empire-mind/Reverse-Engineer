import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { ReaClient, summarizeCapabilities } from "./mcp.mjs";
import { InvestigationMemory } from "./memory.mjs";
import {
  boundResult,
  presentEvidence,
  resultError,
  toolResultValue,
  UNTRUSTED,
} from "./presentation.mjs";
import {
  closeResources,
  retainSession,
  saveErrorReceipt,
  validateStoredBundle,
  viewSourceId,
} from "./retention.mjs";
import { REA_LAUNCHER, selectedEnvironment } from "./runtime.mjs";

function invalid(message) {
  return Object.assign(new Error(message), { code: "WORKBENCH_INVALID_INPUT" });
}

export function absoluteLocalPath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0"))
    throw invalid(`${name} must be an absolute local path without NUL bytes.`);
  return value;
}

export function integerOption(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw invalid(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function optionalText(value, maxBytes, name) {
  if (
    value !== undefined &&
    (typeof value !== "string" ||
      !value.trim() ||
      Buffer.byteLength(value) > maxBytes)
  )
    throw invalid(`${name} must contain 1..${maxBytes} UTF-8 bytes.`);
}

/** Exact JSON text pages; callers can authenticate and reconstruct large schemas. */
export function schemaPage(
  tool,
  { section = "inputSchema", offset = 0, limit = 16384, expected_sha256 } = {},
) {
  if (!["tool", "inputSchema", "outputSchema"].includes(section))
    throw invalid("section must be tool, inputSchema, or outputSchema.");
  integerOption(offset, 0, Number.MAX_SAFE_INTEGER, "offset");
  integerOption(limit, 4, 16384, "limit");
  const value = section === "tool" ? tool : tool[section];
  const bytes = Buffer.from(JSON.stringify(value ?? null));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expected_sha256 !== undefined && expected_sha256 !== sha256)
    throw Object.assign(
      new Error("The advertised schema changed between pages."),
      {
        code: "REA_SCHEMA_CHANGED",
      },
    );
  if (offset > bytes.length || (bytes[offset] & 0xc0) === 0x80)
    throw invalid("offset must be a UTF-8 boundary within the schema JSON.");
  let end = Math.min(offset + limit, bytes.length);
  while (end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    name: tool.name,
    section,
    schema_available: value !== undefined,
    schema_json: bytes.subarray(offset, end).toString("utf8"),
    sha256,
    total_utf8_bytes: bytes.length,
    offset,
    returned_utf8_bytes: end - offset,
    has_more: end < bytes.length,
    next_offset: end < bytes.length ? end : null,
    reconstruction:
      "Concatenate schema_json pages in exact UTF-8 offset order, verify sha256, then parse JSON. Pass expected_sha256 on later pages. An incomplete page is not a usable schema.",
  };
}

/** Shared application workflows. Each invocation owns one REA session and cleanup. */
export class ReaWorkbench {
  #clientOptions;
  #clientFactory;
  #memoryFactory;
  #timeoutMs;
  #ownedResources = new Set();

  constructor({
    memoryRoot,
    timeoutMs = 60000,
    passEnv = [],
    environment,
    clientFactory = (options) => new ReaClient(options),
    memoryFactory = (path) => new InvestigationMemory(path),
  }) {
    this.memoryRoot = absoluteLocalPath(memoryRoot, "memoryRoot");
    this.#timeoutMs = integerOption(timeoutMs, 1000, 600000, "timeoutMs");
    this.#clientFactory = clientFactory;
    this.#memoryFactory = memoryFactory;
    this.#clientOptions = {
      launcher: {
        command: process.execPath,
        args: [REA_LAUNCHER, "mcp"],
        env: selectedEnvironment(passEnv, environment),
      },
      timeoutMs,
    };
  }

  async #run(callback, { signal, memory: needsMemory = false } = {}) {
    signal?.throwIfAborted();
    // Do not accumulate new children behind an unresolved owned cleanup failure.
    if ([...this.#ownedResources].some((owned) => owned.completed))
      await this.close();
    signal?.throwIfAborted();
    const started = performance.now();
    const client = this.#clientFactory(this.#clientOptions);
    const owned = { client, memory: undefined, completed: false };
    this.#ownedResources.add(owned);
    let memory;
    let originalError;
    let result;
    try {
      if (needsMemory) {
        memory = this.#memoryFactory(this.memoryRoot);
        owned.memory = memory;
      }
      await client.connect({ signal });
      result = await callback({ client, memory, signal });
    } catch (failure) {
      const error =
        failure instanceof Error
          ? failure
          : new Error(String(failure), { cause: failure });
      originalError = error;
      if (signal?.aborted) {
        error.cancelled = true;
        if (error.result === undefined) error.code ??= "WORKFLOW_CANCELLED";
      }
      if (memory) {
        try {
          await saveErrorReceipt(memory, error);
        } catch (failure) {
          error.retentionError ??= failure.message;
        }
      }
      throw error;
    } finally {
      owned.completed = true;
      try {
        await closeResources(memory, client, originalError);
      } catch (error) {
        // A successful analysis/export remains usable even if owned cleanup fails.
        if (result !== undefined) {
          error.retained =
            result.memory ??
            (result.resumed_from ? { bundleId: result.resumed_from } : null);
          error.completedWorkflowStatus = result.status ?? null;
        }
        throw error;
      }
      this.#ownedResources.delete(owned);
    }
    if (result.measurements) {
      result.measurements.workflow_elapsed_ms = Math.round(
        performance.now() - started,
      );
      result.measurements.scope =
        "Workflow start through successful owned-resource cleanup";
    }
    return result;
  }

  /** Retain and retry cleanup ownership when an earlier close did not succeed. */
  async close() {
    const errors = [];
    for (const owned of this.#ownedResources) {
      if (!owned.completed) {
        errors.push(
          Object.assign(
            new Error(
              "Cancel and await the active workflow before closing its owner.",
            ),
            { code: "WORKBENCH_BUSY" },
          ),
        );
        continue;
      }
      try {
        await closeResources(owned.memory, owned.client);
        this.#ownedResources.delete(owned);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Workbench resources remain owned after cleanup failed.",
        { cause: errors[0] },
      );
  }

  status(options) {
    return this.#run(async ({ client, signal }) => {
      const catalog = await client.listTools({ signal });
      const session = await client.session({ signal });
      const report = summarizeCapabilities(catalog, session);
      return {
        server: client.serverInfo,
        advertised: report.advertisedCount,
        availability: report.counts,
        availability_evidence:
          "server_reported; individual tools were not executed",
        unmatched_availability: report.unmatchedAvailability,
        successful_checks: client.successfulTools,
        limitations: report.limitations,
        memory_root: this.memoryRoot,
        native_client_registration: "not assessed by this subprocess check",
      };
    }, options);
  }

  tools(
    { query = "", available = false, limit = 30, offset = 0 } = {},
    options,
  ) {
    integerOption(limit, 1, 100, "limit");
    integerOption(offset, 0, Number.MAX_SAFE_INTEGER, "offset");
    if (typeof query !== "string" || Buffer.byteLength(query) > 4096)
      throw invalid("query must contain at most 4096 UTF-8 bytes.");
    if (typeof available !== "boolean")
      throw invalid("available must be boolean.");
    return this.#run(async ({ client, signal }) => {
      const catalog = await client.listTools({ signal });
      const session = await client.session({ signal });
      const report = summarizeCapabilities(catalog, session);
      const normalizedQuery = query.toLocaleLowerCase("en-US");
      const matches = report.tools.filter(
        (tool) =>
          (!available || tool.status === "available") &&
          JSON.stringify(tool)
            .toLocaleLowerCase("en-US")
            .includes(normalizedQuery),
      );
      const score = (tool) => {
        const name = tool.name.toLocaleLowerCase("en-US");
        return name === normalizedQuery
          ? 0
          : name.includes(normalizedQuery)
            ? 1
            : 2;
      };
      matches.sort(
        (left, right) =>
          score(left) - score(right) ||
          left.name.localeCompare(right.name, "en-US"),
      );
      return boundResult({
        total: matches.length,
        offset,
        shown: Math.min(limit, Math.max(0, matches.length - offset)),
        truncated: matches.length > offset + limit,
        next_offset: matches.length > offset + limit ? offset + limit : null,
        tools: matches.slice(offset, offset + limit),
        availability_evidence:
          "server_reported; individual tools were not executed",
      });
    }, options);
  }

  toolSchema(name, options) {
    optionalText(name, 1024, "tool name");
    if (!name) throw invalid("tool name is required.");
    return this.#run(async ({ client, signal }) => {
      const catalog = await client.listTools({ signal });
      const tool = catalog.tools.find((tool) => tool.name === name);
      if (!tool)
        throw Object.assign(
          new Error(`Server does not advertise tool: ${name}`),
          {
            code: "REA_UNKNOWN_TOOL",
          },
        );
      return tool;
    }, options);
  }

  analyzeJavascript({ target, source_paths, title, question }, options = {}) {
    absoluteLocalPath(target, "target");
    optionalText(title, 4096, "title");
    optionalText(question, 8000, "question");
    if (
      source_paths !== undefined &&
      (!Array.isArray(source_paths) ||
        source_paths.length === 0 ||
        source_paths.some(
          (path) => typeof path !== "string" || !path || path.includes("\0"),
        ))
    )
      throw invalid(
        "source_paths must be a nonempty array of exact source paths without NUL bytes.",
      );
    return this.#run(
      async ({ client, memory, signal }) => {
        const args = {
          input_path: target,
          detail: "summary",
          max_semantic_nodes: 20000,
          max_semantic_nodes_per_file: 10000,
          max_heap_mb: 256,
          analysis_timeout_ms: Math.min(this.#timeoutMs, 30000),
          ...(source_paths === undefined ? {} : { source_paths }),
        };
        const started = performance.now();
        let response;
        try {
          response = await client.callTool(
            "analyze_javascript_application",
            args,
            { signal },
          );
        } catch (error) {
          if (signal?.aborted) {
            error.retentionError =
              "The analysis was cancelled before a canonical export was confirmed; complete evidence retention is not claimed.";
          } else {
            try {
              error.retained = await retainSession(client, memory, {
                title,
                question,
                signal,
              });
            } catch (retentionError) {
              error.retentionError = String(retentionError.message).slice(
                0,
                2000,
              );
              error.pendingEvidencePath = retentionError.pendingEvidencePath;
            }
          }
          throw error;
        }
        const analysisMs = performance.now() - started;
        let retained;
        try {
          retained = await retainSession(client, memory, {
            title,
            question,
            signal,
          });
        } catch (error) {
          // Export failure must not erase the completed analysis response. Keep it
          // separately from the export's own failure receipt and canonical evidence.
          const completed = { result: response };
          try {
            await saveErrorReceipt(memory, completed);
            error.analysisReceipt = completed.receipt;
          } catch (receiptError) {
            error.retentionError = `Completed analysis response receipt could not be saved: ${String(receiptError.message).slice(0, 1800)}`;
          }
          throw error;
        }
        const analysis = toolResultValue(response);
        const evidenceId = analysis.result?.evidence_id ?? analysis.evidence_id;
        const saved = evidenceId ? await memory.get(evidenceId) : null;
        return {
          status: "retained",
          target,
          evidence_id: evidenceId,
          view_source_evidence_id: saved ? viewSourceId(saved) : null,
          analysis,
          memory: retained,
          successful_checks: client.successfulTools,
          provenance: UNTRUSTED,
          freshness:
            "Selected target bytes were statically analyzed in this workflow; target execution was not observed.",
          measurements: {
            analysis_elapsed_ms: Math.round(analysisMs),
            mcp_analysis_response_bytes: Buffer.byteLength(
              JSON.stringify(response),
            ),
            tokens: "not measured",
            cpu: "not measured",
            peak_memory: "not measured",
          },
        };
      },
      { ...options, memory: true },
    );
  }

  resume({ evidence_id: id, view }, options = {}) {
    if (typeof id !== "string" || !/^ev_[a-f0-9]{64}$/.test(id))
      throw invalid("evidence_id must be a canonical ev_ SHA-256 identifier.");
    return this.#run(
      async ({ client, memory, signal }) => {
        const entry = await memory.get(id);
        const sourceId = viewSourceId(entry);
        await validateStoredBundle(
          client,
          memory,
          {
            bundleId: entry.selectedBundleId,
          },
          { signal },
        );
        let response;
        try {
          response = await client.callTool(
            "inspect_analysis_view",
            {
              source: { kind: "retained-evidence", evidence_id: sourceId },
              view: view ?? { kind: "summary" },
            },
            { signal },
          );
        } catch (error) {
          if (view !== undefined || error.code !== "REA_TOOL_ERROR")
            throw error;
          await saveErrorReceipt(memory, error);
          return {
            status: "imported-with-metadata",
            resumed_from: entry.selectedBundleId,
            evidence_id: id,
            view_source_evidence_id: sourceId,
            handoff: presentEvidence(entry, memory),
            view_error: resultError(error),
            successful_checks: client.successfulTools,
          };
        }
        return {
          status: "resumed",
          resumed_from: entry.selectedBundleId,
          evidence_id: id,
          view_source_evidence_id: sourceId,
          freshness: "Historical saved evidence; no target was reanalyzed.",
          provenance: UNTRUSTED,
          view: toolResultValue(response),
          successful_checks: client.successfulTools,
          measurements: {
            tokens: "not measured",
            cpu: "not measured",
            peak_memory: "not measured",
          },
        };
      },
      { ...options, memory: true },
    );
  }
}
