import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createWorkbenchServer } from "../bin/workbench-mcp.mjs";
import { ReaWorkbench, schemaPage } from "../lib/workflows.mjs";
import { resultError } from "../lib/presentation.mjs";
import { ReaToolError } from "../lib/mcp.mjs";
import { InvestigationMemory } from "../lib/memory.mjs";
import { createEvidence } from "rea-agents/dist/domain/evidence.js";
import { createEvidenceBundle } from "rea-agents/dist/domain/evidenceBundle.js";

test("exact schema byte pages reconstruct escaped and multibyte text without silently presenting a partial schema", () => {
  const tool = {
    name: "unicode_tool",
    inputSchema: {
      type: "object",
      description: '💜漢\\\n"'.repeat(10000),
      additionalProperties: false,
    },
  };
  let offset = 0;
  let digest;
  const chunks = [];
  do {
    const page = schemaPage(tool, {
      offset,
      limit: 16384,
      expected_sha256: digest,
    });
    digest ??= page.sha256;
    chunks.push(page.schema_json);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024);
    assert.ok(!page.schema_json.includes("\ufffd"));
    assert.equal(Buffer.byteLength(page.schema_json), page.returned_utf8_bytes);
    offset = page.next_offset;
  } while (offset !== null);
  const joined = chunks.join("");
  assert.deepEqual(JSON.parse(joined), tool.inputSchema);
  assert.equal(createHash("sha256").update(joined).digest("hex"), digest);
  assert.throws(() => schemaPage(tool, { expected_sha256: "f".repeat(64) }), {
    code: "REA_SCHEMA_CHANGED",
  });
  assert.throws(() => schemaPage(tool, { offset: 5e6 }), {
    code: "WORKBENCH_INVALID_INPUT",
  });
  const full = Buffer.from(JSON.stringify(tool.inputSchema));
  const middle = full.indexOf(Buffer.from("💜")) + 1;
  assert.throws(() => schemaPage(tool, { offset: middle }), /UTF-8 boundary/);
  const missingOutput = schemaPage(tool, { section: "outputSchema" });
  assert.equal(missingOutput.schema_available, false);
  assert.equal(missingOutput.schema_json, "null");
});

test("workflow keeps failed cleanup ownership for an explicit retry and preserves the primary failure", async () => {
  let closes = 0;
  const primary = new Error("session initialization failed");
  const client = {
    async connect() {
      throw primary;
    },
    async close() {
      if (++closes === 1) throw new Error("owned transport close failed");
    },
  };
  const workbench = new ReaWorkbench({
    memoryRoot: "/selected/memory",
    clientFactory: () => client,
  });
  await assert.rejects(workbench.status(), (error) => {
    const reported = resultError(error);
    assert.equal(reported.message, primary.message);
    assert.equal(
      reported.cleanup_errors[0].message,
      "owned transport close failed",
    );
    return true;
  });
  assert.equal(closes, 1);
  await workbench.close();
  assert.equal(closes, 2);
  await workbench.close();
  assert.equal(closes, 2);
});

test("workflow validates targets and cancellation before opening a new process or memory store", async () => {
  let constructed = 0;
  const workbench = new ReaWorkbench({
    memoryRoot: "/selected/memory",
    clientFactory() {
      constructed += 1;
      throw new Error("unexpected process");
    },
    memoryFactory() {
      throw new Error("unexpected memory write");
    },
  });
  assert.throws(
    () => workbench.analyzeJavascript({ target: "relative" }),
    /absolute local path/,
  );
  assert.throws(
    () =>
      workbench.analyzeJavascript({
        target: "/selected/app",
        source_paths: [],
      }),
    /nonempty array/,
  );
  assert.throws(
    () => workbench.resume({ evidence_id: "../../file" }),
    /canonical ev_/,
  );
  await assert.rejects(
    workbench.status({
      signal: AbortSignal.abort(new Error("already cancelled")),
    }),
    /already cancelled/,
  );
  assert.equal(constructed, 0);
});

