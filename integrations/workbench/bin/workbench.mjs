#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { ReaClient, summarizeCapabilities } from "../lib/mcp.mjs";
import { InvestigationMemory } from "../lib/memory.mjs";
import {
  boundResult,
  memoryPage,
  presentEvidence,
  resultError,
  toolResultValue,
} from "../lib/presentation.mjs";
import {
  closeResources,
  retainSession,
  saveErrorReceipt,
  validateStoredBundle,
  viewSourceId,
} from "../lib/retention.mjs";

const require = createRequire(import.meta.url);
const launcher = join(
  dirname(require.resolve("rea-agents/package.json")),
  "scripts/rea.mjs",
);
const HELP = `REA workbench: inspect once, retain evidence, resume with context.

  status                         Check the live MCP version and capability counts
  tools [--query TEXT]            Find tool names and readiness (default limit 30)
  tools --schema TOOL             Print the exact advertised schema for one tool
  analyze-js ABSOLUTE_TARGET      Analyze JavaScript/ASAR; save canonical evidence
    [--source EXACT_PATH]         Repeat to select exact source paths
    [--question TEXT]             Keep the investigation question as an analyst note
  memory import BUNDLE            Validate and index a canonical REA bundle
  memory list                     List retained evidence summaries
  memory search QUERY             Search metadata and analyst notes
  memory show EVIDENCE_ID          Show a compact historical record
  memory note EVIDENCE_ID TEXT     Add a separate analyst note
  memory verify [BUNDLE_ID]        Check stored bytes and canonical bundle validity
  resume EVIDENCE_ID              Import saved evidence into a fresh REA session
    [--view-file JSON]            Request an inspect_analysis_view view after import
  config                         Print pinned REA and memory MCP launch configuration

Options: --memory DIRECTORY, --limit 1..100, --offset INTEGER, --available,
         --timeout-ms 1000..600000, --title TEXT, --full (memory show only).
         --pass-env NAME (repeat) forwards only explicitly named environment values.

Default memory: REA_WORKBENCH_MEMORY or .rea-workbench under the current directory.
This tool does not register servers in a client or install analysis engines.
`;

