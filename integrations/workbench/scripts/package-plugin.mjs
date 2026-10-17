#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTEGRITY_FILE,
  packageInventory,
  sha256,
  verifyPackage,
} from "../lib/package-integrity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const entries = [
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "plugin.json",
  "mcp.json",
  ".claude-plugin",
  ".mcp.json",
  "bin",
  "lib",
  "skills",
  "docs",
  "Dockerfile",
  ".dockerignore",
  "compose.yaml",
  "compose.target.yaml",
  "scripts/container-entrypoint.sh",
  "scripts/container-smoke.mjs",
  "scripts/package-plugin.mjs",
  "scripts/verify-package.mjs",
  "scripts/plugin-smoke.mjs",
];

function inside(path, parent) {
  const part = relative(parent, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}

async function copyOwned(source, destination) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink())
    throw new Error(
      `Source package files must not be symlinks: ${relative(root, source)}`,
    );
  if (stat.isDirectory()) {
    await mkdir(destination, { mode: 0o755 });
    for (const name of (await readdir(source)).sort()) {
      if (name === ".git") throw new Error("Git metadata cannot be bundled.");
      await copyOwned(join(source, name), join(destination, name));
    }
  } else if (stat.isFile()) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  } else
    throw new Error(
      `Unsupported source package entry: ${relative(root, source)}`,
    );
}

async function install(directory) {
  const npm = process.env.npm_execpath;
  if (!npm || !isAbsolute(npm))
    throw new Error(
      "Run this builder through npm run package:plugin so the active npm CLI is selected explicitly.",
    );
  // Forward build prerequisites only. Never copy an environment snapshot into the package.
  const env = {};
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "npm_config_cache",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        npm,
        "ci",
        "--ignore-scripts",
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        "--fetch-timeout=30000",
        "--fetch-retries=1",
      ],
      { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.pipe(process.stderr);
    child.stderr.pipe(process.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? accept()
        : reject(
            new Error(
              `Locked package dependency install failed: ${signal ?? code}`,
            ),
          ),
    );
  });
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !isAbsolute(args[1]))
    throw new Error(
      "Usage: npm run package:plugin -- --output /absolute/new-directory (parent must exist). Installs locked dependencies; requires registry access.",
    );
  const source = await realpath(root);
  const requested = resolve(args[1]);
  const output = join(await realpath(dirname(requested)), basename(requested));
  if (inside(output, source) || inside(source, output))
    throw new Error("Package output must be outside the source workbench.");
  // Exclusive creation refuses every existing output, including an empty directory.
  await mkdir(output, { mode: 0o755 });
  for (const entry of entries)
    await copyOwned(join(source, entry), join(output, entry));
  await install(output);
  const metadata = JSON.parse(
    await readFile(join(output, "package.json"), "utf8"),
  );
  const manifest = {
    format: "rea-workbench-package-1",
    version: metadata.version,
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    dependency_profile: "npm ci --ignore-scripts --omit=optional",
    lock_sha256: await sha256(join(output, "package-lock.json")),
    files: await packageInventory(output),
  };
  await writeFile(
    join(output, INTEGRITY_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o644 },
  );
  process.stdout.write(
    `${JSON.stringify(await verifyPackage(output), null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Plugin packaging failed: ${error.message}\nA newly created output is incomplete unless verify:plugin succeeds; existing outputs are never overwritten.\n`,
  );
  process.exitCode = 1;
}
