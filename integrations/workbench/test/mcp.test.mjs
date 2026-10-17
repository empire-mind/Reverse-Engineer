import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReaClient,
  ReaToolError,
  summarizeCapabilities,
  withRea,
} from "../lib/mcp.mjs";

const fixture = fileURLToPath(
  new URL("./fixtures/mcp/server.mjs", import.meta.url),
);
const options = (mode, extra = {}) => ({
  launcher: {
    command: process.execPath,
    args: [fixture, ...(mode ? [mode] : [])],
  },
  timeoutMs: 2000,
  ...extra,
});
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "rea-mcp-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("one SDK session preserves evidence across paginated discovery, calls, export, and explicit import", async (t) => {
  const dir = await directory(t);
  const bundle = join(dir, "bundle.json");
  let firstSessionId;
  let firstClient;
  await withRea(async (client) => {
    firstClient = client;
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 9);
    assert.equal(catalog.nextCursor, undefined);
    assert.deepEqual(client.successfulTools, []);
    const initial = await client.session();
    firstSessionId = initial.structuredContent.result.fixture.sessionId;
    assert.equal(initial._meta.fixture, true);
    const observed = await client.callTool("observe_fixture", { value: 27 });
    assert.deepEqual(observed.structuredContent.result, {
      value: 27,
      sessionId: firstSessionId,
    });
    const exported = await client.exportBundle(bundle);
    assert.equal(exported.structuredContent.result.sessionId, firstSessionId);
    assert.deepEqual(JSON.parse(await readFile(bundle, "utf8")).records, [
      { value: 27, sessionId: firstSessionId },
    ]);
    await assert.rejects(
      client.exportBundle(bundle),
      (error) =>
        error instanceof ReaToolError &&
        error.result.structuredContent.result.code === "EEXIST",
    );
    assert.equal(
      (await client.callTool("get_evidence_bundle")).structuredContent.result
        .records.length,
      1,
    );
    assert.deepEqual(client.successfulTools, [
      "binary_session",
      "export_evidence_bundle",
      "get_evidence_bundle",
      "observe_fixture",
    ]);
  }, options());
  assert.equal(firstClient.state, "closed");
  await assert.rejects(firstClient.connect(), { code: "REA_CLIENT_CLOSED" });
  await withRea(async (client) => {
    assert.equal(
      (await client.session()).structuredContent.result.fixture.recordCount,
      0,
    );
    const imported = await client.importBundle(bundle);
    assert.notEqual(
      imported.structuredContent.result.sessionId,
      firstSessionId,
    );
    const restored = await client.callTool("get_evidence_bundle");
    assert.deepEqual(restored.structuredContent.result.records, [
      { value: 27, sessionId: firstSessionId },
    ]);
  }, options());
});

test("named input and SDK output schema validation reject mismatches without marking success", async () => {
  await withRea(async (client) => {
    const catalog = await client.listTools();
    // A public catalog edit must not alter the client's named validation boundary.
    catalog.tools.find((tool) => tool.name === "observe_fixture").inputSchema =
      {};
    await assert.rejects(client.callTool("observe_fixture", { value: "27" }), {
      code: "REA_INVALID_TOOL_ARGUMENTS",
    });
    await assert.rejects(client.callTool("not-advertised"), {
      code: "REA_UNKNOWN_TOOL",
    });
    await assert.rejects(client.exportBundle("relative.json"), {
      code: "REA_INVALID_PATH",
    });
    const before = await client.session();
    assert.equal(before.structuredContent.result.fixture.calls, 1);
    await assert.rejects(client.callTool("bad_output"), /output schema/);
    assert.deepEqual(client.successfulTools, ["binary_session"]);
  }, options());
});

test("tool-level failures preserve partial evidence and the original public response", async () => {
  await withRea(async (client) => {
    await client.callTool("observe_fixture", { value: 7 });
    await assert.rejects(client.callTool("fail_fixture"), (error) => {
      assert.ok(error instanceof ReaToolError);
      assert.equal(error.code, "REA_TOOL_ERROR");
      assert.equal(error.toolName, "fail_fixture");
      assert.equal(error.result.isError, true);
      assert.equal(error.result._meta.fixture, true);
      assert.equal(error.result.structuredContent.result.partial[0].value, 7);
      assert.equal(
        JSON.parse(error.result.content[0].text).result.partial[0].value,
        7,
      );
      return true;
    });
    assert.deepEqual(client.successfulTools, ["observe_fixture"]);
  }, options());
});

test("version mismatch closes the owned child and rejects stale startup", async (t) => {
  const dir = await directory(t);
  const closedPath = join(dir, "closed.txt");
  const client = new ReaClient({
    ...options("wrong-version"),
    launcher: {
      command: process.execPath,
      args: [fixture, "wrong-version"],
      env: { WORKBENCH_FIXTURE_CLOSED_PATH: closedPath },
    },
  });
  await assert.rejects(client.connect(), { code: "REA_VERSION_MISMATCH" });
  assert.equal(client.state, "closed");
  assert.equal(await readFile(closedPath, "utf8"), "closed\n");
});

test("callback failures still close the owned process", async (t) => {
  const dir = await directory(t);
  const closedPath = join(dir, "closed.txt");
  let instance;
  const failure = new Error("caller failed");
  await assert.rejects(
    withRea(
      async (client) => {
        instance = client;
        throw failure;
      },
      {
        ...options(),
        launcher: {
          command: process.execPath,
          args: [fixture],
          env: { WORKBENCH_FIXTURE_CLOSED_PATH: closedPath },
        },
      },
    ),
    (error) => error === failure,
  );
  assert.equal(instance.state, "closed");
  assert.equal(await readFile(closedPath, "utf8"), "closed\n");
});

