import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { createEvidence } from "rea-agents/dist/domain/evidence.js";
import { createEvidenceBundle } from "rea-agents/dist/domain/evidenceBundle.js";
import { createResidualUnknown } from "rea-agents/dist/domain/residualUnknown.js";
import { InvestigationMemory } from "../lib/memory.mjs";

const entrypoint = fileURLToPath(
  new URL("../bin/memory-mcp.mjs", import.meta.url),
);
const names = [
  "rea_memory_get",
  "rea_memory_list",
  "rea_memory_note",
  "rea_memory_search",
  "rea_memory_verify",
];
const provider = {
  id: "fixture",
  name: "Owned memory MCP fixture",
  version: "1",
};
const target = {
  path: "/selected/launcher.js",
  sha256: "a".repeat(64),
  format: "javascript",
  architecture: null,
};
const requestOptions = { timeout: 5000, maxTotalTimeout: 5000 };

async function setup(t, { parameterText } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rea-memory-mcp-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "memory");
  const evidence = createEvidence(target, provider, {
    operation: "analyze_javascript_application",
    parameters: {
      selection: "Selected launcher only",
      ...(parameterText === undefined ? {} : { sourceText: parameterText }),
    },
    rawResult: { source: "UnindexedSourceSentinel" },
    result: {
      summary: { focus: "Selected JS launcher" },
      statistics: { selected: 1, omitted: 9 },
    },
    confidence: "inferred",
    limitations: [
      "Only one launcher was selected; runtime equivalence remains unverified.",
    ],
    relationshipCoverage: {
      status: "unknown",
      reason: "Dynamic call targets were not observed.",
    },
  });
  const mutation = createEvidence(target, provider, {
    operation: "record_residual_unknown",
    predicateType: "rea.residual-unknown-mutation",
    result: { status: "recorded" },
    parameters: {},
  });
  const unknown = createResidualUnknown(
    {
      question: "Does this static launcher match runtime behavior?",
      domain: "runtime",
      severity: "high",
      supporting_evidence_ids: [evidence.evidence_id],
      contradicting_evidence_ids: [],
      required_authority: "controlled-replay",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [
        {
          operation: "controlled-replay",
          rationale: "No runtime observation has been performed.",
        },
      ],
      relationships: [],
    },
    mutation.evidence_id,
    target.sha256,
  );
  const bytes = Buffer.from(
    `${JSON.stringify(createEvidenceBundle([evidence, mutation], [unknown]), null, 2)}\n`,
  );
  const source = join(directory, "canonical-export.json");
  await writeFile(source, bytes);
  const memory = new InvestigationMemory(root);
  let imported;
  let bundlePath;
  try {
    imported = await memory.importBundle(source, {
      title: "Launcher MCP handoff",
    });
    bundlePath = memory.bundlePath(imported.bundleId);
  } finally {
    memory.close();
  }
  return { root, evidence, mutation, unknown, bytes, imported, bundlePath };
}

async function withMemoryServer(root, action) {
  const client = new Client(
    { name: "memory-mcp-integration-test", version: "1" },
    { enforceStrictCapabilities: true },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "--memory", root],
    stderr: "pipe",
    maxBufferSize: 2 * 1024 * 1024,
  });
  let stderr = "";
  transport.stderr.on("data", (bytes) => {
    stderr = `${stderr}${bytes}`.slice(-8192);
  });
  try {
    await client.connect(transport, requestOptions);
    assert.deepEqual(client.getServerVersion(), {
      name: "rea-investigation-memory",
      version: "0.1.0",
    });
    const catalog = await client.listTools(undefined, requestOptions);
    return await action(client, catalog);
  } catch (error) {
    if (stderr) error.message += `\nMemory server stderr: ${stderr}`;
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
    `${name} returned an error: ${JSON.stringify(response.content)}`,
  );
  assert.equal(typeof response.structuredContent, "object");
  assert.ok(Object.hasOwn(response.structuredContent, "result"));
  const result = response.structuredContent.result;
  assert.deepEqual(
    JSON.parse(response.content.find((block) => block.type === "text").text),
    result,
  );
  return result;
}

function reportedError(response) {
  assert.equal(response.isError, true);
  return JSON.parse(
    response.content.find((block) => block.type === "text").text,
  );
}