test("a canonical export failure retains both the completed analysis response and the exact export diagnostic", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "rea-workflow-export-failure-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const analysis = {
    content: [{ type: "text", text: "Original completed analysis text" }],
    structuredContent: {
      evidence_id: `ev_${"a".repeat(64)}`,
      retained_fact: "producer observation",
    },
    _meta: { producer: "owned boundary fixture" },
  };
  const exportDiagnostic = {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "export-unavailable",
            message: "The selected export could not complete.",
          },
        }),
      },
    ],
  };
  let closed = false;
  const client = {
    async connect() {},
    async callTool(name) {
      assert.equal(name, "analyze_javascript_application");
      return analysis;
    },
    async exportBundle() {
      throw new ReaToolError("export_evidence_bundle", exportDiagnostic);
    },
    async close() {
      closed = true;
    },
  };
  const workbench = new ReaWorkbench({
    memoryRoot: join(directory, "memory"),
    clientFactory: () => client,
  });
  let failure;
  try {
    await workbench.analyzeJavascript({
      target: "/selected/app",
      source_paths: ["main.js"],
    });
  } catch (error) {
    failure = resultError(error);
  }
  assert.ok(failure);
  assert.equal(failure.code, "export-unavailable");
  assert.equal(failure.retained, null);
  assert.ok(failure.pending_evidence_path);
  assert.deepEqual(
    JSON.parse(await readFile(failure.completed_analysis_receipt.path, "utf8")),
    analysis,
  );
  assert.deepEqual(
    JSON.parse(await readFile(failure.diagnostic_receipt.path, "utf8")),
    exportDiagnostic,
  );
  assert.equal(closed, true);
});

