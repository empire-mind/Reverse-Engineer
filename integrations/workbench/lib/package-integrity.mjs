import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const INTEGRITY_FILE = "package-integrity.json";

function inside(path, root) {
  const part = relative(root, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function containedFileLink(path, target, root, name) {
  const fail = () => {
    throw new Error(
      `Package link escapes its root or is not a direct relocatable file link: ${name}`,
    );
  };
  if (isAbsolute(target)) fail();
  let cursor = dirname(path);
  const parts = target
    .split(process.platform === "win32" ? /[\\/]/ : /\//)
    .filter((part) => part !== "" && part !== ".");
  for (let index = 0; index < parts.length; index += 1) {
    cursor =
      parts[index] === ".." ? dirname(cursor) : join(cursor, parts[index]);
    // Check every step, not just the final realpath: leaving and returning can
    // depend on the old directory name and break after a package is moved.
    if (!inside(cursor, root)) fail();
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) fail();
    if (index < parts.length - 1 && !stat.isDirectory()) fail();
    if (index === parts.length - 1 && !stat.isFile()) fail();
  }
  if (!parts.length || !inside(await realpath(path), root)) fail();
}

/** Inventory package files, refusing links that would escape after relocation. */
export async function packageInventory(directory) {
  const root = await realpath(directory);
  const files = [];
  async function visit(path, name) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      await containedFileLink(path, target, root, name);
      files.push({ path: name, type: "symlink", target });
    } else if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) {
        if (!name && child === INTEGRITY_FILE) continue;
        if (child === ".git")
          throw new Error("Git metadata cannot be bundled.");
        await visit(join(path, child), name ? `${name}/${child}` : child);
      }
    } else if (stat.isFile()) {
      files.push({
        path: name,
        type: "file",
        bytes: stat.size,
        executable_bits: stat.mode & 0o111,
        sha256: await sha256(path),
      });
    } else {
      throw new Error(`Unsupported package filesystem entry: ${name}`);
    }
  }
  await visit(root, "");
  return files;
}

export async function verifyPackage(directory) {
  const root = await realpath(directory);
  const manifestPath = join(root, INTEGRITY_FILE);
  const manifestStat = await lstat(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 8 * 1024 * 1024
  )
    throw new Error(
      "Package integrity manifest must be a regular file of at most 8 MiB.",
    );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.format !== "rea-workbench-package-1" ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Unsupported package integrity manifest.");
  // Compare the complete independently enumerated tree. Never follow manifest paths.
  const actual = await packageInventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error(
      "Package files, bytes, executable bits, or links differ from the integrity manifest.",
    );
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (
    packageJson.name !== "rea-workbench" ||
    packageJson.version !== manifest.version ||
    (await sha256(join(root, "package-lock.json"))) !== manifest.lock_sha256
  )
    throw new Error(
      "Package identity or lockfile does not match the integrity manifest.",
    );
  return {
    status: "verified",
    directory: resolve(directory),
    version: manifest.version,
    files: actual.length,
    bytes: actual.reduce((sum, file) => sum + (file.bytes ?? 0), 0),
    lock_sha256: manifest.lock_sha256,
    manifest_sha256: await sha256(manifestPath),
    authenticity:
      "Local byte correspondence only; verify the artifact source or published digest separately.",
  };
}
