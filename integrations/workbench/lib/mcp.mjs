import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

const require = createRequire(import.meta.url);
const AVAILABILITY_REASONS = [
  "available",
  "target_required",
  "provider_missing",
  "provider_unavailable",
  "unsupported_host",
];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Expected local/client failures; result is retained whenever REA returned one. */
export class ReaClientError extends Error {
  constructor(code, message, { cause, result, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReaClientError";
    this.code = code;
    if (result !== undefined) this.result = result;
    if (details !== undefined) this.details = details;
  }
}

/** A tool ran and returned isError. Its complete response may contain partial evidence. */
export class ReaToolError extends ReaClientError {
  constructor(toolName, result) {
    super(
      "REA_TOOL_ERROR",
      `REA tool ${toolName} reported an error; inspect error.result for complete evidence.`,
      { result },
    );
    this.name = "ReaToolError";
    this.toolName = toolName;
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReaClientError(
      "REA_INVALID_OPTION",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function absolutePath(path, name = "path") {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path)) {
    throw new ReaClientError(
      "REA_INVALID_PATH",
      `${name} must be an absolute local filesystem path without NUL bytes.`,
    );
  }
  return path;
}

function serverParameters(launcher) {
  if (launcher === undefined)
    launcher = require.resolve("rea-agents/scripts/rea.mjs");
  if (typeof launcher === "string") {
    return {
      command: process.execPath,
      args: [absolutePath(launcher, "launcher"), "mcp"],
    };
  }
  if (
    !object(launcher) ||
    typeof launcher.command !== "string" ||
    !launcher.command ||
    launcher.command.includes("\0")
  ) {
    throw new ReaClientError(
      "REA_INVALID_OPTION",
      "launcher must be an absolute script path or {command, args?, cwd?, env?}.",
    );
  }
  if (
    launcher.args !== undefined &&
    (!Array.isArray(launcher.args) ||
      launcher.args.some(
        (arg) => typeof arg !== "string" || arg.includes("\0"),
      ))
  ) {
    throw new ReaClientError(
      "REA_INVALID_OPTION",
      "launcher.args must be an array of strings without NUL bytes.",
    );
  }
  if (launcher.cwd !== undefined) absolutePath(launcher.cwd, "launcher.cwd");
  if (
    launcher.env !== undefined &&
    (!object(launcher.env) ||
      Object.entries(launcher.env).some(
        ([key, value]) =>
          !key ||
          key.includes("=") ||
          key.includes("\0") ||
          typeof value !== "string" ||
          value.includes("\0"),
      ))
  ) {
    throw new ReaClientError(
      "REA_INVALID_OPTION",
      "launcher.env must contain valid environment names and string values.",
    );
  }
  // Only the documented SDK launch fields cross this boundary. No shell or ambient
  // environment snapshot is created. Provider settings can be supplied via env.
  return {
    command: launcher.command,
    args: [...(launcher.args ?? [])],
    ...(launcher.cwd === undefined ? {} : { cwd: launcher.cwd }),
    ...(launcher.env === undefined ? {} : { env: { ...launcher.env } }),
  };
}

/**
 * One owned stdio process per investigation. Calls share REA's evidence/session
 * state until the caller exports it and closes. Closing never opens a replacement.
 * The official SDK owns framing, pagination, output validation, timeouts, and
 * teardown; REA retains its own helper-process supervision.
 */
export class ReaClient {
  #sdk;
  #transport;
  #validator = new AjvJsonSchemaValidator();
  #definitions = new Map();
  #inputValidators = new Map();
  #state = "new";
  #connectPromise;
  #closePromise;
  #serverInfo;
  #stderr = Buffer.alloc(0);
  #stderrBytes = 0;
  #errors = [];
  #errorCount = 0;
  #successfulTools = new Set();
  #parameters;
  #timeoutMs;
  #expectedVersion;
  #maxMessageBytes;
  #maxStderrBytes;
  #maxCatalogPages;

