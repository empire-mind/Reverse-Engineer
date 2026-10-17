// Deliberately small MCP 2025 wire fixture. Production uses the official client
// SDK; this fixture exercises transport boundaries without a native provider.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const mode = process.argv[2];
const sessionId = randomUUID();
let records = [];
let calls = 0;
const schema = (properties) => ({
  type: "object",
  properties,
  additionalProperties: false,
});
const outputSchema = {
  type: "object",
  properties: { result: {} },
  required: ["result"],
  additionalProperties: false,
};
const tools = [
  {
    name: "binary_session",
    inputSchema: schema({ expected_package_version: { type: "string" } }),
    outputSchema,
  },
  {
    name: "observe_fixture",
    inputSchema: {
      ...schema({ value: { type: "integer" } }),
      required: ["value"],
    },
    outputSchema,
  },
  {
    name: "export_evidence_bundle",
    inputSchema: {
      ...schema({ path: { type: "string" }, overwrite: { type: "boolean" } }),
      required: ["path"],
    },
    outputSchema,
  },
  {
    name: "import_evidence_bundle",
    inputSchema: {
      ...schema({ path: { type: "string" } }),
      required: ["path"],
    },
    outputSchema,
  },
  { name: "get_evidence_bundle", inputSchema: schema({}), outputSchema },
  { name: "fail_fixture", inputSchema: schema({}), outputSchema },
  {
    name: "bad_output",
    inputSchema: schema({}),
    outputSchema: {
      ...schema({ count: { type: "integer" } }),
      required: ["count"],
    },
  },
  { name: "stall_fixture", inputSchema: schema({}) },
  { name: "oversize_fixture", inputSchema: schema({}) },
];

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify({ result }) }],
    structuredContent: { result },
    _meta: { fixture: true },
  };
}

if (mode === "stderr")
  process.stderr.write(`${"x".repeat(8192)}fixture stderr tail\n`);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === "initialize") {
    send(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: {
        name: "rea",
        version: mode === "wrong-version" ? "6.4.0" : "6.5.0",
      },
    });
    continue;
  }
  if (request.method === "tools/list") {
    if (mode === "endless-pages") {
      send(request.id, {
        tools: [],
        nextCursor: `${Number(request.params?.cursor ?? 0) + 1}`,
      });
    } else if (mode === "duplicate-tools") {
      send(request.id, { tools: [tools[0], tools[0]] });
    } else {
      send(
        request.id,
        request.params?.cursor === "second"
          ? { tools: tools.slice(4) }
          : { tools: tools.slice(0, 4), nextCursor: "second" },
      );
    }
    continue;
  }
  if (request.method !== "tools/call") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown fixture method" } })}\n`,
    );
    continue;
  }
  calls += 1;
  const { name, arguments: args } = request.params;
  switch (name) {
    case "binary_session":
      send(
        request.id,
        toolResult({
          open: false,
          tool_availability: {
            groups: [
              {
                names: tools.map((tool) => tool.name),
                surface: "session",
                available: true,
                reason: "available",
                remediation: null,
              },
            ],
          },
          fixture: { sessionId, calls, recordCount: records.length },
        }),
      );
      break;
    case "observe_fixture":
      records.push({ value: args.value, sessionId });
      send(request.id, toolResult(records.at(-1)));
      break;
    case "get_evidence_bundle":
      send(request.id, toolResult({ records, sessionId }));
      break;
    case "export_evidence_bundle":
      try {
        await writeFile(args.path, JSON.stringify({ records, sessionId }), {
          flag: args.overwrite ? "w" : "wx",
        });
        send(
          request.id,
          toolResult({ path: args.path, records: records.length, sessionId }),
        );
      } catch (error) {
        send(request.id, {
          ...toolResult({ code: error.code, partial: records }),
          isError: true,
        });
      }
      break;
    case "import_evidence_bundle":
      records.push(...JSON.parse(await readFile(args.path, "utf8")).records);
      send(request.id, toolResult({ records: records.length, sessionId }));
      break;
    case "fail_fixture":
      send(request.id, {
        ...toolResult({ reason: "fixture-failure", partial: records }),
        isError: true,
      });
      break;
    case "bad_output":
      send(request.id, {
        content: [],
        structuredContent: { count: "invalid" },
      });
      break;
    case "stall_fixture":
      break;
    case "oversize_fixture":
      send(request.id, {
        content: [{ type: "text", text: "x".repeat(100_000) }],
      });
      break;
  }
}
if (process.env.WORKBENCH_FIXTURE_CLOSED_PATH)
  await writeFile(process.env.WORKBENCH_FIXTURE_CLOSED_PATH, "closed\n");