function parseCli() {
  return parseArgs({
    allowPositionals: true,
    options: {
      memory: { type: "string" },
      query: { type: "string" },
      schema: { type: "string" },
      source: { type: "string", multiple: true },
      question: { type: "string" },
      limit: { type: "string", default: "30" },
      available: { type: "boolean", default: false },
      offset: { type: "string", default: "0" },
      "pass-env": { type: "string", multiple: true },
      "timeout-ms": { type: "string", default: "60000" },
      title: { type: "string" },
      "view-file": { type: "string" },
      full: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function numberOption(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function output(value, { full = false } = {}) {
  process.stdout.write(
    JSON.stringify(full ? value : boundResult(value), null, 2) + "\n",
  );
}

async function main() {
  const workflowStarted = performance.now();
  const { values, positionals } = parseCli();
  const memoryRoot = resolve(
    values.memory ?? process.env.REA_WORKBENCH_MEMORY ?? ".rea-workbench",
  );
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const limit = numberOption(values.limit, 1, 100, "--limit");
  const offset = numberOption(
    values.offset,
    0,
    Number.MAX_SAFE_INTEGER,
    "--offset",
  );
  const timeoutMs = numberOption(
    values["timeout-ms"],
    1000,
    600000,
    "--timeout-ms",
  );
  if (
    values.title !== undefined &&
    (Buffer.byteLength(values.title) > 4096 || !values.title.trim())
  )
    throw new Error("--title must contain 1..4096 UTF-8 bytes");
  if (
    values.question !== undefined &&
    (Buffer.byteLength(values.question) > 8000 || !values.question.trim())
  )
    throw new Error("--question must contain 1..8000 UTF-8 bytes");
  if (values.full && !(command === "memory" && positionals[1] === "show"))
    throw new Error("--full is supported only by memory show");
  if (command === "config") {
    if (values["pass-env"]?.length)
      throw new Error(
        "--pass-env applies to running workbench commands; configure environment values directly in your MCP client's protected configuration.",
      );
    const memoryServer = join(
      dirname(fileURLToPath(import.meta.url)),
      "memory-mcp.mjs",
    );
    output({
      mcpServers: {
        rea: { command: process.execPath, args: [launcher, "mcp"] },
        rea_memory: {
          command: process.execPath,
          args: [memoryServer, "--memory", memoryRoot],
        },
      },
    });
    return;
  }
  if (command === "memory") {
    const memory = new InvestigationMemory(memoryRoot);
    try {
      const action = required(positionals[1], "memory action");
      if (action === "import")
        output(
          await memory.importBundle(
            resolve(required(positionals[2], "bundle path")),
            { title: values.title },
          ),
        );
      else if (action === "list") output(memoryPage(memory, { limit, offset }));
      else if (action === "search")
        output(
          memoryPage(memory, {
            query: required(positionals.slice(2).join(" "), "query"),
            limit,
            offset,
          }),
        );
      else if (action === "verify") output(await memory.verify(positionals[2]));
      else if (action === "show") {
        const entry = await memory.get(required(positionals[2], "evidence ID"));
        if (!entry)
          throw Object.assign(
            new Error("No retained evidence matches that ID."),
            { code: "EVIDENCE_NOT_FOUND" },
          );
        output(values.full ? entry : presentEvidence(entry, memory), {
          full: values.full,
        });
      } else if (action === "note")
        output(
          memory.note(
            required(positionals[2], "evidence ID"),
            required(positionals.slice(3).join(" "), "note text"),
          ),
        );
      else throw new Error(`Unknown memory action: ${action}`);
    } finally {
      memory.close();
    }
    return;
  }
  if (!["status", "tools", "analyze-js", "resume"].includes(command))
    throw new Error(`Unknown command: ${command}`);

  const selectedEnvironment = {};
  for (const name of values["pass-env"] ?? []) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      process.env[name] === undefined
    )
      throw new Error(
        `Requested environment variable is invalid or unset: ${name}`,
      );
    selectedEnvironment[name] = process.env[name];
  }
  const client = new ReaClient({
    launcher: {
      command: process.execPath,
      args: [launcher, "mcp"],
      env: selectedEnvironment,
    },
    timeoutMs,
  });
  let memory;
  let originalError;
  try {
    await client.connect();
    if (command === "status" || command === "tools") {
      const listed = await client.listTools();
      const session = await client.session();
      const report = summarizeCapabilities(listed, session);
      if (command === "status")
        output({
          server: client.serverInfo,
          advertised: report.advertisedCount,
          availability: report.counts,
          unmatched_availability: report.unmatchedAvailability,
          successful_checks: client.successfulTools,
          limitations: report.limitations,
          native_client_registration: "not assessed by this subprocess check",
        });
      else if (values.schema) {
        const tool = listed.tools.find((tool) => tool.name === values.schema);
        if (!tool)
          throw new Error(`Server does not advertise tool: ${values.schema}`);
        output(tool, { full: true });
      } else {
        const query = (values.query ?? "").toLocaleLowerCase("en-US");
        const matches = report.tools.filter(
          (tool) =>
            (!values.available || tool.status === "available") &&
            JSON.stringify(tool).toLocaleLowerCase("en-US").includes(query),
        );
        output({
          total: matches.length,
          offset,
          shown: Math.min(limit, Math.max(0, matches.length - offset)),
          truncated: matches.length > offset + limit,
          next_offset: matches.length > offset + limit ? offset + limit : null,
          tools: matches.slice(offset, offset + limit),
        });
      }
      return;
    }
    memory = new InvestigationMemory(memoryRoot);
    if (command === "resume") {
      const id = required(positionals[1], "evidence ID");
      const entry = await memory.get(id); // Verifies immutable bytes before use.
      const sourceId = viewSourceId(entry);
      await validateStoredBundle(client, memory, {
        bundleId: entry.selectedBundleId,
      });
      const view = values["view-file"]
        ? JSON.parse(await readFile(resolve(values["view-file"]), "utf8"))
        : { kind: "summary" };
      let response;
      try {
        response = await client.callTool("inspect_analysis_view", {
          source: { kind: "retained-evidence", evidence_id: sourceId },
          view,
        });
      } catch (error) {
        if (values["view-file"] || error.code !== "REA_TOOL_ERROR") throw error;
        await saveErrorReceipt(memory, error);
        output({
          status: "imported-with-metadata",
          resumed_from: entry.selectedBundleId,
          evidence_id: id,
          view_source_evidence_id: sourceId,
          handoff: presentEvidence(entry, memory),
          view_error: resultError(error),
          successful_checks: client.successfulTools,
        });
        return;
      }
      await closeResources(memory, client);
      output({
        status: "resumed",
        resumed_from: entry.selectedBundleId,
        evidence_id: id,
        view_source_evidence_id: sourceId,
        freshness: "Historical saved evidence; no target was reanalyzed.",
        view: toolResultValue(response),
        successful_checks: client.successfulTools,
        measurements: {
          workflow_elapsed_ms: Math.round(performance.now() - workflowStarted),
          scope: "Command start through successful owned-resource cleanup",
          tokens: "not measured",
          cpu: "not measured",
          peak_memory: "not measured",
        },
      });
      return;
    }
    const target = required(positionals[1], "absolute target path");
    if (!isAbsolute(target))
      throw new Error("analyze-js requires an absolute target path");
    const args = {
      input_path: target,
      detail: "summary",
      max_semantic_nodes: 20000,
      max_semantic_nodes_per_file: 10000,
      max_heap_mb: 256,
      analysis_timeout_ms: Math.min(timeoutMs, 30000),
    };
    if (values.source) args.source_paths = values.source;
    const started = performance.now();
    let response;
    try {
      response = await client.callTool("analyze_javascript_application", args);
    } catch (error) {
      try {
        error.retained = await retainSession(client, memory, {
          title: values.title,
          question: values.question,
        });
      } catch (retentionError) {
        error.retentionError = String(retentionError.message).slice(0, 2000);
        error.pendingEvidencePath = retentionError.pendingEvidencePath;
      }
      throw error;
    }
    const analysisMs = performance.now() - started;
    const retained = await retainSession(client, memory, {
      title: values.title,
      question: values.question,
    });
    const analysis = toolResultValue(response);
    const evidenceId = analysis.result?.evidence_id ?? analysis.evidence_id;
    const saved = evidenceId ? await memory.get(evidenceId) : null;
    const sourceId = saved ? viewSourceId(saved) : null;
    await closeResources(memory, client);
    output({
      status: "retained",
      target,
      evidence_id: evidenceId,
      view_source_evidence_id: sourceId,
      analysis,
      memory: retained,
      successful_checks: client.successfulTools,
      measurements: {
        analysis_elapsed_ms: Math.round(analysisMs),
        workflow_elapsed_ms: Math.round(performance.now() - workflowStarted),
        scope: "Command start through successful owned-resource cleanup",
        mcp_analysis_response_bytes: Buffer.byteLength(
          JSON.stringify(response),
        ),
        tokens: "not measured",
        cpu: "not measured",
        peak_memory: "not measured",
      },
    });
  } catch (error) {
    originalError = error;
    if (memory) {
      try {
        await saveErrorReceipt(memory, error);
      } catch (failure) {
        error.retentionError = error.retentionError ?? failure.message;
      }
    }
    throw error;
  } finally {
    await closeResources(memory, client, originalError);
  }
}

main().catch((error) => {
  output(resultError(error));
  process.exitCode = 1;
});