  constructor({
    launcher,
    timeoutMs = 60_000,
    expectedVersion = "6.5.0",
    maxMessageBytes = 16 * 1024 * 1024,
    maxStderrBytes = 64 * 1024,
    maxCatalogPages = 64,
  } = {}) {
    this.#parameters = serverParameters(launcher);
    this.#timeoutMs = positiveInteger(timeoutMs, "timeoutMs");
    this.#maxMessageBytes = positiveInteger(maxMessageBytes, "maxMessageBytes");
    this.#maxStderrBytes = positiveInteger(maxStderrBytes, "maxStderrBytes");
    this.#maxCatalogPages = positiveInteger(maxCatalogPages, "maxCatalogPages");
    if (typeof expectedVersion !== "string" || !expectedVersion.trim()) {
      throw new ReaClientError(
        "REA_INVALID_OPTION",
        "expectedVersion must be a nonempty version string.",
      );
    }
    this.#expectedVersion = expectedVersion;
  }

  get state() {
    return this.#state;
  }
  get serverInfo() {
    return this.#serverInfo === undefined
      ? undefined
      : structuredClone(this.#serverInfo);
  }
  get successfulTools() {
    return [...this.#successfulTools].sort();
  }
  get diagnostics() {
    return {
      stderrTail: this.#stderr.toString("utf8"),
      stderrBytesObserved: this.#stderrBytes,
      stderrTruncated: this.#stderrBytes > this.#stderr.length,
      errors: this.#errors.map((error) => ({ ...error })),
      errorCount: this.#errorCount,
      limits: {
        timeoutMs: this.#timeoutMs,
        maxMessageBytes: this.#maxMessageBytes,
        maxStderrBytes: this.#maxStderrBytes,
        maxCatalogPages: this.#maxCatalogPages,
      },
    };
  }

  #requestOptions() {
    return {
      timeout: this.#timeoutMs,
      maxTotalTimeout: this.#timeoutMs,
      resetTimeoutOnProgress: false,
      // One deadline also bounds a multi-page discovery walk as a whole.
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
  }

  #assertConnected() {
    if (this.#state !== "connected") {
      throw new ReaClientError(
        "REA_NOT_CONNECTED",
        `REA client is ${this.#state}; connect a new client before using tools.`,
      );
    }
  }

  async connect() {
    if (this.#state === "connected") return this;
    if (this.#state === "connecting") return this.#connectPromise;
    if (this.#state !== "new") {
      throw new ReaClientError(
        "REA_CLIENT_CLOSED",
        "This REA session has ended. Create a new client and explicitly import saved evidence to resume.",
      );
    }
    this.#state = "connecting";
    this.#connectPromise = this.#start();
    return this.#connectPromise;
  }

  async #start() {
    this.#sdk = new Client(
      { name: "rea-workbench", version: "0.1.0" },
      {
        capabilities: {},
        enforceStrictCapabilities: true,
        listMaxPages: this.#maxCatalogPages,
        jsonSchemaValidator: this.#validator,
        // REA 6.5 uses the SDK's normal initialize handshake. No probe sibling is
        // needed; every analysis call below belongs to this one live process.
        versionNegotiation: { mode: "legacy" },
      },
    );
    this.#sdk.onerror = (error) => {
      this.#errorCount += 1;
      this.#errors.push({
        name: error?.name ?? "Error",
        message: String(error?.message ?? error).slice(0, 2048),
      });
      if (this.#errors.length > 16) this.#errors.shift();
    };
    this.#sdk.onclose = () => {
      if (this.#state === "connected") this.#state = "closed";
    };
    this.#transport = new StdioClientTransport({
      ...this.#parameters,
      stderr: "pipe",
      maxBufferSize: this.#maxMessageBytes,
    });
    this.#transport.stderr?.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.#stderrBytes += bytes.length;
      if (bytes.length >= this.#maxStderrBytes) {
        // Copy the tail rather than retaining a slice of a potentially huge chunk.
        this.#stderr = Buffer.from(
          bytes.subarray(bytes.length - this.#maxStderrBytes),
        );
      } else {
        const retain = Math.max(0, this.#maxStderrBytes - bytes.length);
        this.#stderr = Buffer.concat([
          this.#stderr.subarray(Math.max(0, this.#stderr.length - retain)),
          bytes,
        ]);
      }
    });
    try {
      await this.#sdk.connect(this.#transport, this.#requestOptions());
      this.#serverInfo = this.#sdk.getServerVersion();
      if (
        this.#serverInfo?.name !== "rea" ||
        this.#serverInfo?.version !== this.#expectedVersion
      ) {
        throw new ReaClientError(
          "REA_VERSION_MISMATCH",
          `Expected rea ${this.#expectedVersion}; received ${this.#serverInfo?.name ?? "unknown"} ${this.#serverInfo?.version ?? "unknown"}.`,
          {
            details: {
              expectedVersion: this.#expectedVersion,
              serverInfo: this.#serverInfo,
            },
          },
        );
      }
      if (this.#state !== "connecting")
        throw new ReaClientError(
          "REA_CLIENT_CLOSED",
          "REA connection was closed during initialization.",
        );
      await this.#discoverTools();
      if (this.#state !== "connecting")
        throw new ReaClientError(
          "REA_CLIENT_CLOSED",
          "REA connection was closed during tool discovery.",
        );
      this.#state = "connected";
      return this;
    } catch (error) {
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "REA startup and cleanup failed.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #discoverTools() {
    // SDK 2.3.1 walks every page here, caps the walk, validates protocol results,
    // and caches output schemas. An explicit cursor would disable aggregation.
    const result = await this.#sdk.listTools(undefined, {
      ...this.#requestOptions(),
      cacheMode: "refresh",
    });
    const definitions = new Map();
    for (const tool of result.tools) {
      if (definitions.has(tool.name)) {
        throw new ReaClientError(
          "REA_DUPLICATE_TOOL",
          `REA advertised the tool name ${tool.name} more than once.`,
          { result },
        );
      }
      // Caller edits to the returned catalog cannot change dispatch validation.
      definitions.set(tool.name, structuredClone(tool));
    }
    this.#definitions = definitions;
    this.#inputValidators.clear();
    return result;
  }

  async listTools() {
    this.#assertConnected();
    return this.#discoverTools();
  }

  async callTool(name, args = {}) {
    this.#assertConnected();
    const definition = this.#definitions.get(name);
    if (definition === undefined) {
      throw new ReaClientError(
        "REA_UNKNOWN_TOOL",
        `REA did not advertise tool ${String(name)}. Call listTools() to refresh discovery.`,
      );
    }
    let validate = this.#inputValidators.get(name);
    if (validate === undefined) {
      try {
        validate = this.#validator.getValidator(definition.inputSchema);
      } catch (cause) {
        throw new ReaClientError(
          "REA_INVALID_TOOL_SCHEMA",
          `The advertised input schema for ${name} could not be compiled.`,
          { cause },
        );
      }
      this.#inputValidators.set(name, validate);
    }
    const validation = validate(args);
    if (!validation.valid) {
      throw new ReaClientError(
        "REA_INVALID_TOOL_ARGUMENTS",
        `Invalid arguments for ${name}: ${validation.errorMessage}`,
        {
          details: { toolName: name, validation: validation.errorMessage },
        },
      );
    }
    const result = await this.#sdk.callTool(
      { name, arguments: args },
      {
        ...this.#requestOptions(),
        toolDefinition: definition,
      },
    );
    if (result.isError === true) throw new ReaToolError(name, result);
    this.#successfulTools.add(name);
    return result;
  }

  async session() {
    return this.callTool("binary_session", {
      expected_package_version: this.#expectedVersion,
    });
  }

  async exportBundle(path) {
    return this.callTool("export_evidence_bundle", {
      path: absolutePath(path),
      overwrite: false,
    });
  }

  async importBundle(path) {
    return this.callTool("import_evidence_bundle", {
      path: absolutePath(path),
    });
  }

  async close() {
    if (this.#closePromise) return this.#closePromise;
    if (!this.#sdk && !this.#transport) {
      this.#state = "closed";
      return;
    }
    this.#state = "closing";
    this.#closePromise = (async () => {
      // SDK closes only its child. Do not kill a PID or interfere with attached
      // targets, provider GUIs, or REA's process-ownership safeguards.
      await this.#sdk?.close();
      await this.#transport?.close();
      this.#sdk = undefined;
      this.#transport = undefined;
      this.#state = "closed";
    })();
    try {
      await this.#closePromise;
    } catch (error) {
      // Keep ownership references so a failed cleanup can be retried explicitly.
      this.#state = "close_failed";
      this.#closePromise = undefined;
      throw error;
    }
  }
}