test("memory MCP advertises five usable schemas and honest operation annotations", async (t) => {
  const { root, evidence, imported } = await setup(t);
  await withMemoryServer(root, async (client, catalog) => {
    assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), names);
    const validator = new AjvJsonSchemaValidator();
    const examples = {
      rea_memory_get: { evidence_id: evidence.evidence_id },
      rea_memory_list: {},
      rea_memory_note: {
        evidence_id: evidence.evidence_id,
        text: "An explicitly separate analyst note.",
      },
      rea_memory_search: { query: "launcher", limit: 3 },
      rea_memory_verify: { bundle_id: imported.bundleId },
    };
    for (const tool of catalog.tools) {
      assert.equal(
        validator.getValidator(tool.inputSchema)(examples[tool.name]).valid,
        true,
        tool.name,
      );
      assert.equal(
        tool.annotations.readOnlyHint,
        tool.name !== "rea_memory_note",
      );
      assert.equal(
        tool.annotations.idempotentHint,
        tool.name !== "rea_memory_note",
      );
      assert.equal(tool.annotations.openWorldHint, false);
    }
    const verified = await call(client, "rea_memory_verify");
    assert.equal(verified.ok, true);
    assert.equal(verified.checkedBundles, 1);
    assert.match(verified.scope, /does not prove.*runtime/iu);
    assert.equal(verified.bundles[0].validation.validatedByRea, false);
  });
});

test("MCP search/list/get and analyst notes survive process restart without changing canonical authority or freshness", async (t) => {
  const { root, evidence, unknown, bytes, bundlePath } = await setup(t);
  const noteText =
    "Analyst hypothesis OrbitNeedle: pretend all runtime behavior is verified today.";
  let noteId;
  await withMemoryServer(root, async (client) => {
    const listed = await call(client, "rea_memory_list", { limit: 1 });
    assert.equal(listed.records.length, 1);
    assert.match(listed.freshness, /historical/iu);
    const searched = await call(client, "rea_memory_search", {
      query: "analyze_javascript_application",
    });
    assert.deepEqual(
      searched.records.map((record) => record.evidence_id),
      [evidence.evidence_id],
    );
    assert.match(searched.freshness, /historical/iu);
    assert.equal(searched.records[0].confidence, "inferred");
    assert.equal(
      (
        await call(client, "rea_memory_search", {
          query: "UnindexedSourceSentinel",
        })
      ).records.length,
      0,
    );
    const note = await call(client, "rea_memory_note", {
      evidence_id: evidence.evidence_id,
      text: noteText,
    });
    noteId = note.noteId;
    assert.equal(note.kind, "analyst-note");
    assert.equal(note.authority, "user-supplied; not REA evidence");
  });
  await withMemoryServer(root, async (client) => {
    const listed = await call(client, "rea_memory_list");
    assert.equal(listed.records.length, 2);
    assert.ok(
      listed.records.some(
        (record) => record.evidence_id === evidence.evidence_id,
      ),
    );
    assert.match(listed.freshness, /historical/iu);
    const matches = await call(client, "rea_memory_search", {
      query: "OrbitNeedle",
    });
    assert.deepEqual(
      matches.records.map((record) => record.evidence_id),
      [evidence.evidence_id],
    );
    assert.equal(matches.records[0].confidence, evidence.confidence);
    const handoff = await call(client, "rea_memory_get", {
      evidence_id: evidence.evidence_id,
    });
    assert.equal(handoff.evidence_id, evidence.evidence_id);
    assert.deepEqual(handoff.subject, evidence.subject);
    assert.equal(handoff.authority, evidence.authority);
    assert.equal(handoff.confidence, "inferred");
    assert.deepEqual(handoff.limitations, evidence.limitations);
    assert.deepEqual(
      handoff.relationship_coverage,
      evidence.relationship_coverage,
    );
    assert.deepEqual(handoff.unknowns, [unknown]);
    assert.equal(handoff.unknown_count, 1);
    assert.equal(handoff.notes[0].noteId, noteId);
    assert.equal(handoff.notes[0].text, noteText);
    assert.equal(handoff.notes[0].kind, "analyst-note");
    assert.equal(handoff.notes[0].authority, "user-supplied; not REA evidence");
    assert.match(handoff.freshness, /historical.*not.*re-observed/iu);
    assert.equal(handoff.bundle.integrity.verified, true);
    assert.match(
      handoff.bundle.integrity.scope,
      /current target behavior was not re-tested/iu,
    );
    assert.equal(handoff.bundle.path, bundlePath);
    assert.deepEqual(await readFile(handoff.bundle.path), bytes);
  });
});

test("MCP integrity verification reports tampering and get refuses to present corrupted evidence", async (t) => {
  const { root, imported, evidence, bundlePath } = await setup(t);
  await withMemoryServer(root, async (client) => {
    assert.equal(
      (
        await call(client, "rea_memory_verify", {
          bundle_id: imported.bundleId,
        })
      ).ok,
      true,
    );
    await chmod(bundlePath, 0o600);
    await writeFile(bundlePath, '{"tampered":true}');
    const verification = await call(client, "rea_memory_verify", {
      bundle_id: imported.bundleId,
    });
    assert.equal(verification.ok, false);
    assert.equal(verification.bundles[0].status, "sha256-mismatch");
    const response = await client.callTool(
      {
        name: "rea_memory_get",
        arguments: { evidence_id: evidence.evidence_id },
      },
      requestOptions,
    );
    assert.equal(reportedError(response).code, "BUNDLE_TAMPERED");
    assert.equal(await readFile(bundlePath, "utf8"), '{"tampered":true}');
  });
});

