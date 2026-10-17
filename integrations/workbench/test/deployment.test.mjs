import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  existsSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import {
  applyDeployment,
  applyRollback,
  createDeployment,
  planDeployment,
  planRollback,
} from "../lib/deployment.mjs";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function fixture(t, client = "cursor", original) {
  const directory = await mkdtemp(join(tmpdir(), "rea-deployment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workbenchRoot = join(directory, "tool");
  // The source fixture is its own checkout boundary; runner temp parents may
  // themselves live in a repository. Memory is deliberately a sibling.
  await mkdir(join(workbenchRoot, ".git"), { recursive: true });
  for (const path of [
    "bin/workbench-mcp.mjs",
    "bin/memory-mcp.mjs",
    "node_modules/rea-agents/scripts/rea.mjs",
  ]) {
    await mkdir(dirname(join(workbenchRoot, path)), { recursive: true });
    await writeFile(
      join(workbenchRoot, path),
      "// fixture: existence only; never executed\n",
    );
  }
  const configPath = join(
    directory,
    "client",
    client === "codex"
      ? "config.toml"
      : client === "hermes"
        ? "config.yaml"
        : "config.json",
  );
  if (original !== undefined) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, original);
  }
  return {
    directory,
    options: {
      client,
      configPath,
      workbenchRoot,
      memoryRoot: join(directory, "private-memory"),
    },
  };
}

const rejected = (code) => (error) => error?.code === code;

test("client generation selects one workflow and preserves explicit paths without reading env values", () => {
  const key = "REA_DEPLOY_TEST_NON_SECRET_SENTINEL";
  process.env[key] = "ambient-value-must-not-be-copied";
  try {
    for (const client of [
      "codex",
      "claude-code",
      "cursor",
      "gemini",
      "hermes",
    ]) {
      const generated = createDeployment({
        client,
        memoryRoot: "/private/rea-memory with spaces",
        workbenchRoot: "/opt/rea tool",
        nodeCommand: "/opt/Node Runtime/node",
        passEnv: [key],
      });
      assert.deepEqual(generated.server_names, ["rea-workbench"]);
      assert.equal(generated.state.host_loaded, "unverified");
      assert.equal(generated.state.configuration_applied, false);
      assert(!JSON.stringify(generated).includes(process.env[key]));
      const config =
        client === "codex"
          ? parseToml(generated.snippet)
          : client === "hermes"
            ? parseYaml(generated.snippet)
            : JSON.parse(generated.snippet);
      const entry = (config.mcp_servers ?? config.mcpServers)["rea-workbench"];
      assert.equal(entry.command, "/opt/Node Runtime/node");
      assert.deepEqual(entry.args, [
        "/opt/rea tool/bin/workbench-mcp.mjs",
        "--memory",
        "/private/rea-memory with spaces",
        "--pass-env",
        key,
      ]);
    }
  } finally {
    delete process.env[key];
  }
});

test("all profile adds workflow and native without a duplicate memory server", () => {
  const result = createDeployment({
    profile: "all",
    memoryRoot: "/private/memory",
  });
  assert.deepEqual(Object.keys(result.configuration.mcpServers), [
    "rea-workbench",
    "rea",
  ]);
  assert(
    result.configuration.mcpServers.rea.args[0].endsWith(
      "node_modules/rea-agents/scripts/rea.mjs",
    ),
  );
  assert.throws(
    () => createDeployment({ memoryRoot: join(sourceRoot, "saved") }),
    rejected("MEMORY_IN_DISTRIBUTION"),
  );
  assert.throws(
    () =>
      createDeployment({
        memoryRoot: join(sourceRoot, "..", "..", "saved-evidence"),
      }),
    rejected("MEMORY_IN_DISTRIBUTION"),
  );
  assert.throws(
    () => createDeployment({ memoryRoot: "relative" }),
    rejected("ABSOLUTE_PATH_REQUIRED"),
  );
  assert.throws(
    () =>
      createDeployment({
        memoryRoot: "/private/memory",
        passEnv: ["TOKEN=value"],
      }),
    rejected("INVALID_ENVIRONMENT_NAME"),
  );
  assert.throws(
    () =>
      createDeployment({
        memoryRoot: "/private/memory",
        targetRoot: "/selected/target",
      }),
    rejected("INVALID_OPTION"),
  );
});

