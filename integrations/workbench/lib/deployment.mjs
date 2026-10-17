import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  createScanner,
  SyntaxKind,
} from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { isMap, parseDocument, stringify as stringifyYaml } from "yaml";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const RECEIPT_SCHEMA = "rea-workbench-insertion-backup/v1";
const planStates = new WeakMap();
const rollbackStates = new WeakMap();
const PROFILES = {
  workflow: ["rea-workbench"],
  native: ["rea"],
  memory: ["rea-memory"],
  all: ["rea-workbench", "rea"],
};

export const CLIENTS = Object.freeze({
  generic: {
    format: "jsonc",
    route: ["mcpServers"],
    hint: "explicit MCP JSON file",
  },
  "claude-code": {
    format: "jsonc",
    route: ["mcpServers"],
    hint: "<project>/.mcp.json or ~/.claude.json (user scope)",
  },
  cursor: {
    format: "jsonc",
    route: ["mcpServers"],
    hint: "<project>/.cursor/mcp.json or ~/.cursor/mcp.json",
  },
  gemini: {
    format: "jsonc",
    route: ["mcpServers"],
    hint: "<project>/.gemini/settings.json or ~/.gemini/settings.json",
  },
  codex: {
    format: "toml",
    route: ["mcp_servers"],
    hint: "<project>/.codex/config.toml or ~/.codex/config.toml",
  },
  hermes: {
    format: "yaml",
    route: ["mcp_servers"],
    hint: "active Hermes profile config.yaml",
  },
  openclaw: {
    format: "jsonc",
    route: ["mcp", "servers"],
    hint: "active OpenClaw config (JSON/JSONC subset; native CLI for other JSON5 syntax)",
  },
});

export class DeploymentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DeploymentError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new DeploymentError(code, message, details);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function textValue(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 8192 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail(
      "INVALID_OPTION",
      `${label} must be a nonempty string without control characters.`,
    );
  return value;
}

function absolutePath(value, label) {
  textValue(value, label);
  if (!isAbsolute(value))
    fail("ABSOLUTE_PATH_REQUIRED", `${label} must be absolute.`);
  return resolve(value);
}

function within(child, parent) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function distributionBoundary(root) {
  for (let current = root; ; current = dirname(current)) {
    try {
      lstatSync(join(current, ".git"));
      return current;
    } catch (error) {
      if (error.code !== "ENOENT")
        fail(
          "SOURCE_BOUNDARY_UNRESOLVED",
          "Could not establish the source checkout boundary.",
        );
    }
    if (dirname(current) === current) return root;
  }
}

function record(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function equivalent(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((v, i) => equivalent(v, right[i]))
    );
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equivalent(left[key], right[key]),
    )
  );
}