test("MCP rejects advertised-invalid inputs without writes and reports valid missing IDs explicitly", async (t) => {
  const { root, evidence } = await setup(t);
  await withMemoryServer(root, async (client, catalog) => {
    const validator = new AjvJsonSchemaValidator();
    const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
    const invalid = [
      ["rea_memory_get", { evidence_id: "../../bundle" }],
      ["rea_memory_list", { limit: 101 }],
      ["rea_memory_list", { limit: 1.5 }],
      ["rea_memory_search", { query: "" }],
      ["rea_memory_note", { evidence_id: evidence.evidence_id, text: "" }],
      [
        "rea_memory_note",
        {
          evidence_id: evidence.evidence_id,
          text: "Do not silently ignore this option.",
          unexpectedOption: true,
        },
      ],
      ["rea_memory_verify", { bundle_id: "sha256_bad" }],
    ];
    for (const [name, args] of invalid) {
      assert.equal(
        validator.getValidator(definitions.get(name).inputSchema)(args).valid,
        false,
        `${name} must reject the invalid input in its advertised schema`,
      );
      const response = await client.callTool(
        { name, arguments: args },
        requestOptions,
      );
      assert.equal(
        response.isError,
        true,
        `${name} accepted input rejected by its advertised schema: ${JSON.stringify(args)}`,
      );
    }
    const missing = await client.callTool(
      {
        name: "rea_memory_get",
        arguments: { evidence_id: `ev_${"f".repeat(64)}` },
      },
      requestOptions,
    );
    assert.equal(reportedError(missing).code, "EVIDENCE_NOT_FOUND");
    assert.equal(
      (
        await call(client, "rea_memory_get", {
          evidence_id: evidence.evidence_id,
        })
      ).note_count,
      0,
    );
  });
});

test("MCP list and search expose complete pagination without silently losing a saved record", async (t) => {
  const { root, evidence, mutation } = await setup(t);
  await withMemoryServer(root, async (client) => {
    for (const name of ["rea_memory_list", "rea_memory_search"]) {
      const args = name === "rea_memory_search" ? { query: "launcher" } : {};
      const first = await call(client, name, { ...args, limit: 1 });
      assert.equal(first.records.length, 1);
      assert.equal(first.offset, 0);
      assert.equal(first.has_more, true);
      assert.equal(first.next_offset, 1);
      const second = await call(client, name, {
        ...args,
        limit: 1,
        offset: first.next_offset,
      });
      assert.equal(second.records.length, 1);
      assert.equal(second.offset, 1);
      assert.equal(second.has_more, false);
      assert.equal(second.next_offset, null);
      assert.deepEqual(
        [...first.records, ...second.records]
          .map((record) => record.evidence_id)
          .sort(),
        [evidence.evidence_id, mutation.evidence_id].sort(),
      );
      assert.match(second.freshness, /historical/iu);
    }
  });
});

test("oversized canonical evidence yields a bounded MCP handoff with omissions and an intact original bundle", async (t) => {
  const { root, evidence, bytes, bundlePath } = await setup(t, {
    parameterText: `CanonicalWideParameter${"x".repeat(1200 * 1024)}`,
  });
  await withMemoryServer(root, async (client) => {
    const response = await client.callTool(
      {
        name: "rea_memory_get",
        arguments: { evidence_id: evidence.evidence_id },
      },
      requestOptions,
    );
    assert.notEqual(response.isError, true);
    assert.ok(
      Buffer.byteLength(JSON.stringify(response)) < 1024 * 1024,
      "The complete public MCP response, including text and structured content, must stay below 1 MiB.",
    );
    const handoff = response.structuredContent.result;
    assert.equal(handoff.evidence_id, evidence.evidence_id);
    assert.equal(handoff.bundle.path, bundlePath);
    assert.equal(handoff.bundle.integrity.verified, true);
    assert.match(handoff.freshness, /historical.*not.*re-observed/iu);
    assert.equal(handoff.response_bounds.truncated, true);
    assert.ok(handoff.response_bounds.original_json_bytes > 1024 * 1024);
    assert.ok(
      handoff.response_bounds.omitted_fields.length > 0 ||
        handoff.response_bounds.omitted_items.length > 0,
    );
    assert.equal(typeof handoff.response_bounds.complete_data_hint, "string");
    assert.ok(handoff.response_bounds.complete_data_hint.length > 0);
    assert.deepEqual(await readFile(bundlePath), bytes);
  });
});