test("container config matches the isolated stdio entrypoint and carries no ambient secret values", () => {
  const result = createDeployment({
    client: "codex",
    runtime: "container",
    targetRoot: "/private/target with spaces",
    evidenceVolume: "rea-evidence-woop",
    image: "rea-workbench:local",
    passEnv: ["GHIDRA_INSTALL_DIR"],
  });
  const entry = result.configuration.mcp_servers["rea-workbench"];
  assert.equal(entry.command, "docker");
  assert(entry.args.includes("-i"));
  assert(!entry.args.includes("-t"));
  assert(entry.args.includes("--init"));
  assert.deepEqual(
    entry.args.slice(
      entry.args.indexOf("--network"),
      entry.args.indexOf("--network") + 2,
    ),
    ["--network", "none"],
  );
  assert(
    entry.args.includes(
      "type=bind,src=/private/target with spaces,dst=/targets,readonly",
    ),
  );
  assert(
    entry.args.includes("type=volume,src=rea-evidence-woop,dst=/evidence"),
  );
  assert.deepEqual(entry.args.slice(-5), [
    "mcp",
    "--memory",
    "/evidence",
    "--pass-env",
    "GHIDRA_INSTALL_DIR",
  ]);
  assert.throws(
    () =>
      createDeployment({
        runtime: "container",
        targetRoot: "/target",
        evidenceVolume: "v",
        memoryRoot: "/memory",
      }),
    rejected("EVIDENCE_MOUNT_REQUIRED"),
  );
  assert.throws(
    () =>
      createDeployment({
        runtime: "container",
        targetRoot: "/target",
        memoryRoot: "/target/memory",
      }),
    rejected("OVERLAPPING_MOUNTS"),
  );
});

test("JSONC apply is additive, private, idempotent, and restores original bytes", async (t) => {
  const secret = "unrelated-existing-credential-do-not-copy";
  const original = `// user comment\r\n{\r\n  "theme": "dark",\r\n  "credential": "${secret}",\r\n  "mcpServers": { "other": {"command":"node", "args":["other.mjs"]}, /* trailing */ },\r\n}\r\n`;
  const { options } = await fixture(t, "cursor", original);
  await chmod(options.configPath, 0o640);
  const planned = await planDeployment(options);
  assert(!JSON.stringify(planned).includes(secret));
  assert.equal(await readFile(options.configPath, "utf8"), original);
  const applied = await applyDeployment(planned);
  const candidate = await readFile(options.configPath, "utf8");
  assert.equal(parseJsonc(candidate).credential, secret);
  assert(candidate.includes("// user comment\r\n"));
  assert(candidate.includes("/* trailing */"));
  assert.equal((await lstat(options.configPath)).mode & 0o777, 0o640);
  const receipt = await readFile(applied.receipt_path, "utf8");
  assert(!receipt.includes(secret));
  assert.equal((await lstat(applied.receipt_path)).mode & 0o777, 0o600);
  assert.equal(applied.state.host_loaded, "unverified");
  const repeated = await applyDeployment(await planDeployment(options));
  assert.equal(repeated.action, "unchanged");
  assert.equal(repeated.receipt_path, null);
  const rolled = await applyRollback(
    await planRollback({
      configPath: options.configPath,
      receiptPath: applied.receipt_path,
    }),
  );
  assert.equal(rolled.action, "restored");
  assert.equal(await readFile(options.configPath, "utf8"), original);
  assert.equal(
    (
      await planRollback({
        configPath: options.configPath,
        receiptPath: applied.receipt_path,
      })
    ).action,
    "already-restored",
  );
});

test("empty client files and new configuration paths round-trip exactly in all three formats", async (t) => {
  for (const client of ["cursor", "codex", "hermes", "openclaw"]) {
    for (const original of [undefined, "", "   \n"]) {
      const { options } = await fixture(t, client, original);
      const applied = await applyDeployment(await planDeployment(options));
      assert.equal(applied.action, "applied");
      await applyRollback(
        await planRollback({
          configPath: options.configPath,
          receiptPath: applied.receipt_path,
        }),
      );
      if (original === undefined)
        await assert.rejects(
          readFile(options.configPath),
          (error) => error.code === "ENOENT",
        );
      else assert.equal(await readFile(options.configPath, "utf8"), original);
    }
  }
});

test("Codex TOML preserves multiline strings, comments, integers, and unrelated server settings", async (t) => {
  const original =
    '# my settings\nlabel = """A string\n[mcp_servers.fake]\nkept verbatim"""\nlarge = 9223372036854775807\n[mcp_servers."other tool"]\ncommand = "node"\nargs = ["x"] # keep\n';
  const { options } = await fixture(t, "codex", original);
  const applied = await applyDeployment(await planDeployment(options));
  const candidate = await readFile(options.configPath, "utf8");
  assert(candidate.startsWith(original));
  const actual = parseToml(candidate, { integersAsBigInt: "asNeeded" });
  assert.equal(actual.large, 9223372036854775807n);
  assert.equal(actual.mcp_servers["other tool"].command, "node");
  await applyRollback(
    await planRollback({
      configPath: options.configPath,
      receiptPath: applied.receipt_path,
    }),
  );
  assert.equal(await readFile(options.configPath, "utf8"), original);
});

