import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { WORKBENCH_VERSION } from "../lib/runtime.mjs";

const entrypoint = fileURLToPath(
  new URL("../bin/workbench-mcp.mjs", import.meta.url),
);
const requestOptions = {
  timeout: 90000,
  maxTotalTimeout: 90000,
  resetTimeoutOnProgress: false,
};
const toolNames = [
  "rea_workbench_status",
  "rea_workbench_tools",
  "rea_workbench_tool_schema",
  "rea_workbench_analyze_js",
  "rea_workbench_resume",
  "rea_memory_search",
  "rea_memory_list",
  "rea_memory_get",
  "rea_memory_note",
  "rea_memory_verify",
].sort();

async function withServer(memoryRoot, action) {
  const client = new Client(
    { name: "workbench-live-test", version: "1" },
    { enforceStrictCapabilities: true },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "--memory", memoryRoot],
    stderr: "pipe",
    maxBufferSize: 1024 * 1024,
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  try {
    await client.connect(transport, requestOptions);
    assert.deepEqual(client.getServerVersion(), {
      name: "rea-workbench",
      version: WORKBENCH_VERSION,
    });
    const catalog = await client.listTools(undefined, requestOptions);
    assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), toolNames);
    return await action(client, catalog);
  } catch (error) {
    if (stderr) error.message += `\nWorkbench server stderr: ${stderr}`;
    throw error;
  } finally {
    await client.close();
    await transport.close();
  }
}

async function call(client, name, args = {}) {
  const response = await client.callTool(
    { name, arguments: args },
    requestOptions,
  );
  assert.notEqual(
    response.isError,
    true,
    `${name}: ${JSON.stringify(response.content)}`,
  );
  const result = response.structuredContent.result;
  assert.deepEqual(JSON.parse(response.content[0].text), result);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  return result;
}