async function canonicalFixture(t, count = 1) {
  const directory = await mkdtemp(
    join(tmpdir(), "rea-workflow-retained-partial-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = Array.from({ length: count }, (_, value) =>
    createEvidence(
      {
        path: "/selected/fixture/main.js",
        sha256: "a".repeat(64),
        format: "javascript",
        architecture: null,
      },
      { id: "fixture", name: "Owned retention boundary fixture", version: "1" },
      {
        operation: "analyze_javascript_application",
        parameters: {},
        result: { value },
      },
    ),
  );
  const bytes = Buffer.from(JSON.stringify(createEvidenceBundle(records)));
  const client = {
    successfulTools: [],
    async connect() {},
    async callTool() {
      return { structuredContent: records[0], content: [] };
    },
    async exportBundle(path) {
      await writeFile(path, bytes, { flag: "wx" });
    },
    async importBundle() {},
    async close() {},
  };
  return { memoryRoot: join(directory, "memory"), records, bytes, client };
}

test("cancellation during importer validation preserves canonical recovery but writes no question notes and never reports success", async (t) => {
  const fixture = await canonicalFixture(t);
  const controller = new AbortController();
  fixture.client.importBundle = async (_, { signal }) => {
    controller.abort(
      new Error("User cancelled while validating retained bytes"),
    );
    signal.throwIfAborted();
  };
  const workbench = new ReaWorkbench({
    memoryRoot: fixture.memoryRoot,
    clientFactory: () => fixture.client,
  });
  let diagnostic;
  try {
    await workbench.analyzeJavascript(
      {
        target: "/selected/fixture",
        source_paths: ["main.js"],
        question: "A question note that must not be written after cancellation",
      },
      { signal: controller.signal },
    );
    assert.fail("Cancelled analysis workflow must reject");
  } catch (error) {
    diagnostic = resultError(error);
  }
  assert.equal(diagnostic.cancelled, true);
  assert.equal(diagnostic.code, "WORKFLOW_CANCELLED");
  assert.equal(diagnostic.retained.validation.validatedByRea, false);
  assert.equal(diagnostic.retained.question_note.status, "not_recorded");
  assert.equal(diagnostic.pending_evidence_path, null);
  assert.deepEqual(
    await readFile(diagnostic.retained.bundlePath),
    fixture.bytes,
  );
  const memory = new InvestigationMemory(fixture.memoryRoot);
  try {
    assert.equal((await memory.verify()).ok, true);
    assert.equal(
      (await memory.get(fixture.records[0].evidence_id)).notes.length,
      0,
    );
  } finally {
    memory.close();
  }
});

test("an optional note I/O failure reports partial note writes and preserves authenticated canonical bundle recovery", async (t) => {
  const fixture = await canonicalFixture(t, 2);
  const workbench = new ReaWorkbench({
    memoryRoot: fixture.memoryRoot,
    clientFactory: () => fixture.client,
    memoryFactory(path) {
      const memory = new InvestigationMemory(path);
      const writeNote = memory.note.bind(memory);
      let calls = 0;
      memory.note = (...args) => {
        if (++calls === 2)
          throw Object.assign(new Error("Injected SQLite note I/O failure"), {
            code: "SQLITE_IOERR",
          });
        return writeNote(...args);
      };
      return memory;
    },
  });
  let diagnostic;
  try {
    await workbench.analyzeJavascript({
      target: "/selected/fixture",
      source_paths: ["main.js"],
      question: "Separate analyst question",
    });
    assert.fail("Note I/O failure must be reported");
  } catch (error) {
    diagnostic = resultError(error);
  }
  assert.equal(diagnostic.code, "SQLITE_IOERR");
  assert.equal(diagnostic.retained.validation.validatedByRea, true);
  assert.equal(diagnostic.retained.question_note.status, "partially_recorded");
  assert.equal(
    diagnostic.retained.question_note.recorded_evidence_ids.length,
    1,
  );
  assert.deepEqual(
    await readFile(diagnostic.retained.bundlePath),
    fixture.bytes,
  );
  const memory = new InvestigationMemory(fixture.memoryRoot);
  try {
    assert.equal((await memory.verify()).ok, true);
    const recordedId =
      diagnostic.retained.question_note.recorded_evidence_ids[0];
    assert.equal((await memory.get(recordedId)).notes.length, 1);
    assert.equal(memory.list().length, 2);
  } finally {
    memory.close();
  }
});

test("cleanup-only EIO remains the reported diagnosis and blocks new child creation until the owned cleanup succeeds", async () => {
  let constructed = 0;
  let unavailable = true;
  let afterCleanup;
  const workbench = new ReaWorkbench({
    memoryRoot: "/selected/memory",
    clientFactory() {
      constructed += 1;
      return {
        serverInfo: { name: "rea", version: "6.5.0" },
        successfulTools: [],
        async connect() {},
        async listTools() {
          return { tools: [] };
        },
        async session() {
          return {
            structuredContent: {
              result: { tool_availability: { groups: [] } },
            },
          };
        },
        async close() {
          if (unavailable)
            throw Object.assign(
              new Error("Concrete transport close failure: EIO"),
              { code: "EIO" },
            );
          afterCleanup?.();
        },
      };
    },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(workbench.status(), (error) => {
      const diagnostic = resultError(error);
      assert.equal(diagnostic.code, "EIO");
      assert.equal(diagnostic.message, "Concrete transport close failure: EIO");
      assert.ok(diagnostic.cleanup_errors.some((item) => item.code === "EIO"));
      return true;
    });
  }
  assert.equal(constructed, 1);
  unavailable = false;
  const controller = new AbortController();
  afterCleanup = () =>
    controller.abort(new Error("cancelled during owned cleanup retry"));
  await assert.rejects(
    workbench.status({ signal: controller.signal }),
    /cancelled during owned cleanup retry/,
  );
  assert.equal(constructed, 1);
  await workbench.close();
});

test("actual SDK rejects parallel workflow fan-out, leaves memory usable, and propagates cancellation before shutdown cleanup", async () => {
  let enter;
  const started = new Promise((resolve) => {
    enter = resolve;
  });
  let settle;
  const cleaned = new Promise((resolve) => {
    settle = resolve;
  });
  let statusCalls = 0;
  let memoryClosed = 0;
  let workbenchClosed = 0;
  const memory = {
    list() {
      return [];
    },
    close() {
      memoryClosed += 1;
    },
  };
  const workbench = {
    async status({ signal }) {
      statusCalls += 1;
      enter();
      try {
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      } finally {
        await delay(20);
        assert.equal(
          memoryClosed,
          0,
          "memory must remain open until active workflow cleanup settles",
        );
        settle();
      }
    },
    async close() {
      workbenchClosed += 1;
    },
  };
  const server = createWorkbenchServer(workbench, memory);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workflow-lifetime-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 10);
    const validator = new AjvJsonSchemaValidator();
    const analysis = catalog.tools.find(
      (tool) => tool.name === "rea_workbench_analyze_js",
    );
    const validate = validator.getValidator(analysis.inputSchema);
    assert.equal(
      validate({ target: "/selected/app", source_paths: ["main.js"] }).valid,
      true,
    );
    for (const invalid of [
      { target: "relative", source_paths: ["main.js"] },
      { target: "/selected/app", source_paths: [] },
      { target: "/selected/app", source_paths: ["main.js"], execute: true },
    ]) {
      assert.equal(validate(invalid).valid, false);
      assert.equal(
        (await client.callTool({ name: analysis.name, arguments: invalid }))
          .isError,
        true,
      );
    }
    assert.equal(analysis.annotations.readOnlyHint, false);
    assert.equal(analysis.annotations.destructiveHint, false);
    assert.ok(
      !catalog.tools.some(
        (tool) => tool.name === "open_binary" || tool.name === "call_tool",
      ),
    );
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "rea_workbench_status", arguments: {} },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(
      pending,
      /selected request cancelled|abort/i,
    );
    await started;
    const busy = await client.callTool({
      name: "rea_workbench_status",
      arguments: {},
    });
    assert.equal(busy.isError, true);
    assert.equal(JSON.parse(busy.content[0].text).code, "WORKBENCH_BUSY");
    const listed = await client.callTool({
      name: "rea_memory_list",
      arguments: {},
    });
    assert.deepEqual(listed.structuredContent.result.records, []);
    assert.equal(statusCalls, 1);
    controller.abort(new Error("selected request cancelled"));
    await rejected;
    await cleaned;
  } finally {
    await client.close();
    await server.close();
  }
  assert.equal(memoryClosed, 1);
  assert.equal(workbenchClosed, 1);
});