test("inline TOML mapping refuses an incompatible append without rewriting user data", async (t) => {
  const original = 'mcp_servers = { other = {command="node"} }\n';
  const { options } = await fixture(t, "codex", original);
  await assert.rejects(
    planDeployment(options),
    rejected("CONFIG_EXTENSION_CONFLICT"),
  );
  assert.equal(await readFile(options.configPath, "utf8"), original);
});

test("Hermes YAML block and flow mappings preserve comments, aliases, and document boundaries", async (t) => {
  for (const original of [
    "# profile\nmodel: &model {provider: local}\nalias: *model\nmcp_servers:\n  other:\n    command: node # retain\n# later section\nsetting: true\n",
    "mcp_servers: {other: {command: node}, # trailing comma\n}\nsetting: true\n",
    "mcp_servers: {other: {command: node} # no trailing comma\n}\n",
    "---\nmodel: local\n...\n",
    "# comments only\n",
  ]) {
    const { options } = await fixture(t, "hermes", original);
    const applied = await applyDeployment(await planDeployment(options));
    const parsed = parseYaml(await readFile(options.configPath, "utf8"));
    assert(parsed.mcp_servers["rea-workbench"]);
    if (original.includes("alias:"))
      assert.deepEqual(parsed.alias, parsed.model);
    await applyRollback(
      await planRollback({
        configPath: options.configPath,
        receiptPath: applied.receipt_path,
      }),
    );
    assert.equal(await readFile(options.configPath, "utf8"), original);
  }
});

test("OpenClaw inserts mcp.servers without modifying other mcp options", async (t) => {
  const original = '{"mcp":{"existingOption":true},"gateway":{"port":18789}}\n';
  const { options } = await fixture(t, "openclaw", original);
  const applied = await applyDeployment(await planDeployment(options));
  const actual = JSON.parse(await readFile(options.configPath, "utf8"));
  assert.equal(actual.mcp.existingOption, true);
  assert.equal(actual.gateway.port, 18789);
  assert(actual.mcp.servers["rea-workbench"]);
  await applyRollback(
    await planRollback({
      configPath: options.configPath,
      receiptPath: applied.receipt_path,
    }),
  );
  assert.equal(await readFile(options.configPath, "utf8"), original);
});

test("different same-name configuration and identical launches under aliases are explicit conflicts", async (t) => {
  const { options } = await fixture(
    t,
    "cursor",
    '{"mcpServers":{"rea-workbench":{"command":"my-custom-node","args":[]}}}',
  );
  await assert.rejects(
    planDeployment(options),
    rejected("SERVER_CONFIG_CONFLICT"),
  );
  const desired =
    createDeployment(options).configuration.mcpServers["rea-workbench"];
  await writeFile(
    options.configPath,
    JSON.stringify({ mcpServers: { alias: desired } }),
  );
  await assert.rejects(
    planDeployment(options),
    rejected("DUPLICATE_REGISTRATION"),
  );
});

test("ambiguous, malformed, oversized, and invalid-encoding configurations never reach mutation", async (t) => {
  for (const [client, original, code] of [
    ["cursor", '{"mcpServers":{},"mcpServers":{}}', "DUPLICATE_CONFIG_KEY"],
    ["cursor", '{"secret":"do-not-echo", broken', "CONFIG_PARSE_ERROR"],
    ["codex", 'x="secret"\nx="different"', "CONFIG_PARSE_ERROR"],
    ["hermes", "secret: first\nsecret: second\n", "CONFIG_PARSE_ERROR"],
    [
      "openclaw",
      "{unquoted:'full JSON5 is intentionally unsupported'}",
      "CONFIG_PARSE_ERROR",
    ],
    ["cursor", Buffer.from([0xff, 0xfe]), "INVALID_UTF8"],
    ["cursor", " ".repeat(4 * 1024 * 1024 + 1), "CONFIG_TOO_LARGE"],
  ]) {
    const { options } = await fixture(t, client, original);
    await assert.rejects(planDeployment(options), rejected(code));
    assert.deepEqual(await readFile(options.configPath), Buffer.from(original));
  }
});

