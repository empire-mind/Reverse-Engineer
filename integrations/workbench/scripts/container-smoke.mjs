#!/usr/bin/env node
/** Actual Docker checks: the script fails when Docker is absent or a check fails. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execute = promisify(execFile);
const { values } = parseArgs({
  options: { image: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  process.stdout.write(
    "Usage: node scripts/container-smoke.mjs --image LOCAL_OR_DIGEST_PINNED_IMAGE\n" +
      "Requires a working Docker Engine. Creates and removes only labelled test containers, a test volume, and an owned fixture.\n",
  );
  process.exit(0);
}
assert.ok(values.image && !values.image.startsWith("-"), "Pass --image IMAGE");

const owner = randomUUID();
const label = "io.empiremind.rea-workbench.smoke-owner";
const volume = `rea-workbench-smoke-${owner}`;
const directory = await mkdtemp(join(tmpdir(), "rea-workbench-container-"));
const target = join(directory, "selected-app");
const cidFiles = [];
const checks = [];
const requestOptions = { timeout: 120_000, maxTotalTimeout: 120_000 };
let createdVolume = false;

async function docker(args, { timeout = 120_000 } = {}) {
  return execute("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024 });
}

function launchArgs(command, { mountTarget = false, entrypoint } = {}) {
  const cidFile = join(directory, `container-${cidFiles.length}.cid`);
  cidFiles.push(cidFile);
  return [
    "run",
    "--rm",
    "--init",
    "--interactive",
    "--cidfile",
    cidFile,
    "--label",
    `${label}=${owner}`,
    "--read-only",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=1g,mode=1777",
    "--mount",
    `type=volume,source=${volume},target=/evidence`,
    ...(mountTarget
      ? ["--mount", `type=bind,source=${target},target=/targets,readonly`]
      : []),
    ...(entrypoint ? ["--entrypoint", entrypoint] : []),
    values.image,
    ...command,
  ];
}

async function cli(args) {
  const { stdout } = await docker(launchArgs(["cli", ...args]));
  return JSON.parse(stdout);
}

async function withMcp(mode, mountTarget, action) {
  const client = new Client(
    { name: "rea-container-verification", version: "1" },
    { enforceStrictCapabilities: true },
  );
  const transport = new StdioClientTransport({
    command: "docker",
    args: launchArgs(mode, { mountTarget }),
    stderr: "pipe",
    maxBufferSize: 16 * 1024 * 1024,
  });
  let stderr = "";
  transport.stderr.on("data", (bytes) => {
    stderr = `${stderr}${bytes}`.slice(-64 * 1024);
  });
  let failed;
  try {
    await client.connect(transport, requestOptions);
    return await action(client);
  } catch (error) {
    failed = error;
    if (stderr) error.message += `\nContainer stderr: ${stderr}`;
    throw error;
  } finally {
    const errors = [];
    try {
      await client.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await transport.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(
        failed ? [failed, ...errors] : errors,
        "MCP invocation cleanup failed",
      );
    }
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
  assert.ok(
    response.structuredContent &&
      Object.hasOwn(response.structuredContent, "result"),
  );
  return response.structuredContent.result;
}

async function catalog(client) {
  const tools = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 64; page++) {
    const response = await client.listTools(
      cursor ? { cursor } : undefined,
      requestOptions,
    );
    tools.push(...response.tools);
    if (!response.nextCursor) return tools;
    assert.ok(!seen.has(response.nextCursor), "MCP pagination cursor repeated");
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error("MCP catalog exceeded 64 pages");
}

async function savedBundle(path) {
  const program = `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const bytes = fs.readFileSync(process.argv[1]);
    console.log(JSON.stringify({
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length
    }));
  `;
  const { stdout } = await docker(
    launchArgs(["-e", program, path], { entrypoint: "node" }),
  );
  return JSON.parse(stdout);
}

async function cleanup() {
  const errors = [];
  for (const cidFile of cidFiles) {
    let cid;
    try {
      cid = (await readFile(cidFile, "utf8")).trim();
    } catch (error) {
      if (error.code === "ENOENT") continue;
      errors.push(error);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(cid)) {
      errors.push(new Error(`Invalid owned container ID in ${cidFile}`));
      continue;
    }
    try {
      const { stdout } = await docker([
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `id=${cid}`,
      ]);
      if (!stdout.split(/\s+/).includes(cid)) continue;
      const inspected = JSON.parse(
        (
          await docker([
            "container",
            "inspect",
            "--format",
            `{"Id":{{json .Id}},"owner":{{json (index .Config.Labels "${label}")}}}`,
            cid,
          ])
        ).stdout,
      );
      assert.equal(inspected.Id, cid);
      assert.equal(
        inspected.owner,
        owner,
        "Refuse to remove a container with a different owner label",
      );
      await docker(["container", "rm", "--force", cid]);
    } catch (error) {
      errors.push(error);
    }
  }
  if (createdVolume) {
    try {
      const inspected = JSON.parse(
        (
          await docker([
            "volume",
            "inspect",
            "--format",
            `{"Name":{{json .Name}},"owner":{{json (index .Labels "${label}")}}}`,
            volume,
          ])
        ).stdout,
      );
      assert.equal(inspected.Name, volume);
      assert.equal(
        inspected.owner,
        owner,
        "Refuse to remove a volume with a different owner label",
      );
      await docker(["volume", "rm", volume]);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Container verification cleanup failed; owned resource IDs remain in the diagnostic directory",
    );
  await rm(directory, { recursive: true, force: true });
}

let failure;
let report;
try {
  await docker(["version", "--format", "{{json .Server.Version}}"]);
  await mkdir(join(target, "src"), { recursive: true, mode: 0o755 });
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({
      name: "owned-rea-container-fixture",
      version: "0.0.0",
      type: "module",
      main: "src/main.mjs",
    }),
    { mode: 0o644 },
  );
  await writeFile(
    join(target, "src/main.mjs"),
    'import { greeting } from "./helper.mjs";\nexport const welcome = name => greeting + name;\n',
    { mode: 0o644 },
  );
  await writeFile(
    join(target, "src/helper.mjs"),
    'export const greeting = "Hello ";\n',
    { mode: 0o644 },
  );
  await docker(["volume", "create", "--label", `${label}=${owner}`, volume]);
  createdVolume = true;

  const inspected = JSON.parse(
    (
      await docker([
        "image",
        "inspect",
        "--format",
        '{"Id":{{json .Id}},"User":{{json .Config.User}},"Entrypoint":{{json .Config.Entrypoint}},"Os":{{json .Os}},"Architecture":{{json .Architecture}}}',
        values.image,
      ])
    ).stdout,
  );
  assert.equal(inspected.User, "1000:1000");
  assert.deepEqual(inspected.Entrypoint, [
    "/opt/rea-workbench/scripts/container-entrypoint.sh",
  ]);
  const probeProgram = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const { execFileSync } = require('node:child_process');
    assert.equal(process.getuid(), 1000);
    assert.equal(process.version, 'v24.22.0');
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    assert.match(status, /^CapEff:\\s+0+$/m);
    assert.match(status, /^NoNewPrivs:\\s+1$/m);
    assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\\n').map(line => line.split(' '));
    for (const path of ['/', '/targets']) {
      assert.ok(mounts.find(fields => fields[4] === path)?.[5].split(',').includes('ro'), path + ' must be mounted read-only');
    }
    assert.ok(mounts.find(fields => fields[4] === '/evidence')?.[5].split(',').includes('rw'));
    assert.ok(mounts.find(fields => fields[4] === '/tmp')?.[5].split(',').includes('noexec'));
    assert.equal(fs.existsSync('/var/run/docker.sock'), false);
    assert.throws(() => fs.writeFileSync('/opt/rea-workbench/root-probe', 'x'), /EROFS|EACCES/);
    assert.throws(() => fs.writeFileSync('/targets/source-probe', 'x'), /EROFS|EACCES/);
    fs.writeFileSync('/tmp/temp-probe', 'temporary');
    fs.writeFileSync('/evidence/volume-probe', 'persistent');
    const ps = execFileSync('ps', ['--version'], { encoding: 'utf8' }).trim();
    assert.match(ps, /procps/);
    execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,uid=,stat=,command=']);
    console.log(JSON.stringify({ uid: process.getuid(), node: process.version, ps,
      network_interfaces: Object.keys(os.networkInterfaces()), read_only_root: true,
      read_only_target: true, evidence_writable: true, capabilities_empty: true,
      no_new_privileges: true }));
  `;
  const hardened = JSON.parse(
    (
      await docker(
        launchArgs(["-e", probeProgram], {
          mountTarget: true,
          entrypoint: "node",
        }),
      )
    ).stdout,
  );
  checks.push(
    "Non-root runtime, writable fresh volume, read-only root/target, procps, no network, capabilities and privilege restrictions",
  );

  const status = await cli(["status"]);
  assert.equal(status.server.version, "6.5.0");
  assert.ok(status.advertised > 0);
  checks.push("Published REA status through container CLI");

  let analyzed;
  const expectedWorkflowTools = [
    "rea_memory_get",
    "rea_memory_list",
    "rea_memory_note",
    "rea_memory_search",
    "rea_memory_verify",
    "rea_workbench_analyze_js",
    "rea_workbench_resume",
    "rea_workbench_status",
    "rea_workbench_tool_schema",
    "rea_workbench_tools",
  ].sort();
  await withMcp(["mcp", "--memory", "/evidence"], true, async (client) => {
    assert.equal(client.getServerVersion().name, "rea-workbench");
    assert.deepEqual(
      (await catalog(client)).map((tool) => tool.name).sort(),
      expectedWorkflowTools,
    );
    const live = await call(client, "rea_workbench_status");
    assert.equal(live.server.version, "6.5.0");
    analyzed = await call(client, "rea_workbench_analyze_js", {
      target: "/targets",
      source_paths: ["src/main.mjs"],
      question:
        "Inspect the selected launcher import in this owned container fixture",
    });
    assert.equal(analyzed.status, "retained");
    assert.match(analyzed.evidence_id, /^ev_[a-f0-9]{64}$/);
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
  });
  checks.push(
    "Unified workflow MCP: handshake, named discovery, live selected-source analysis, export and importer-validated retention",
  );
  const retained = await savedBundle(analyzed.memory.bundlePath);
  assert.equal(`sha256_${retained.sha256}`, analyzed.memory.bundleId);

  // Every subsequent container omits the target mount: only historical evidence is available.
  await withMcp(
    ["memory-mcp", "--memory", "/evidence"],
    false,
    async (client) => {
      assert.equal(client.getServerVersion().name, "rea-investigation-memory");
      assert.deepEqual(
        (await catalog(client)).map((tool) => tool.name).sort(),
        expectedWorkflowTools.filter((name) => name.startsWith("rea_memory_")),
      );
      const listed = await call(client, "rea_memory_list", { limit: 100 });
      assert.ok(
        listed.records.some(
          (record) => record.evidence_id === analyzed.evidence_id,
        ),
      );
      await call(client, "rea_memory_note", {
        evidence_id: analyzed.evidence_id,
        text: "ContainerPersistenceZebra is a separate analyst note.",
      });
      const searched = await call(client, "rea_memory_search", {
        query: "ContainerPersistenceZebra",
      });
      assert.equal(searched.records[0].evidence_id, analyzed.evidence_id);
      const shown = await call(client, "rea_memory_get", {
        evidence_id: analyzed.evidence_id,
      });
      assert.equal(shown.bundle.integrity.verified, true);
      assert.equal((await call(client, "rea_memory_verify")).ok, true);
    },
  );
  checks.push(
    "Standalone memory MCP: all five tools operate on evidence retained by a previous container",
  );

  await withMcp(["mcp", "--memory", "/evidence"], false, async (client) => {
    const resumed = await call(client, "rea_workbench_resume", {
      evidence_id: analyzed.evidence_id,
    });
    assert.equal(resumed.status, "resumed");
    assert.equal(resumed.evidence_id, analyzed.evidence_id);
    assert.ok(resumed.successful_checks.includes("import_evidence_bundle"));
    assert.ok(resumed.successful_checks.includes("inspect_analysis_view"));
    assert.ok(
      !resumed.successful_checks.includes("analyze_javascript_application"),
    );
  });
  assert.deepEqual(await savedBundle(analyzed.memory.bundlePath), retained);
  assert.equal((await cli(["memory", "verify"])).ok, true);
  checks.push(
    "Fresh workflow MCP container resumes without target access or reanalysis; exact bundle bytes unchanged",
  );

  await withMcp(["rea", "mcp"], false, async (client) => {
    assert.equal(client.getServerVersion().name, "rea");
    assert.equal(client.getServerVersion().version, "6.5.0");
    assert.equal((await catalog(client)).length, status.advertised);
  });
  checks.push(
    "Native published REA MCP entrypoint retains its own complete catalog",
  );
  report = {
    ok: true,
    image: values.image,
    image_id: inspected.Id,
    platform: { os: inspected.Os, architecture: inspected.Architecture },
    runtime: hardened,
    advertised_upstream_tools: status.advertised,
    workflow_tools: expectedWorkflowTools.length,
    retained_bundle: retained,
    checks,
    limitations: [
      "Owned selected JavaScript fixture only; no customer target or native decompiler was tested.",
      "This run proves only the reported image platform and host.",
      "No native client registration or remote MCP service was performed.",
    ],
  };
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanup();
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Container checks and cleanup failed",
        )
      : error;
  }
}
if (failure) {
  process.stderr.write(`${failure.stack ?? failure}\n`);
  if (failure instanceof AggregateError)
    for (const error of failure.errors)
      process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
} else {
  report.cleanup =
    "All owned test containers, the test volume and fixture were removed";
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