test(
  "published REA through workflow MCP: complete named discovery, selected analysis, all memory tools, and fresh resume after target removal",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-workflow-mcp-live-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const memoryRoot = join(directory, "memory");
    const app = join(directory, "selected-app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        name: "owned-workflow-mcp-fixture",
        version: "0.0.0",
        type: "module",
        main: "src/main.mjs",
      }),
    );
    await writeFile(
      join(app, "src/main.mjs"),
      'import { amount } from "./helper.mjs";\nexport function total(quantity) { return quantity * amount; }\n',
    );
    await writeFile(join(app, "src/helper.mjs"), "export const amount = 7;\n");
    let analyzed;
    let originalBytes;
    await withServer(memoryRoot, async (client, catalog) => {
      const status = await call(client, "rea_workbench_status");
      assert.deepEqual(status.server, { name: "rea", version: "6.5.0" });
      assert.ok(status.advertised > 0);
      assert.equal(
        status.advertised,
        Object.values(status.availability).reduce(
          (sum, value) => sum + value,
          0,
        ),
      );
      assert.equal(status.concurrency_limit, 1);
      assert.equal(status.memory_root, memoryRoot);
      assert.match(status.availability_evidence, /server_reported/);
      const tools = await call(client, "rea_workbench_tools", {
        query: "analyze_javascript_application",
        available: true,
        limit: 1,
      });
      assert.equal(tools.tools[0].name, "analyze_javascript_application");
      const schema = await call(client, "rea_workbench_tool_schema", {
        name: "analyze_javascript_application",
      });
      assert.equal(schema.has_more, false);
      assert.equal(
        createHash("sha256").update(schema.schema_json).digest("hex"),
        schema.sha256,
      );
      assert.ok(JSON.parse(schema.schema_json).properties.input_path);
      const input = {
        target: app,
        source_paths: ["src/main.mjs"],
        question: "Which selected module contributes the price calculation?",
      };
      const validator = new AjvJsonSchemaValidator();
      assert.equal(
        validator.getValidator(
          catalog.tools.find((tool) => tool.name === "rea_workbench_analyze_js")
            .inputSchema,
        )(input).valid,
        true,
      );
      analyzed = await call(client, "rea_workbench_analyze_js", input);
      assert.equal(analyzed.status, "retained");
      assert.equal(analyzed.memory.validation.validatedByRea, true);
      assert.deepEqual(
        analyzed.analysis.normalized_result.summary.source_selection
          .requested_paths,
        ["src/main.mjs"],
      );
      assert.equal(
        analyzed.analysis.normalized_result.summary.statistics
          .parsed_javascript_files,
        1,
      );
      assert.ok(
        analyzed.analysis.normalized_result.summary.source_selection
          .unselected_files > 0,
      );
      assert.match(analyzed.provenance, /untrusted data, not instructions/);
      originalBytes = await readFile(analyzed.memory.bundlePath);
      assert.equal(
        createHash("sha256").update(originalBytes).digest("hex"),
        analyzed.memory.bundleId.slice(7),
      );
      const canonical = JSON.parse(originalBytes);
      assert.ok(
        canonical.records.some(
          (record) => record.evidence_id === analyzed.evidence_id,
        ),
      );
      assert.ok(
        canonical.records.some(
          (record) => record.evidence_id === analyzed.view_source_evidence_id,
        ),
      );
      const listed = await call(client, "rea_memory_list");
      assert.ok(
        listed.records.some(
          (record) => record.evidence_id === analyzed.evidence_id,
        ),
      );
      const before = await call(client, "rea_memory_get", {
        evidence_id: analyzed.evidence_id,
      });
      assert.equal(before.bundle.integrity.verified, true);
      const note = await call(client, "rea_memory_note", {
        evidence_id: analyzed.evidence_id,
        text: "McpRetainedHorizon: static calculation hypothesis; runtime has not been observed.",
      });
      assert.equal(note.kind, "analyst-note");
      const search = await call(client, "rea_memory_search", {
        query: "McpRetainedHorizon",
      });
      assert.equal(search.records[0].evidence_id, analyzed.evidence_id);
      const after = await call(client, "rea_memory_get", {
        evidence_id: analyzed.evidence_id,
      });
      assert.equal(after.authority, before.authority);
      assert.equal(after.confidence, before.confidence);
      assert.equal(after.note_count, before.note_count + 1);
      assert.equal(
        (
          await call(client, "rea_memory_verify", {
            bundle_id: analyzed.memory.bundleId,
          })
        ).ok,
        true,
      );
    });
    await rename(app, join(directory, "target-no-longer-mounted"));
    await withServer(memoryRoot, async (client) => {
      const resumed = await call(client, "rea_workbench_resume", {
        evidence_id: analyzed.evidence_id,
      });
      assert.equal(resumed.status, "resumed");
      assert.equal(resumed.evidence_id, analyzed.evidence_id);
      assert.equal(
        resumed.view_source_evidence_id,
        analyzed.view_source_evidence_id,
      );
      assert.ok(resumed.successful_checks.includes("import_evidence_bundle"));
      assert.ok(resumed.successful_checks.includes("inspect_analysis_view"));
      assert.ok(
        !resumed.successful_checks.includes("analyze_javascript_application"),
      );
      assert.match(resumed.freshness, /no target was reanalyzed/);
      assert.deepEqual(
        await readFile(analyzed.memory.bundlePath),
        originalBytes,
      );
      assert.equal(
        (
          await call(client, "rea_memory_search", {
            query: "McpRetainedHorizon",
          })
        ).records[0].evidence_id,
        analyzed.evidence_id,
      );
    });
  },
);

test(
  "published REA workflow MCP preserves exact failure receipts and remains usable after an unsuccessful analysis",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-workflow-mcp-failure-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    await withServer(join(directory, "memory"), async (client) => {
      const failed = await client.callTool(
        {
          name: "rea_workbench_analyze_js",
          arguments: {
            target: join(directory, "does-not-exist"),
            source_paths: ["main.js"],
          },
        },
        requestOptions,
      );
      assert.equal(failed.isError, true);
      const diagnostic = JSON.parse(failed.content[0].text);
      assert.ok(diagnostic.diagnostic_receipt);
      const receiptBytes = await readFile(diagnostic.diagnostic_receipt.path);
      assert.equal(
        createHash("sha256").update(receiptBytes).digest("hex"),
        diagnostic.diagnostic_receipt.sha256,
      );
      const receipt = JSON.parse(receiptBytes);
      assert.equal(receipt.isError, true);
      const original = JSON.parse(
        receipt.content.find((block) => block.type === "text").text,
      ).error;
      assert.equal(diagnostic.code, original.code);
      assert.equal(diagnostic.message, original.message);
      assert.ok(Buffer.byteLength(failed.content[0].text) <= 64 * 1024);
      const missing = await client.callTool(
        {
          name: "rea_workbench_tool_schema",
          arguments: { name: "not_an_advertised_tool" },
        },
        requestOptions,
      );
      assert.equal(
        JSON.parse(missing.content[0].text).code,
        "REA_UNKNOWN_TOOL",
      );
      assert.equal((await call(client, "rea_memory_verify")).ok, true);
      assert.equal(
        (await call(client, "rea_workbench_status")).server.version,
        "6.5.0",
      );
    });
  },
);