test("symlink, hardlink, and lock ownership are respected", async (t) => {
  const { options, directory } = await fixture(t, "cursor", "{}\n");
  const alias = join(directory, "alias.json");
  await symlink(options.configPath, alias);
  await assert.rejects(
    planDeployment({ ...options, configPath: alias }),
    rejected("SYMLINK_PATH"),
  );
  await rm(alias);
  await link(options.configPath, alias);
  await assert.rejects(planDeployment(options), rejected("UNSAFE_FILE_TYPE"));
  await rm(alias);
  const planned = await planDeployment(options);
  await writeFile(`${options.configPath}.rea-workbench.lock`, "other owner");
  await assert.rejects(applyDeployment(planned), rejected("CONFIG_LOCKED"));
  assert.equal(
    await readFile(`${options.configPath}.rea-workbench.lock`, "utf8"),
    "other owner",
  );
  assert.equal(await readFile(options.configPath, "utf8"), "{}\n");
});

test(
  "FIFO configurations and rollback receipts reject promptly without opening a writer",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const kind of ["configuration", "receipt"]) {
      const { options, directory } = await fixture(t, "cursor", "{}\n");
      const fifoPath =
        kind === "configuration"
          ? options.configPath
          : join(directory, "receipt.json");
      if (kind === "configuration") await rm(fifoPath);
      await promisify(execFile)("mkfifo", [fifoPath], { timeout: 2000 });
      const args =
        kind === "configuration"
          ? [
              "plan",
              "--client",
              options.client,
              "--config",
              options.configPath,
              "--workbench-root",
              options.workbenchRoot,
              "--memory",
              options.memoryRoot,
            ]
          : ["rollback", "--config", options.configPath, "--receipt", fifoPath];
      // A subprocess deadline terminates the owned reader if a regression blocks
      // inside open; the test runner itself never opens or writes the FIFO.
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          [join(sourceRoot, "bin", "deploy.mjs"), ...args],
          { timeout: 5000, killSignal: "SIGKILL" },
        ),
        (error) => {
          assert.equal(
            error.killed,
            false,
            `${kind} must reject without reaching its process deadline`,
          );
          assert.equal(error.code, 1);
          assert.equal(error.stdout, "");
          assert.equal(JSON.parse(error.stderr).error.code, "UNSAFE_FILE_TYPE");
          return true;
        },
      );
      assert((await lstat(fifoPath)).isFIFO());
      assert(!existsSync(options.memoryRoot));
      if (kind === "receipt")
        assert.equal(await readFile(options.configPath, "utf8"), "{}\n");
    }
  },
);

test("apply and rollback detect intervening edits and retain the user's newer content", async (t) => {
  const { options } = await fixture(t, "cursor", "{}\n");
  const planned = await planDeployment(options);
  await writeFile(options.configPath, '{"new":"user choice"}\n');
  await assert.rejects(applyDeployment(planned), rejected("CONFIG_CHANGED"));
  const applied = await applyDeployment(await planDeployment(options));
  const updated = `${await readFile(options.configPath, "utf8")}\n// post-install user edit\n`;
  await writeFile(options.configPath, updated);
  await assert.rejects(
    planRollback({
      configPath: options.configPath,
      receiptPath: applied.receipt_path,
    }),
    rejected("ROLLBACK_CONFLICT"),
  );
  assert.equal(await readFile(options.configPath, "utf8"), updated);
});

test("post-rollback verification detects a concurrent edit or recreated file without claiming restoration", async (t) => {
  for (const original of ["{}\n", undefined]) {
    const { options } = await fixture(t, "cursor", original);
    const applied = await applyDeployment(await planDeployment(options));
    const planned = await planRollback({
      configPath: options.configPath,
      receiptPath: applied.receipt_path,
    });
    const concurrent = '{"concurrent_edit":"preserve these bytes"}\n';
    let replaced = false;
    const watcher = watch(dirname(options.configPath), (_event, name) => {
      if (name !== basename(options.configPath) || replaced) return;
      const restored =
        original === undefined
          ? !existsSync(options.configPath)
          : existsSync(options.configPath) &&
            readFileSync(options.configPath, "utf8") === original;
      if (!restored) return;
      replaced = true;
      writeFileSync(options.configPath, concurrent, {
        flag: original === undefined ? "wx" : "w",
      });
    });
    try {
      await assert.rejects(applyRollback(planned), (error) => {
        assert.equal(error.code, "POST_WRITE_CONFLICT");
        assert.equal(error.details.receipt_path, applied.receipt_path);
        return true;
      });
    } finally {
      watcher.close();
    }
    assert(replaced);
    assert.equal(await readFile(options.configPath, "utf8"), concurrent);
    assert(existsSync(applied.receipt_path));
  }
});