function at(root, path) {
  let node = root;
  for (const key of path) {
    if (!record(node))
      fail("CONFIG_CONFLICT", "An MCP configuration parent is not a mapping.", {
        path: path.join("."),
      });
    if (!Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function wrap(path, value) {
  return path.reduceRight((child, key) => ({ [key]: child }), value);
}

function clientSpec(client) {
  if (!Object.hasOwn(CLIENTS, client))
    fail(
      "UNSUPPORTED_CLIENT",
      `Supported clients: ${Object.keys(CLIENTS).join(", ")}.`,
    );
  return CLIENTS[client];
}

function validateProfile(profile) {
  if (!Object.hasOwn(PROFILES, profile))
    fail(
      "INVALID_PROFILE",
      "Profile must be workflow, native, memory, or all.",
    );
  return PROFILES[profile];
}

function envReferences(client, names) {
  if (!names.length) return {};
  if (client === "codex") return { env_vars: names };
  if (!["claude-code", "cursor", "gemini", "hermes"].includes(client))
    fail(
      "ENVIRONMENT_ADAPTER_UNVERIFIED",
      "Named environment forwarding is supported for Codex, Claude Code, Cursor, Gemini and Hermes. Configure other hosts through their documented protected environment mechanism.",
    );
  return {
    env: Object.fromEntries(
      names.map((name) => [
        name,
        client === "cursor" ? `\${env:${name}}` : `\${${name}}`,
      ]),
    ),
  };
}

/** Generate only our server definitions; never inspect or copy ambient env values. */
export function createDeployment(options = {}) {
  const client = options.client ?? "generic";
  const spec = clientSpec(client);
  const profile = options.profile ?? "workflow";
  const names = validateProfile(profile);
  const runtime = options.runtime ?? "node";
  if (!["node", "container"].includes(runtime))
    fail("INVALID_RUNTIME", "Runtime must be node or container.");
  const root = absolutePath(
    options.workbenchRoot ?? PACKAGE_ROOT,
    "workbench root",
  );
  const sourceBoundary = distributionBoundary(root);
  const memory =
    options.memoryRoot === undefined
      ? undefined
      : absolutePath(options.memoryRoot, "memory directory");
  if (memory && within(memory, sourceBoundary))
    fail(
      "MEMORY_IN_DISTRIBUTION",
      "Choose a private memory directory outside the workbench/plugin and its enclosing source checkout.",
    );
  if (
    runtime === "node" &&
    [
      options.targetRoot,
      options.evidenceVolume,
      options.image,
      options.dockerCommand,
    ].some((value) => value !== undefined)
  )
    fail(
      "INVALID_OPTION",
      "Container mount/image options require --runtime container; they cannot restrict a native Node process.",
    );
  const passEnv = [...new Set(options.passEnv ?? [])];
  if (
    passEnv.length > 32 ||
    passEnv.some(
      (name) =>
        typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
    )
  )
    fail(
      "INVALID_ENVIRONMENT_NAME",
      "Pass at most 32 distinct environment variable names, without values.",
    );
  if (profile === "memory" && passEnv.length)
    fail(
      "INVALID_OPTION",
      "The memory-only profile does not start an analysis provider.",
    );
  const nodeCommand = textValue(
    options.nodeCommand ?? process.execPath,
    "Node command",
  );
  const dockerCommand = textValue(
    options.dockerCommand ?? "docker",
    "container command",
  );
  const entries = {};
  let targetRoot;
  let evidenceVolume;
  let image;
  if (runtime === "node" && !memory)
    fail(
      "MEMORY_REQUIRED",
      "Choose an explicit private --memory directory for this deployment.",
    );
  if (runtime === "container") {
    targetRoot = absolutePath(options.targetRoot, "target root");
    evidenceVolume = options.evidenceVolume;
    if ((memory !== undefined) === (evidenceVolume !== undefined))
      fail(
        "EVIDENCE_MOUNT_REQUIRED",
        "Choose exactly one of --memory (existing writable bind directory) or --evidence-volume.",
      );
    if (
      evidenceVolume !== undefined &&
      (typeof evidenceVolume !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(evidenceVolume))
    )
      fail(
        "INVALID_VOLUME_NAME",
        "Use a Docker named-volume identifier, not a path or mount option.",
      );
    if (memory && (within(memory, targetRoot) || within(targetRoot, memory)))
      fail(
        "OVERLAPPING_MOUNTS",
        "Target and evidence mounts must not overlap.",
      );
    if ([targetRoot, memory].filter(Boolean).some((path) => path.includes(",")))
      fail(
        "UNSUPPORTED_MOUNT_PATH",
        "Docker --mount paths containing commas are not supported by this adapter.",
      );
    image = textValue(
      options.image ?? "rea-workbench:local",
      "container image",
    );
    if (image.startsWith("-") || /\s/u.test(image))
      fail(
        "INVALID_IMAGE",
        "Supply an image reference without whitespace or flags.",
      );
  }
  for (const name of names) {
    const mode =
      name === "rea-workbench"
        ? "workflow"
        : name === "rea-memory"
          ? "memory"
          : "native";
    let args;
    if (runtime === "node") {
      args =
        mode === "native"
          ? [
              join(root, "node_modules", "rea-agents", "scripts", "rea.mjs"),
              "mcp",
            ]
          : [
              join(
                root,
                "bin",
                mode === "workflow" ? "workbench-mcp.mjs" : "memory-mcp.mjs",
              ),
              "--memory",
              memory,
            ];
    } else {
      args = [
        "run",
        "--rm",
        "--init",
        "-i",
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
        `type=bind,src=${targetRoot},dst=/targets,readonly`,
        "--mount",
        evidenceVolume
          ? `type=volume,src=${evidenceVolume},dst=/evidence`
          : `type=bind,src=${memory},dst=/evidence`,
      ];
      for (const name of passEnv) args.push("--env", name);
      args.push(
        image,
        ...(mode === "native"
          ? ["rea", "mcp"]
          : [
              mode === "workflow" ? "mcp" : "memory-mcp",
              "--memory",
              "/evidence",
            ]),
      );
    }
    if (mode === "workflow")
      for (const name of passEnv) args.push("--pass-env", name);
    entries[name] = {
      command: runtime === "node" ? nodeCommand : dockerCommand,
      args,
      ...envReferences(client, passEnv),
    };
  }
  const config = wrap(spec.route, entries);
  const snippet =
    spec.format === "toml"
      ? stringifyToml(config)
      : spec.format === "yaml"
        ? stringifyYaml(config)
        : `${JSON.stringify(config, null, 2)}\n`;
  return {
    schema_version: 1,
    client,
    profile,
    runtime,
    workbench_root: root,
    source_boundary: sourceBoundary,
    memory_directory: memory ?? null,
    target_root: targetRoot ?? null,
    evidence_volume: evidenceVolume ?? null,
    image: image ?? null,
    server_names: names,
    format: spec.format,
    configuration_path_hint: spec.hint,
    configuration: config,
    snippet,
    state: {
      intended: true,
      configuration_applied: false,
      host_loaded: "unverified",
    },
  };
}

function jsonParsed(text) {
  const errors = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length || !tree || tree.type !== "object")
    fail(
      "CONFIG_PARSE_ERROR",
      "Configuration must be an unambiguous JSON/JSONC object. No file was changed.",
    );
  const visit = (node) => {
    if (node.type === "object") {
      const keys = new Set();
      for (const property of node.children ?? []) {
        const key = property.children[0].value;
        if (keys.has(key))
          fail(
            "DUPLICATE_CONFIG_KEY",
            "Configuration contains a duplicate JSON key. No file was changed.",
          );
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return { data: getNodeValue(tree), tree };
}

function parsed(text, format) {
  if (!text.trim())
    return {
      data:
        format === "toml"
          ? parseToml("")
          : format === "jsonc"
            ? getNodeValue(parseTree("{}"))
            : {},
      empty: true,
    };
  if (format === "jsonc") return jsonParsed(text);
  if (format === "toml") {
    try {
      return { data: parseToml(text, { integersAsBigInt: "asNeeded" }) };
    } catch {
      fail(
        "CONFIG_PARSE_ERROR",
        "Configuration is not valid, unambiguous TOML. No source text is included in this diagnostic.",
      );
    }
  }
  const document = parseDocument(text, {
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    keepSourceTokens: true,
    prettyErrors: false,
    logLevel: "silent",
  });
  if (document.errors.length || document.warnings.length)
    fail(
      "CONFIG_PARSE_ERROR",
      "Configuration is not a supported, unambiguous YAML document.",
    );
  if (document.contents === null) return { data: {}, document, empty: true };
  if (!isMap(document.contents))
    fail(
      "CONFIG_PARSE_ERROR",
      "The YAML configuration root must be a mapping.",
    );
  try {
    return { data: document.toJS({ maxAliasCount: 100 }), document };
  } catch {
    fail(
      "CONFIG_PARSE_ERROR",
      "YAML aliases could not be resolved within the configured bound.",
    );
  }
}

function newline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function jsonInsertion(text, facts, path, value) {
  let parentPath = [];
  let missingIndex = 0;
  for (; missingIndex < path.length; missingIndex++) {
    const existing = findNodeAtLocation(facts.tree, [
      ...parentPath,
      path[missingIndex],
    ]);
    if (!existing) break;
    if (existing.type !== "object")
      fail(
        "CONFIG_CONFLICT",
        "An MCP configuration parent is not a JSON mapping.",
      );
    parentPath.push(path[missingIndex]);
  }
  const parent = findNodeAtLocation(facts.tree, parentPath);
  const key = path[missingIndex];
  const nested = wrap(path.slice(missingIndex + 1), value);
  const close = parent.offset + parent.length - 1;
  const last = parent.children?.at(-1);
  const additions = [];
  let adjacentComma = "";
  if (last) {
    const end = last.offset + last.length;
    const scanner = createScanner(text.slice(end, close), true);
    if (scanner.scan() !== SyntaxKind.CommaToken) {
      if (end === close) adjacentComma = ",";
      else additions.push({ offset: end, text: "," });
    }
  }
  const eol = newline(text);
  const indent = "  ".repeat(parentPath.length + 1);
  const encoded =
    `${JSON.stringify(key)}: ${JSON.stringify(nested, null, 2)}`.replaceAll(
      "\n",
      `${eol}${indent}`,
    );
  additions.push({
    offset: close,
    text: `${adjacentComma}${eol}${indent}${encoded}${eol}${"  ".repeat(parentPath.length)}`,
  });
  return additions;
}

function yamlInsertion(text, facts, path, value) {
  let parentPath = [];
  let missingIndex = 0;
  for (; missingIndex < path.length; missingIndex++) {
    if (!facts.document.hasIn([...parentPath, path[missingIndex]])) break;
    const node = facts.document.getIn(
      [...parentPath, path[missingIndex]],
      true,
    );
    if (!isMap(node))
      fail(
        "CONFIG_CONFLICT",
        "An MCP configuration parent is not a concrete YAML mapping.",
      );
    parentPath.push(path[missingIndex]);
  }
  const parent = facts.document.getIn(parentPath, true);
  const key = path[missingIndex];
  const nested = wrap(path.slice(missingIndex + 1), value);
  const eol = newline(text);
  if (parent.flow) {
    const closeToken = parent.srcToken.end.find(
      (token) => token.type === "flow-map-end",
    );
    const last = parent.srcToken.items.at(-1);
    const trailingComma =
      !last?.key && last?.start.some((token) => token.type === "comma");
    const prefix = parent.items.length && !trailingComma ? "," : "";
    const indent = " ".repeat(parent.srcToken.indent + 2);
    return [
      {
        offset: closeToken.offset,
        text: `${eol}${indent}${prefix}${JSON.stringify(key)}: ${JSON.stringify(nested)}${eol}`,
      },
    ];
  }
  const indentation = " ".repeat(parent.srcToken.indent);
  const fragment = stringifyYaml({ [key]: nested })
    .trimEnd()
    .split("\n")
    .map((line) => indentation + line)
    .join(eol);
  const offset = parent.range[1];
  return [
    {
      offset,
      text: `${text.slice(0, offset).endsWith("\n") ? "" : eol}${fragment}${eol}`,
    },
  ];
}

function additionsOnly(before, after, route, entries) {
  let oldNode = before;
  let newNode = after;
  for (const key of route) {
    if (!record(oldNode) || !record(newNode)) return false;
    if (!Object.hasOwn(oldNode, key)) {
      const expected = wrap(route.slice(route.indexOf(key) + 1), entries);
      if (!equivalent(newNode[key], expected)) return false;
      delete newNode[key];
      return isDeepStrictEqual(before, after);
    }
    oldNode = oldNode[key];
    newNode = newNode[key];
  }
  if (!record(oldNode) || !record(newNode)) return false;
  for (const [name, entry] of Object.entries(entries)) {
    if (!equivalent(newNode[name], entry)) return false;
    if (!Object.hasOwn(oldNode, name)) delete newNode[name];
  }
  return isDeepStrictEqual(before, after);
}

/** Offsets are UTF-16 positions in successively updated, validated UTF-8 text. */
function editConfiguration(original, client, entries) {
  const spec = clientSpec(client);
  const before = parsed(original, spec.format);
  const existing = at(before.data, spec.route);
  if (existing !== undefined && !record(existing))
    fail("CONFIG_CONFLICT", "The MCP server collection is not a mapping.");
  for (const [name, entry] of Object.entries(entries)) {
    if (
      existing &&
      Object.hasOwn(existing, name) &&
      !equivalent(existing[name], entry)
    )
      fail(
        "SERVER_CONFIG_CONFLICT",
        "An existing REA entry differs from the proposed configuration. Resolve it explicitly; this installer never overwrites it.",
        { server: name },
      );
    for (const [other, current] of Object.entries(existing ?? {})) {
      if (
        other !== name &&
        record(current) &&
        current.command === entry.command &&
        equivalent(current.args, entry.args)
      )
        fail(
          "DUPLICATE_REGISTRATION",
          "The same MCP launch is already configured under another name.",
          { intended_server: name, existing_server: other },
        );
    }
  }
  let text = original;
  const insertions = [];
  const added = [];
  const unchanged = [];
  for (const [name, entry] of Object.entries(entries)) {
    const facts = parsed(text, spec.format);
    if (at(facts.data, [...spec.route, name]) !== undefined) {
      unchanged.push(name);
      continue;
    }
    let edits;
    const document = wrap(spec.route, { [name]: entry });
    if (facts.empty) {
      const fragment =
        spec.format === "toml"
          ? stringifyToml(document)
          : spec.format === "yaml"
            ? stringifyYaml(document)
            : JSON.stringify(document, null, 2);
      edits = [
        {
          offset: text.length,
          text: `${text && !text.endsWith("\n") ? newline(text) : ""}${fragment.trimEnd()}${newline(text)}`,
        },
      ];
    } else if (spec.format === "toml") {
      edits = [
        {
          offset: text.length,
          text: `${newline(text)}${stringifyToml(document).replaceAll("\n", newline(text))}`,
        },
      ];
    } else if (spec.format === "jsonc")
      edits = jsonInsertion(text, facts, [...spec.route, name], entry);
    else edits = yamlInsertion(text, facts, [...spec.route, name], entry);
    // Apply source-coordinate edits from right to left; each recorded offset is
    // therefore valid in the intermediate string, making the inverse exact.
    for (const edit of edits.sort((a, b) => b.offset - a.offset)) {
      text = text.slice(0, edit.offset) + edit.text + text.slice(edit.offset);
      insertions.push(edit);
    }
    try {
      parsed(text, spec.format);
    } catch (error) {
      if (spec.format === "toml")
        fail(
          "CONFIG_EXTENSION_CONFLICT",
          "This valid TOML document cannot be extended with a new MCP table without rewriting existing content (for example, an inline mcp_servers table). Use the client's native setup or restructure that table explicitly.",
        );
      throw error;
    }
    added.push(name);
  }
  if (
    !additionsOnly(
      parsed(original, spec.format).data,
      parsed(text, spec.format).data,
      spec.route,
      entries,
    )
  )
    fail(
      "CONFIG_SEMANTICS_CHANGED",
      "The candidate changes more than the requested MCP entries; no file was changed.",
    );
  return { text, insertions, added, unchanged };
}

async function assertNoSymlinks(path) {
  const resolved = absolutePath(path, "filesystem path");
  const parts = [];
  for (
    let current = resolved;
    dirname(current) !== current;
    current = dirname(current)
  )
    parts.push(current);
  for (const current of parts.reverse()) {
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink())
      fail(
        "SYMLINK_PATH",
        "A selected path or its ancestor is a symbolic link.",
        { path: current },
      );
    if (current !== resolved && !stat.isDirectory())
      fail("INVALID_PATH", "A selected path ancestor is not a directory.");
  }
}

async function readSnapshot(path, maximum = MAX_CONFIG_BYTES) {
  await assertNoSymlinks(path);
  let handle;
  try {
    // Reject special files before opening: an ordinary blocking read-open of a
    // FIFO waits indefinitely for a writer, before fstat can reject its type.
    const selected = await lstat(path);
    if (!selected.isFile() || selected.nlink !== 1)
      fail(
        "UNSAFE_FILE_TYPE",
        "The selected file must be an ordinary file with one hard link.",
      );
    // The descriptor check below remains authoritative if the path changes
    // after lstat. Nonblocking open also bounds a replacement-to-FIFO race.
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error.code === "ENOENT")
      return { existed: false, text: "", sha256: digest(""), mode: 0o600 };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      fail(
        "UNSAFE_FILE_TYPE",
        "The selected file must be an ordinary file with one hard link.",
      );
    if (stat.size > maximum)
      fail(
        "CONFIG_TOO_LARGE",
        "The selected file exceeds the bounded configuration size.",
      );
    const bytes = await handle.readFile();
    if (bytes.length > maximum)
      fail(
        "CONFIG_TOO_LARGE",
        "The selected file grew beyond the bounded configuration size.",
      );
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      fail("INVALID_UTF8", "The selected file is not valid UTF-8.");
    }
    if (text.charCodeAt(0) === 0xfeff)
      fail(
        "UNSUPPORTED_ENCODING",
        "UTF-8 BOM configurations must be normalized explicitly before installation.",
      );
    return {
      existed: true,
      text,
      sha256: digest(bytes),
      mode: stat.mode & 0o777,
      dev: stat.dev,
      ino: stat.ino,
    };
  } finally {
    await handle.close();
  }
}

function sameSnapshot(left, right) {
  return (
    left.existed === right.existed &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    (!left.existed || (left.dev === right.dev && left.ino === right.ino))
  );
}

async function prerequisites(deployment) {
  const results = [];
  if (deployment.runtime === "node") {
    for (const name of deployment.server_names) {
      const entry = at(deployment.configuration, [
        ...clientSpec(deployment.client).route,
        name,
      ]);
      try {
        const stat = await lstat(entry.args[0]);
        results.push({
          item: `launcher:${name}`,
          status: stat.isFile() ? "present" : "not-a-file",
        });
      } catch (error) {
        results.push({
          item: `launcher:${name}`,
          status: error.code === "ENOENT" ? "missing" : "unreadable",
        });
      }
    }
    try {
      const stat = await lstat(
        join(
          deployment.workbench_root,
          "node_modules",
          "rea-agents",
          "scripts",
          "rea.mjs",
        ),
      );
      results.push({
        item: "pinned-REA-launcher",
        status: stat.isFile() ? "present" : "not-a-file",
      });
    } catch (error) {
      results.push({
        item: "pinned-REA-launcher",
        status: error.code === "ENOENT" ? "missing" : "unreadable",
      });
    }
  } else {
    results.push({ item: "container-image-and-engine", status: "unverified" });
    for (const [item, path] of [
      ["target-root", deployment.target_root],
      ["evidence-bind", deployment.memory_directory],
    ]) {
      if (!path) continue;
      try {
        const stat = await lstat(path);
        results.push({
          item,
          status: stat.isDirectory() ? "present" : "not-a-directory",
        });
      } catch (error) {
        results.push({
          item,
          status: error.code === "ENOENT" ? "missing" : "unreadable",
        });
      }
    }
    results.push({
      item: "container-evidence-write-access",
      status: "unverified",
    });
  }
  return results;
}

/** A plan's public representation contains no original configuration text. */
export async function planDeployment({ configPath, ...options }) {
  const deployment = createDeployment(options);
  const path = absolutePath(configPath, "configuration path");
  const snapshot = await readSnapshot(path);
  const entries = at(
    deployment.configuration,
    clientSpec(deployment.client).route,
  );
  const edit = editConfiguration(snapshot.text, deployment.client, entries);
  const readiness = await prerequisites(deployment);
  const plan = {
    ...deployment,
    action: edit.added.length ? "add" : "unchanged",
    config_path: path,
    original_exists: snapshot.existed,
    original_sha256: snapshot.sha256,
    proposed_sha256: digest(edit.text),
    additions: edit.added,
    unchanged: edit.unchanged,
    prerequisites: readiness,
    state: {
      intended: true,
      configuration_applied: false,
      configuration_matches: !edit.added.length,
      host_loaded: "unverified",
    },
  };
  planStates.set(plan, { snapshot, edit, entries, deployment, path });
  return plan;
}

async function createPrivateDirectory(path) {
  await assertNoSymlinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertNoSymlinks(path);
  if (!(await lstat(path)).isDirectory())
    fail("INVALID_STATE_DIRECTORY", "The state path must be a directory.");
}

async function writeExclusive(path, contents, mode = 0o600) {
  await assertNoSymlinks(dirname(path));
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.chmod(mode);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceGuarded(path, expected, text) {
  const temporary = join(dirname(path), `.rea-workbench-${randomUUID()}.tmp`);
  await writeExclusive(temporary, text, expected.mode);
  try {
    if (!sameSnapshot(expected, await readSnapshot(path)))
      fail(
        "CONFIG_CHANGED",
        "The configuration changed after planning. Replan; no candidate was applied.",
      );
    await assertNoSymlinks(path);
    if (expected.existed) await rename(temporary, path);
    else {
      // A hard-link claim fails atomically if another writer created the path
      // after the final check; rename would overwrite that new user file.
      try {
        await link(temporary, path);
      } catch (error) {
        if (error.code === "EEXIST")
          fail(
            "CONFIG_CHANGED",
            "Another writer created the configuration after planning.",
          );
        throw error;
      }
    }
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function withConfigLock(path, operation) {
  await createPrivateDirectory(dirname(path));
  const lockPath = `${path}.rea-workbench.lock`;
  let lock;
  try {
    lock = await open(
      lockPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (error.code === "EEXIST")
      fail(
        "CONFIG_LOCKED",
        "Another deployment owns the configuration lock. Verify the owning operation before removing a stale lock.",
      );
    throw error;
  }
  const identity = await lock.stat();
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = [];
  try {
    // Keep the handle open through the identity check so inode reuse cannot
    // make a replaced lock appear to be the lock this operation acquired.
    const current = await lstat(lockPath);
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      !current.isFile()
    )
      fail(
        "LOCK_OWNERSHIP_LOST",
        "The lock path no longer identifies this deployment's open lock. The replacement was preserved.",
      );
    await unlink(lockPath);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await lock.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (operationError && cleanupErrors.length)
    fail(
      "DEPLOYMENT_AND_CLEANUP_FAILED",
      "The operation and owned-lock cleanup both reported failures. Inspect the configuration hashes before proceeding.",
      {
        operation_code: operationError.code ?? operationError.name,
        cleanup_codes: cleanupErrors.map((error) => error.code ?? error.name),
      },
    );
  if (operationError) throw operationError;
  if (cleanupErrors.length)
    fail(
      cleanupErrors[0].code ?? "LOCK_CLEANUP_FAILED",
      "The operation finished, but owned-lock cleanup could not be verified. Inspect the configuration hashes; another owner's lock was not removed.",
      {
        config_path: path,
        ...(result?.receipt_path ? { receipt_path: result.receipt_path } : {}),
        cleanup_codes: cleanupErrors.map((error) => error.code ?? error.name),
      },
    );
  return result;
}

export async function applyDeployment(plan, { stateDirectory } = {}) {
  const state = planStates.get(plan);
  if (!state)
    fail(
      "INVALID_PLAN",
      "Apply a plan created by planDeployment in this process.",
    );
  const { snapshot, edit, entries, deployment, path } = state;
  if (!edit.added.length) {
    if (!sameSnapshot(snapshot, await readSnapshot(path)))
      fail("CONFIG_CHANGED", "The configuration changed after planning.");
    return {
      ...plan,
      action: "unchanged",
      state: {
        ...plan.state,
        configuration_applied: false,
        configuration_matches: true,
      },
      receipt_path: null,
    };
  }
  if (
    plan.prerequisites.some((item) =>
      ["missing", "not-a-file", "not-a-directory", "unreadable"].includes(
        item.status,
      ),
    )
  )
    fail(
      "MISSING_PREREQUISITE",
      "Resolve the missing local launch prerequisites shown in the plan before applying it.",
    );
  const directory = absolutePath(
    stateDirectory ??
      (deployment.memory_directory
        ? join(deployment.memory_directory, "deployment-backups")
        : undefined),
    "backup state directory",
  );
  if (within(directory, deployment.source_boundary))
    fail(
      "BACKUP_IN_DISTRIBUTION",
      "Keep deployment state outside the workbench/plugin and its enclosing source checkout.",
    );
  return withConfigLock(path, async () => {
    if (!sameSnapshot(snapshot, await readSnapshot(path)))
      fail(
        "CONFIG_CHANGED",
        "The configuration changed after planning. No candidate was applied.",
      );
    await createPrivateDirectory(directory);
    const receiptPath = join(directory, `${Date.now()}-${randomUUID()}.json`);
    const receipt = {
      schema: RECEIPT_SCHEMA,
      created_at: new Date().toISOString(),
      client: deployment.client,
      config_path: path,
      original: {
        existed: snapshot.existed,
        sha256: snapshot.sha256,
        mode: snapshot.mode,
      },
      proposed_sha256: digest(edit.text),
      entries,
      insertions: edit.insertions,
      status: "prepared",
      host_loaded: "unverified",
    };
    await writeExclusive(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    try {
      await replaceGuarded(path, snapshot, edit.text);
    } catch (error) {
      throw new DeploymentError(
        error.code ?? "APPLY_FAILED",
        "Configuration apply failed. The prepared inverse receipt remains available; inspect actual file hashes before recovery.",
        { receipt_path: receiptPath, reason: error.code ?? error.name },
      );
    }
    const actual = await readSnapshot(path);
    if (actual.sha256 !== receipt.proposed_sha256)
      fail(
        "POST_WRITE_CONFLICT",
        "The configuration changed during post-write verification; inspect the receipt before recovery.",
        { receipt_path: receiptPath },
      );
    return {
      ...plan,
      action: "applied",
      receipt_path: receiptPath,
      applied_sha256: actual.sha256,
      state: {
        intended: true,
        configuration_applied: true,
        configuration_matches: true,
        host_loaded: "unverified",
      },
    };
  });
}

function validReceipt(receipt, configPath) {
  if (
    !record(receipt) ||
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.config_path !== configPath ||
    !Object.hasOwn(CLIENTS, receipt.client) ||
    !record(receipt.original) ||
    typeof receipt.original.existed !== "boolean" ||
    !/^[a-f0-9]{64}$/u.test(receipt.original.sha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.proposed_sha256) ||
    !Number.isInteger(receipt.original.mode) ||
    receipt.original.mode < 0 ||
    receipt.original.mode > 0o777 ||
    !record(receipt.entries) ||
    !Object.keys(receipt.entries).length ||
    Object.keys(receipt.entries).some(
      (key) => !["rea-workbench", "rea", "rea-memory"].includes(key),
    ) ||
    !Array.isArray(receipt.insertions) ||
    !receipt.insertions.length ||
    receipt.insertions.length > 16 ||
    receipt.insertions.some(
      (edit) =>
        !record(edit) ||
        !Number.isSafeInteger(edit.offset) ||
        edit.offset < 0 ||
        typeof edit.text !== "string" ||
        !edit.text,
    )
  )
    fail(
      "INVALID_RECEIPT",
      "The selected file is not a valid REA inverse receipt for this explicit configuration path.",
    );
}

export async function planRollback({ configPath, receiptPath }) {
  const path = absolutePath(configPath, "configuration path");
  const backup = absolutePath(receiptPath, "receipt path");
  const saved = await readSnapshot(backup, MAX_RECEIPT_BYTES);
  if (!saved.existed)
    fail("RECEIPT_NOT_FOUND", "The selected inverse receipt does not exist.");
  let receipt;
  try {
    receipt = JSON.parse(saved.text);
  } catch {
    fail("INVALID_RECEIPT", "The inverse receipt is not valid JSON.");
  }
  validReceipt(receipt, path);
  const snapshot = await readSnapshot(path);
  if (
    snapshot.existed === receipt.original.existed &&
    snapshot.sha256 === receipt.original.sha256
  ) {
    return {
      action: "already-restored",
      config_path: path,
      receipt_path: backup,
      configuration_applied: false,
      host_loaded: "unverified",
    };
  }
  if (!snapshot.existed || snapshot.sha256 !== receipt.proposed_sha256)
    fail(
      "ROLLBACK_CONFLICT",
      "The configuration no longer matches the applied result. Guarded rollback will not overwrite subsequent edits.",
    );
  let restored = snapshot.text;
  for (const edit of [...receipt.insertions].reverse()) {
    if (
      restored.slice(edit.offset, edit.offset + edit.text.length) !== edit.text
    )
      fail(
        "INVALID_RECEIPT",
        "An inverse insertion does not match the current file.",
      );
    restored =
      restored.slice(0, edit.offset) +
      restored.slice(edit.offset + edit.text.length);
  }
  if (
    digest(restored) !== receipt.original.sha256 ||
    (!receipt.original.existed && restored !== "")
  )
    fail(
      "INVALID_RECEIPT",
      "The inverse receipt does not restore the original digest.",
    );
  // A forged receipt cannot authorize removing arbitrary existing settings:
  // independently reproduce an insertion-only MCP edit from the candidate.
  const replay = editConfiguration(restored, receipt.client, receipt.entries);
  if (
    replay.text !== snapshot.text ||
    !equivalent(replay.insertions, receipt.insertions)
  )
    fail(
      "INVALID_RECEIPT",
      "The receipt is not an insertion-only REA configuration change.",
    );
  const plan = {
    action: receipt.original.existed ? "restore" : "remove-created-file",
    config_path: path,
    receipt_path: backup,
    current_sha256: snapshot.sha256,
    restored_sha256: receipt.original.sha256,
    server_names: Object.keys(receipt.entries),
    state: {
      intended: true,
      configuration_applied: false,
      host_loaded: "unverified",
    },
  };
  rollbackStates.set(plan, { snapshot, restored, receipt, path });
  return plan;
}

export async function applyRollback(plan) {
  if (plan.action === "already-restored") return plan;
  const state = rollbackStates.get(plan);
  if (!state)
    fail(
      "INVALID_PLAN",
      "Apply a rollback plan created by planRollback in this process.",
    );
  const { snapshot, restored, receipt, path } = state;
  return withConfigLock(path, async () => {
    if (!sameSnapshot(snapshot, await readSnapshot(path)))
      fail(
        "ROLLBACK_CONFLICT",
        "The configuration changed after rollback planning.",
      );
    if (receipt.original.existed)
      await replaceGuarded(
        path,
        { ...snapshot, mode: receipt.original.mode },
        restored,
      );
    else await unlink(path);
    const actual = await readSnapshot(path);
    if (
      actual.existed !== receipt.original.existed ||
      actual.sha256 !== receipt.original.sha256
    )
      fail(
        "POST_WRITE_CONFLICT",
        "The configuration changed during post-rollback verification. The observed contents were preserved; inspect the receipt before recovery.",
        { receipt_path: plan.receipt_path },
      );
    return {
      ...plan,
      action: "restored",
      state: {
        intended: true,
        configuration_applied: true,
        host_loaded: "unverified",
      },
    };
  });
}