export async function withRea(callback, options) {
  if (typeof callback !== "function")
    throw new TypeError("withRea requires a callback.");
  const client = new ReaClient(options);
  let failed = false;
  let failure;
  try {
    await client.connect();
    return await callback(client);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await client.close();
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError(
          [failure, cleanupError],
          "REA workflow and cleanup failed.",
          { cause: failure },
        );
      throw cleanupError;
    }
  }
}

function sessionData(result) {
  if (!object(result) || result.isError === true) return undefined;
  if (own(result, "structuredContent")) {
    return object(result.structuredContent)
      ? result.structuredContent.result
      : undefined;
  }
  // Accept a previously unwrapped result without guessing arbitrary nested paths.
  if (own(result, "tool_availability")) return result;
  if (object(result.result) && own(result.result, "tool_availability"))
    return result.result;
  return undefined;
}

/**
 * Join the actual binary_session.tool_availability.groups by their named tools.
 * Available means reported by REA, not executed or proven on a real target.
 * Missing/ambiguous reports remain unknown; false, null, and omission stay distinct.
 */
export function summarizeCapabilities(tools, sessionResult) {
  const catalog = Array.isArray(tools) ? tools : tools?.tools;
  if (!Array.isArray(catalog))
    throw new TypeError(
      "tools must be the advertised tool array or ListToolsResult.",
    );
  const session = sessionData(sessionResult);
  const groups = session?.tool_availability?.groups;
  const limitations = [];
  if (!Array.isArray(groups))
    limitations.push(
      "No structured binary_session tool availability groups were supplied; availability remains unknown.",
    );
  const reportedByName = new Map();
  for (const [index, group] of (Array.isArray(groups)
    ? groups
    : []
  ).entries()) {
    if (
      !object(group) ||
      !Array.isArray(group.names) ||
      group.names.some((name) => typeof name !== "string")
    ) {
      limitations.push(
        `Availability group ${index} has no valid tool names and was not joined.`,
      );
      continue;
    }
    for (const name of group.names) {
      const reports = reportedByName.get(name) ?? [];
      reports.push(group);
      reportedByName.set(name, reports);
    }
  }
  const seen = new Set();
  const counts = Object.fromEntries(
    [...AVAILABILITY_REASONS, "unknown"].map((reason) => [reason, 0]),
  );
  const rows = catalog.map((tool) => {
    if (!object(tool) || typeof tool.name !== "string" || seen.has(tool.name)) {
      throw new TypeError("Advertised tools must have distinct string names.");
    }
    seen.add(tool.name);
    const row = { name: tool.name, advertised: true, status: "unknown" };
    if (own(tool, "title")) row.title = tool.title;
    if (own(tool, "description")) row.description = tool.description;
    const reports = reportedByName.get(tool.name) ?? [];
    if (reports.length === 1) {
      const { names, ...report } = reports[0];
      Object.assign(row, structuredClone(report), {
        name: tool.name,
        advertised: true,
        status: "unknown",
      });
      if (
        report.available === true &&
        (report.reason === "available" || !own(report, "reason"))
      )
        row.status = "available";
      else if (
        report.available === false &&
        AVAILABILITY_REASONS.includes(report.reason) &&
        report.reason !== "available"
      )
        row.status = report.reason;
      else if (report.available === true || report.reason === "available") {
        limitations.push(
          `Availability fields for ${tool.name} are inconsistent or incomplete; status remains unknown.`,
        );
      }
    } else if (reports.length > 1) {
      row.availabilityReports = structuredClone(reports);
      limitations.push(
        `Multiple availability groups mention ${tool.name}; no single report was selected.`,
      );
    }
    counts[row.status] += 1;
    return row;
  });
  return {
    advertisedCount: catalog.length,
    counts,
    tools: rows,
    unmatchedAvailability: [...reportedByName]
      .filter(([name]) => !seen.has(name))
      .map(([name, reports]) => ({ name, reports: structuredClone(reports) })),
    ...(session?.server_identity === undefined
      ? {}
      : { serverIdentity: structuredClone(session.server_identity) }),
    verification: {
      availability: Array.isArray(groups) ? "server_reported" : "unknown",
      successfulTests: null,
      note: "This summary does not test tools. Use the client successfulTools list and retained run evidence for successful calls; provider readiness is target-specific.",
    },
    limitations,
  };
}
