#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { verifyPackage } from "../lib/package-integrity.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--directory" || !isAbsolute(args[1]))
  throw new Error(
    "Usage: npm run test:plugin -- --directory /absolute/package-directory",
  );
const root = await realpath(args[1]);
const integrity = await verifyPackage(root);
const require = createRequire(join(root, "package.json"));
for (const name of [
  "rea-agents/package.json",
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/client",
])
  assert.ok(
    !relative(root, await realpath(require.resolve(name))).startsWith(".."),
    `Dependency must resolve inside the relocated package: ${name}`,
  );
const portable = JSON.parse(await readFile(join(root, "mcp.json"), "utf8"));
const compatibility = JSON.parse(
  await readFile(join(root, ".mcp.json"), "utf8"),
);
const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
assert.equal(manifest.version, integrity.version);
const directory = await mkdtemp(join(tmpdir(), "rea-plugin-smoke-"));
const data = join(directory, "plugin-data");
const memory = join(data, "memory");
await mkdir(data);
const requests = {
  timeout: 90000,
  maxTotalTimeout: 90000,
  resetTimeoutOnProgress: false,
};
let completed = false;
try {
  const checks = [];
  for (const [format, config, variables] of [
    [
      "agent-plugins-1.0.0",
      portable.mcpServers["rea-workbench"],
      { PLUGIN_ROOT: root, PLUGIN_DATA: data },
    ],
    [
      "claude-compatibility",
      compatibility.mcpServers["rea-workbench"],
      { CLAUDE_PLUGIN_ROOT: root, "user_config.memory_directory": memory },
    ],
  ]) {
    // Model the documented single-pass substitution, without a shell or eval.
    const expand = (value) =>
      value.replace(/\$\{([^}]+)\}/g, (whole, key) => variables[key] ?? whole);
    assert.equal(config.command, "node");
    const client = new Client(
      { name: "rea-plugin-package-smoke", version: "1" },
      { enforceStrictCapabilities: true },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: config.args.map(expand),
      cwd: config.cwd ? expand(config.cwd) : root,
      stderr: "pipe",
      maxBufferSize: 1024 * 1024,
    });
    let stderr = "";
    transport.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    try {
      await client.connect(transport, requests);
      assert.deepEqual(client.getServerVersion(), {
        name: "rea-workbench",
        version: integrity.version,
      });
      const tools = await client.listTools(undefined, requests);
      assert.equal(tools.tools.length, 10);
      assert.ok(
        tools.tools.some((tool) => tool.name === "rea_workbench_analyze_js"),
      );
      const status = await client.callTool(
        { name: "rea_workbench_status", arguments: {} },
        requests,
      );
      assert.notEqual(status.isError, true);
      assert.deepEqual(status.structuredContent.result.server, {
        name: "rea",
        version: "6.5.0",
      });
      assert.equal(status.structuredContent.result.memory_root, memory);
      const records = await client.callTool(
        { name: "rea_memory_list", arguments: {} },
        requests,
      );
      assert.notEqual(records.isError, true);
      assert.deepEqual(records.structuredContent.result.records, []);
      checks.push({
        format,
        server: client.getServerVersion(),
        tools: tools.tools.length,
        upstream: status.structuredContent.result.server,
      });
    } catch (error) {
      if (stderr) error.message += `\nMCP stderr: ${stderr}`;
      throw error;
    } finally {
      await client.close();
      await transport.close();
    }
  }
  assert.equal(
    (await verifyPackage(root)).manifest_sha256,
    integrity.manifest_sha256,
    "Starting both MCP manifest variants must not alter packaged files.",
  );
  process.stdout.write(
    `${JSON.stringify({ status: "passed", package: integrity, checks, scope: "Actual SDK subprocess connections from relocated packaged manifests. Host marketplace installation and native engines are separate and were not exercised." }, null, 2)}\n`,
  );
  completed = true;
} finally {
  await rm(directory, { recursive: true, force: true });
  if (!completed) process.exitCode = 1;
}
