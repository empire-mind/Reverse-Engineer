#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { InvestigationMemory } from "../lib/memory.mjs";
import {
  boundResult,
  memoryPage,
  presentEvidence,
  resultError,
} from "../lib/presentation.mjs";
import { REA_LAUNCHER } from "../lib/runtime.mjs";
import { integerOption, ReaWorkbench } from "../lib/workflows.mjs";

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
  config                         Print a concrete MCP launch configuration
    [--profile PROFILE]          workflow (default), native, memory, or all

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
      profile: { type: "string", default: "workflow" },
      full: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
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
  const { values, positionals } = parseCli();
  const memoryRoot = resolve(
    values.memory ?? process.env.REA_WORKBENCH_MEMORY ?? ".rea-workbench",
  );
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const limit = integerOption(Number(values.limit), 1, 100, "--limit");
  const offset = integerOption(
    Number(values.offset),
    0,
    Number.MAX_SAFE_INTEGER,
    "--offset",
  );
  const timeoutMs = integerOption(
    Number(values["timeout-ms"]),
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
    if (!["workflow", "native", "memory", "all"].includes(values.profile))
      throw new Error("--profile must be workflow, native, memory, or all");
    const directory = dirname(fileURLToPath(import.meta.url));
    const configurations = {
      "rea-workbench": {
        command: process.execPath,
        args: [join(directory, "workbench-mcp.mjs"), "--memory", memoryRoot],
      },
      rea: { command: process.execPath, args: [REA_LAUNCHER, "mcp"] },
      "rea-memory": {
        command: process.execPath,
        args: [join(directory, "memory-mcp.mjs"), "--memory", memoryRoot],
      },
    };
    const names = {
      workflow: ["rea-workbench"],
      native: ["rea"],
      memory: ["rea-memory"],
      all: ["rea-workbench", "rea"],
    }[values.profile];
    output({
      mcpServers: Object.fromEntries(
        names.map((name) => [name, configurations[name]]),
      ),
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

  const workbench = new ReaWorkbench({
    memoryRoot,
    timeoutMs,
    passEnv: values["pass-env"],
  });
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new Error("Workflow cancelled by process signal."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let originalError;
  try {
    const options = { signal: controller.signal };
    if (command === "status") output(await workbench.status(options));
    else if (command === "tools") {
      if (values.schema)
        output(await workbench.toolSchema(values.schema, options), {
          full: true,
        });
      else
        output(
          await workbench.tools(
            {
              query: values.query,
              available: values.available,
              limit,
              offset,
            },
            options,
          ),
        );
    } else if (command === "analyze-js")
      output(
        await workbench.analyzeJavascript(
          {
            target: required(positionals[1], "absolute target path"),
            source_paths: values.source,
            title: values.title,
            question: values.question,
          },
          options,
        ),
      );
    else {
      const view = values["view-file"]
        ? JSON.parse(await readFile(resolve(values["view-file"]), "utf8"))
        : undefined;
      output(
        await workbench.resume(
          {
            evidence_id: required(positionals[1], "evidence ID"),
            view,
          },
          options,
        ),
      );
    }
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    try {
      await workbench.close();
    } catch (error) {
      if (originalError)
        throw new AggregateError(
          [originalError, error],
          "Workflow and cleanup retry failed.",
          { cause: originalError },
        );
      throw error;
    }
  }
}

main().catch((error) => {
  output(resultError(error));
  process.exitCode = 1;
});