test("cleanup preserves a replacement lock owned by a different operation", async (t) => {
  const { options } = await fixture(t, "cursor", "{}\n");
  const planned = await planDeployment(options);
  const lockPath = `${options.configPath}.rea-workbench.lock`;
  let replaced = false;
  const watcher = watch(dirname(options.configPath), (_event, name) => {
    if (name !== basename(lockPath) || replaced || !existsSync(lockPath))
      return;
    replaced = true;
    renameSync(lockPath, `${lockPath}.original-owner`);
    writeFileSync(lockPath, "different lock owner", { flag: "wx" });
  });
  try {
    await assert.rejects(
      applyDeployment(planned),
      rejected("LOCK_OWNERSHIP_LOST"),
    );
  } finally {
    watcher.close();
  }
  assert(replaced);
  assert.equal(await readFile(lockPath, "utf8"), "different lock owner");
});

test("forged rollback metadata cannot remove an unrelated inserted setting", async (t) => {
  const { options, directory } = await fixture(
    t,
    "cursor",
    '{"unrelated":"keep this setting"}\n',
  );
  const applied = await applyDeployment(await planDeployment(options));
  const receipt = JSON.parse(await readFile(applied.receipt_path, "utf8"));
  const current = await readFile(options.configPath, "utf8");
  // The forged inverse would erase the entire current config. Digest checks
  // alone are insufficient; replay must prove that only REA entries were added.
  receipt.original.existed = true;
  receipt.original.sha256 = createHash("sha256").update("").digest("hex");
  receipt.insertions = [{ offset: 0, text: current }];
  const forged = join(directory, "forged.json");
  await writeFile(forged, JSON.stringify(receipt));
  await assert.rejects(
    planRollback({ configPath: options.configPath, receiptPath: forged }),
    rejected("INVALID_RECEIPT"),
  );
  assert.equal(await readFile(options.configPath, "utf8"), current);
});

test("apply requires actual local launcher files and does not install dependencies", async (t) => {
  const { options } = await fixture(t, "cursor", "{}\n");
  await rm(join(options.workbenchRoot, "bin", "workbench-mcp.mjs"));
  const planned = await planDeployment(options);
  assert(planned.prerequisites.some((item) => item.status === "missing"));
  await assert.rejects(
    applyDeployment(planned),
    rejected("MISSING_PREREQUISITE"),
  );
  assert.equal(await readFile(options.configPath, "utf8"), "{}\n");
});

test("Claude plugin resolves its launcher inside the portable root and requires external memory", async () => {
  const manifest = JSON.parse(
    await readFile(join(sourceRoot, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const configuration = JSON.parse(
    await readFile(join(sourceRoot, ".mcp.json"), "utf8"),
  );
  const pkg = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "rea-workbench");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.userConfig.memory_directory.required, true);
  assert.deepEqual(Object.keys(configuration.mcpServers), ["rea-workbench"]);
  assert.deepEqual(configuration.mcpServers["rea-workbench"].args, [
    "${CLAUDE_PLUGIN_ROOT}/bin/workbench-mcp.mjs",
    "--memory",
    "${user_config.memory_directory}",
  ]);
  assert(!("hooks" in manifest));
  assert(!JSON.stringify(configuration).includes("../"));
});

test("actual deploy CLI stays read-only by default, applies explicitly, and restores through its receipt", async (t) => {
  const secret = "private-existing-cli-setting";
  const original = JSON.stringify({ credential: secret });
  const { options } = await fixture(t, "codex");
  options.client = "cursor";
  await mkdir(dirname(options.configPath), { recursive: true });
  await writeFile(options.configPath, original);
  const run = async (args) => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [join(sourceRoot, "bin", "deploy.mjs"), ...args],
      { timeout: 15000 },
    );
    assert(!stdout.includes(secret));
    assert(!stderr.includes(secret));
    return JSON.parse(stdout);
  };
  const args = [
    "plan",
    "--client",
    options.client,
    "--config",
    options.configPath,
    "--workbench-root",
    options.workbenchRoot,
    "--memory",
    options.memoryRoot,
  ];
  assert.equal((await run(args)).state.configuration_applied, false);
  assert.equal(await readFile(options.configPath, "utf8"), original);
  const applied = await run([...args, "--apply"]);
  assert.equal(applied.state.configuration_applied, true);
  assert.equal(applied.state.host_loaded, "unverified");
  const rollback = [
    "rollback",
    "--config",
    options.configPath,
    "--receipt",
    applied.receipt_path,
  ];
  assert.equal((await run(rollback)).state.configuration_applied, false);
  assert.equal((await run([...rollback, "--apply"])).action, "restored");
  assert.equal(await readFile(options.configPath, "utf8"), original);
});
