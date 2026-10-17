import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { parse } from "yaml";
import {
  INTEGRITY_FILE,
  packageInventory,
  sha256,
  verifyPackage,
} from "../lib/package-integrity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

test("portable manifests validate against the unmodified published Agent Plugins 1.0.0 schemas", async () => {
  const source = await json(
    join(root, "test/fixtures/plugin-schemas/SOURCE.json"),
  );
  const validator = new AjvJsonSchemaValidator();
  for (const entry of source.files) {
    const bytes = await readFile(
      join(root, "test/fixtures/plugin-schemas", entry.path),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
    );
    const schema = JSON.parse(bytes);
    const document = await json(join(root, entry.path.replace(".schema", "")));
    assert.equal(schema.$id, document.$schema);
    const result = validator.getValidator(schema)(document);
    assert.equal(result.valid, true, JSON.stringify(result));
  }
});

test("plugin identities, one workflow registration, bundled skill and marketplace path agree", async () => {
  const packageJson = await json(join(root, "package.json"));
  const portable = await json(join(root, "plugin.json"));
  const claude = await json(join(root, ".claude-plugin/plugin.json"));
  for (const manifest of [portable, claude]) {
    assert.equal(manifest.name, packageJson.name);
    assert.equal(manifest.version, packageJson.version);
  }
  assert.equal(portable.extensions["com.openai"].requires_local_executor, true);
  for (const name of ["mcp.json", ".mcp.json"]) {
    const config = await json(join(root, name));
    assert.deepEqual(Object.keys(config.mcpServers), ["rea-workbench"]);
    assert.equal(config.mcpServers["rea-workbench"].command, "node");
  }
  assert.equal(claude.userConfig.memory_directory.required, true);
  const skill = await readFile(
    join(root, "skills/rea-workbench/SKILL.md"),
    "utf8",
  );
  const header = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(skill);
  assert.ok(header, "Skill must have complete YAML frontmatter");
  const frontmatter = parse(header[1]);
  assert.equal(frontmatter.name, "rea-workbench");
  assert.ok(
    frontmatter.description.length > 0 &&
      frontmatter.description.length <= 1024,
  );
  assert.ok(skill.split("\n").length <= 500);
  const marketplace = await json(
    join(root, "../../.agents/plugins/marketplace.json"),
  );
  assert.ok(
    marketplace.plugins.some(
      (entry) =>
        entry.name === packageJson.name &&
        entry.source.source === "local" &&
        entry.source.path === "./integrations/workbench",
    ),
  );
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"])
    assert.equal(
      packageJson.scripts[lifecycle],
      undefined,
      "Host installation must not execute unrequested hooks",
    );
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "rea-package-integrity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "package");
  await mkdir(root);
  await writeFile(
    join(root, "package.json"),
    '{"name":"rea-workbench","version":"test"}\n',
  );
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(root, "main.mjs"), "export const value = 1;\n");
  return { directory, root };
}

async function seal(root) {
  await writeFile(
    join(root, INTEGRITY_FILE),
    JSON.stringify({
      format: "rea-workbench-package-1",
      version: "test",
      lock_sha256: await sha256(join(root, "package-lock.json")),
      files: await packageInventory(root),
    }),
  );
}

test("package verification detects changed bytes and extra files while supporting relocatable internal links", async (t) => {
  const { root } = await fixture(t);
  if (process.platform !== "win32")
    await symlink("main.mjs", join(root, "entry.mjs"));
  await seal(root);
  assert.equal((await verifyPackage(root)).status, "verified");
  await writeFile(join(root, "main.mjs"), "export const value = 2;\n");
  await assert.rejects(verifyPackage(root), /differ/);
  await writeFile(join(root, "main.mjs"), "export const value = 1;\n");
  await writeFile(join(root, "unexpected.json"), "{}\n");
  await assert.rejects(verifyPackage(root), /differ/);
});

test(
  "package inventory refuses links outside the distribution",
  { skip: process.platform === "win32" },
  async (t) => {
    const { directory, root } = await fixture(t);
    await writeFile(
      join(directory, "external.mjs"),
      "export const value = 3;\n",
    );
    await symlink("../external.mjs", join(root, "escape.mjs"));
    await assert.rejects(packageInventory(root), /escapes/);
  },
);

test(
  "package links cannot leave and return through an external link or the old root name",
  { skip: process.platform === "win32" },
  async (t) => {
    const { directory, root } = await fixture(t);
    await mkdir(join(directory, "external"));
    await symlink("../package/main.mjs", join(directory, "external/back.mjs"));
    await symlink("../external/back.mjs", join(root, "entry.mjs"));
    await assert.rejects(packageInventory(root), /escapes/);
    await rm(join(root, "entry.mjs"));
    await symlink("../package/main.mjs", join(root, "entry.mjs"));
    await assert.rejects(packageInventory(root), /escapes/);
  },
);

test(
  "package integrity distinguishes owner, group and other execution bits",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root } = await fixture(t);
    await chmod(join(root, "main.mjs"), 0o700);
    await seal(root);
    assert.equal((await verifyPackage(root)).status, "verified");
    await chmod(join(root, "main.mjs"), 0o601);
    await assert.rejects(verifyPackage(root), /executable bits/);
  },
);