test("non-converging pagination and duplicate named definitions fail discovery", async () => {
  const endless = new ReaClient(
    options("endless-pages", { maxCatalogPages: 2 }),
  );
  await assert.rejects(endless.connect(), /page/i);
  assert.equal(endless.state, "closed");
  const duplicate = new ReaClient(options("duplicate-tools"));
  await assert.rejects(
    duplicate.connect(),
    (error) =>
      error.code === "REA_DUPLICATE_TOOL" && error.result.tools.length === 2,
  );
  assert.equal(duplicate.state, "closed");
});

test("stderr is bounded and response overflow is rejected rather than truncated as evidence", async () => {
  await withRea(
    async (client) => {
      assert.ok(client.diagnostics.stderrBytesObserved > 128);
      assert.equal(client.diagnostics.stderrTruncated, true);
      assert.ok(Buffer.byteLength(client.diagnostics.stderrTail) <= 128);
      assert.match(client.diagnostics.stderrTail, /fixture stderr tail/);
      await assert.rejects(client.callTool("oversize_fixture"));
      assert.ok(client.diagnostics.errorCount > 0);
      assert.deepEqual(client.successfulTools, []);
    },
    options("stderr", { maxStderrBytes: 128, maxMessageBytes: 4096 }),
  );
});

test("tool timeout is bounded and cleanup leaves no reusable silent replacement session", async () => {
  let instance;
  await withRea(
    async (client) => {
      instance = client;
      await assert.rejects(
        client.callTool("stall_fixture"),
        /timeout|timed out/i,
      );
      assert.deepEqual(client.successfulTools, []);
    },
    options(undefined, { timeoutMs: 500 }),
  );
  assert.equal(instance.state, "closed");
});

test("capability summary joins actual group names and preserves omitted/null/false and unlisted reports", () => {
  const names = [
    "yes",
    "target",
    "missing",
    "unavailable",
    "host",
    "omitted",
    "explicit-null",
    "unreported",
  ];
  const groups = [
    {
      names: ["host"],
      available: false,
      reason: "unsupported_host",
      remediation: "macOS required",
    },
    {
      names: ["yes"],
      available: true,
      reason: "available",
      remediation: null,
      surface: "session",
    },
    {
      names: ["target"],
      available: false,
      reason: "target_required",
      modes: [{ name: "explicit_document", available: false }],
    },
    { names: ["missing"], available: false, reason: "provider_missing" },
    {
      names: ["unavailable"],
      available: false,
      reason: "provider_unavailable",
    },
    { names: ["omitted"], reason: null },
    { names: ["explicit-null"], available: null, reason: null },
    { names: ["outside-catalog"], available: true, reason: "available" },
  ];
  const original = {
    content: [],
    structuredContent: {
      result: {
        tool_availability: { groups },
        server_identity: { package: { version: "6.5.0" } },
      },
    },
  };
  const summary = summarizeCapabilities(
    { tools: names.map((name) => ({ name })) },
    original,
  );
  assert.equal(summary.advertisedCount, 8);
  assert.deepEqual(summary.counts, {
    available: 1,
    target_required: 1,
    provider_missing: 1,
    provider_unavailable: 1,
    unsupported_host: 1,
    unknown: 3,
  });
  assert.equal(
    summary.tools.find((tool) => tool.name === "target").available,
    false,
  );
  assert.deepEqual(
    summary.tools.find((tool) => tool.name === "target").modes,
    groups[2].modes,
  );
  assert.equal(
    Object.hasOwn(
      summary.tools.find((tool) => tool.name === "omitted"),
      "available",
    ),
    false,
  );
  assert.equal(
    summary.tools.find((tool) => tool.name === "explicit-null").available,
    null,
  );
  assert.equal(
    Object.hasOwn(
      summary.tools.find((tool) => tool.name === "unreported"),
      "available",
    ),
    false,
  );
  assert.equal(summary.unmatchedAvailability[0].name, "outside-catalog");
  assert.equal(summary.verification.successfulTests, null);
  assert.equal(summary.verification.availability, "server_reported");
  assert.deepEqual(summary.serverIdentity, { package: { version: "6.5.0" } });
  assert.equal(
    original.structuredContent.result.tool_availability.groups[1].names[0],
    "yes",
  );
});

test("missing, failed, or conflicting session reports never become available by assumption", () => {
  assert.equal(summarizeCapabilities([{ name: "x" }], {}).counts.unknown, 1);
  const failed = {
    isError: true,
    structuredContent: {
      result: {
        tool_availability: {
          groups: [{ names: ["x"], available: true, reason: "available" }],
        },
      },
    },
  };
  assert.equal(
    summarizeCapabilities([{ name: "x" }], failed).counts.unknown,
    1,
  );
  const conflicting = {
    tool_availability: {
      groups: [
        { names: ["x"], available: true, reason: "available" },
        { names: ["x"], available: false, reason: "provider_missing" },
      ],
    },
  };
  const result = summarizeCapabilities([{ name: "x" }], conflicting);
  assert.equal(result.counts.unknown, 1);
  assert.equal(result.tools[0].availabilityReports.length, 2);
  assert.equal(Object.hasOwn(result.tools[0], "available"), false);
});
