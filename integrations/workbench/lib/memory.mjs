import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { link, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseEvidenceBundle } from "rea-agents/dist/domain/evidenceBundle.js";
import { summarizeEvidenceBundle } from "rea-agents/dist/domain/evidenceRecordSummary.js";

// These are workbench admission limits, not claims about REA analysis coverage.
// JSON parsing retains both the original bytes and parsed objects in memory.
export const MEMORY_LIMITS = Object.freeze({
  bundleBytes: 64 * 1024 * 1024,
  noteBytes: 64 * 1024,
  titleBytes: 4096,
  queryBytes: 4096,
  queryTerms: 64,
  results: 200,
});

const BUNDLE_ID = /^sha256_[a-f0-9]{64}$/u;
const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const error = (code, message, cause) =>
  Object.assign(new Error(message, { cause }), { code });

function absolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    value.split(sep).includes("..")
  ) {
    throw error(
      "UNSAFE_PATH",
      `${label} must be an absolute local path without parent traversal or NUL bytes.`,
    );
  }
  return resolve(value);
}

function validateId(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value))
    throw error("INVALID_ID", `Invalid ${label}.`);
  return value;
}

function boundedText(value, maxBytes, label, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.includes("\0")
  ) {
    throw error(
      "INVALID_TEXT",
      `${label} must be nonempty text without NUL bytes.`,
    );
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes)
    throw error("RESOURCE_LIMIT", `${label} exceeds ${maxBytes} UTF-8 bytes.`);
  return value;
}

function limitOf(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_LIMITS.results) {
    throw error(
      "RESOURCE_LIMIT",
      `Result limit must be an integer from 1 to ${MEMORY_LIMITS.results}.`,
    );
  }
  return limit;
}

function offsetOf(offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw error(
      "RESOURCE_LIMIT",
      "Result offset must be a nonnegative safe integer.",
    );
  }
  return offset;
}

// Reject existing symlink components before opening or creating owned files.
// The private root is a trust boundary; this is not a sandbox against its owner.
function safeDirectory(path, create = false) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (cause) {
      if (!create || cause.code !== "ENOENT") throw cause;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (failure) {
        if (failure.code !== "EEXIST") throw failure;
      }
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw error(
        "UNSAFE_PATH",
        `Expected a real directory, without symlinks: ${current}`,
      );
  }
  return lstatSync(path);
}

function ownedFile(path, { create = false } = {}) {
  if (create) {
    let fd;
    try {
      fd = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NOFOLLOW,
        0o600,
      );
    } catch (cause) {
      if (cause.code !== "EEXIST") throw cause;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch (cause) {
    if (cause.code === "ENOENT") return;
    throw cause;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw error(
      "UNSAFE_PATH",
      `Expected an unlinked regular memory file: ${path}`,
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw error(
      "UNSAFE_PATH",
      `Memory file is not owned by the current user: ${path}`,
    );
  }
  if ((stat.mode & 0o022) !== 0)
    throw error(
      "UNSAFE_PATH",
      `Memory file is writable by another user: ${path}`,
    );
}

async function readBounded(path) {
  safeDirectory(dirname(path));
  const selected = lstatSync(path, { bigint: true });
  if (!selected.isFile() || selected.isSymbolicLink())
    throw error(
      "UNSAFE_PATH",
      `Bundle must be a regular file without symlinks: ${path}`,
    );
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw error("UNSAFE_PATH", `Bundle must be a regular file: ${path}`);
    if (before.dev !== selected.dev || before.ino !== selected.ino)
      throw error(
        "INPUT_CHANGED",
        "Bundle file identity changed while opening.",
      );
    if (before.size > BigInt(MEMORY_LIMITS.bundleBytes)) {
      throw error(
        "RESOURCE_LIMIT",
        `Bundle exceeds the workbench limit of ${MEMORY_LIMITS.bundleBytes} bytes; the original remains untouched.`,
      );
    }
    const chunks = [];
    let length = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, MEMORY_LIMITS.bundleBytes + 1 - length),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MEMORY_LIMITS.bundleBytes)
        throw error(
          "RESOURCE_LIMIT",
          `Bundle grew beyond ${MEMORY_LIMITS.bundleBytes} bytes while reading.`,
        );
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw error(
        "INPUT_CHANGED",
        "Bundle changed while being read. Export a stable bundle and retry.",
      );
    }
    return Buffer.concat(chunks, length);
  } finally {
    await handle?.close();
  }
}

function parseBundle(bytes) {
  try {
    // REA owns evidence identity, manifests, unknown revisions and graph rules.
    // A lossy decode could turn malformed bytes into a valid literal U+FFFD
    // while retaining the same REA semantic ID. Authenticate the actual UTF-8.
    const json = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return parseEvidenceBundle(JSON.parse(json));
  } catch (cause) {
    throw error(
      "INVALID_BUNDLE",
      "REA rejected the canonical bundle. Supply an unmodified export_evidence_bundle / evidence-export file, not a command result or a session ID.",
      cause,
    );
  }
}

function indexEntry(summary, evidence, title) {
  const metadata = {
    ...summary,
    predicate_type: evidence.predicate_type,
    limitations: evidence.limitations,
    relationship_coverage: evidence.relationship_coverage,
    ...(title === null ? {} : { analyst_bundle_title: title }),
  };
  return {
    summary: JSON.stringify(summary),
    limitations: JSON.stringify(evidence.limitations),
    coverage: JSON.stringify(evidence.relationship_coverage),
    // This intentionally excludes raw_result, parameters and application source.
    search: JSON.stringify(metadata),
  };
}

function entryMatches(entry, ordinal, summary, evidence, title) {
  if (entry === undefined || evidence === undefined) return false;
  const expected = indexEntry(summary, evidence, title);
  return (
    entry.ordinal === ordinal &&
    entry.evidence_id === evidence.evidence_id &&
    entry.summary_json === expected.summary &&
    entry.limitations_json === expected.limitations &&
    entry.coverage_json === expected.coverage &&
    entry.search_text === expected.search
  );
}

function bundleSummary(row) {
  return {
    bundleId: row.bundle_id,
    sha256: row.sha256,
    bytes: row.bytes,
    title: row.title,
    importedAt: row.imported_at,
    recordCount: row.record_count,
    unknownRevisions: row.unknown_count,
    validation: {
      canonicalParser: "rea-agents@6.5.0:parseEvidenceBundle",
      validatedByRea: row.validated_by_rea === 1,
      reaImporterValidatedAt: row.rea_validated_at,
    },
  };
}

/** Local durable discovery for unchanged REA bundles; session handles are never stored as identity. */
export class InvestigationMemory {
  #db;
  #root;
  #objects;
  #identity;
  #objectIdentity;
  #closed = false;
  #fts = false;

  constructor(root) {
    this.#root = absolutePath(root, "Memory root");
    this.#identity = safeDirectory(this.#root, true);
    if (
      (this.#identity.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" &&
        this.#identity.uid !== process.getuid())
    ) {
      throw error(
        "UNSAFE_PATH",
        "Memory root must be owned by the current user and not writable by other users.",
      );
    }
    this.#objects = join(this.#root, "bundles");
    this.#objectIdentity = safeDirectory(this.#objects, true);
    if (
      (this.#objectIdentity.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" &&
        this.#objectIdentity.uid !== process.getuid())
    ) {
      throw error(
        "UNSAFE_PATH",
        "Bundle directory must be owned by the current user and not writable by other users.",
      );
    }
    const dbPath = join(this.#root, "memory.sqlite");
    ownedFile(dbPath, { create: true });
    for (const suffix of ["-wal", "-shm", "-journal"])
      ownedFile(`${dbPath}${suffix}`);
    this.#db = new DatabaseSync(dbPath);
    try {
      this.#db.exec(
        "PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
      );
      this.#transaction(() => {
        const { user_version: version } = this.#db
          .prepare("PRAGMA user_version")
          .get();
        if (version !== 0 && version !== 1)
          throw error(
            "UNSUPPORTED_VERSION",
            `Memory schema ${version} is unsupported; use its matching workbench version.`,
          );
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS bundles (
            bundle_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
            title TEXT, imported_at TEXT NOT NULL, record_count INTEGER NOT NULL,
            unknown_count INTEGER NOT NULL, validated_by_rea INTEGER NOT NULL DEFAULT 0,
            rea_validated_at TEXT
          );
          CREATE TABLE IF NOT EXISTS evidence (
            evidence_id TEXT PRIMARY KEY, first_imported_at TEXT NOT NULL,
            latest_bundle_id TEXT NOT NULL REFERENCES bundles(bundle_id)
          );
          CREATE TABLE IF NOT EXISTS bundle_records (
            id INTEGER PRIMARY KEY, evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
            bundle_id TEXT NOT NULL REFERENCES bundles(bundle_id), ordinal INTEGER NOT NULL,
            summary_json TEXT NOT NULL, limitations_json TEXT NOT NULL,
            coverage_json TEXT NOT NULL, search_text TEXT NOT NULL,
            UNIQUE(bundle_id, evidence_id), UNIQUE(bundle_id, ordinal)
          );
          CREATE INDEX IF NOT EXISTS bundle_records_evidence ON bundle_records(evidence_id);
          CREATE TABLE IF NOT EXISTS notes (
            note_id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
            text TEXT NOT NULL, created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS notes_evidence ON notes(evidence_id);
          PRAGMA user_version = 1;
        `);
        try {
          this.#db.exec(
            "CREATE VIRTUAL TABLE IF NOT EXISTS evidence_search USING fts5(evidence_id UNINDEXED, bundle_id UNINDEXED, metadata); CREATE VIRTUAL TABLE IF NOT EXISTS notes_search USING fts5(note_id UNINDEXED, evidence_id UNINDEXED, text);",
          );
          this.#fts = true;
        } catch (cause) {
          if (!/no such module: fts5/iu.test(cause.message)) throw cause;
        }
        if (this.#fts) {
          // Backfill only missing rows, including a database moved from a build without FTS5.
          this.#db.exec(`
            INSERT INTO evidence_search(rowid, evidence_id, bundle_id, metadata)
              SELECT r.id, r.evidence_id, r.bundle_id, r.search_text FROM bundle_records r
              WHERE NOT EXISTS (SELECT 1 FROM evidence_search s WHERE s.rowid = r.id);
            INSERT INTO notes_search(rowid, note_id, evidence_id, text)
              SELECT n.rowid, n.note_id, n.evidence_id, n.text FROM notes n
              WHERE NOT EXISTS (SELECT 1 FROM notes_search s WHERE s.rowid = n.rowid);
          `);
        }
      });
    } catch (cause) {
      this.#db.close();
      this.#closed = true;
      throw cause;
    }
  }

  get root() {
    return this.#root;
  }
  get searchMode() {
    return this.#fts ? "fts5" : "substring";
  }

  #assertOpen() {
    if (this.#closed)
      throw error("MEMORY_CLOSED", "Investigation memory is closed.");
    for (const [path, expected] of [
      [this.#root, this.#identity],
      [this.#objects, this.#objectIdentity],
    ]) {
      const actual = safeDirectory(path);
      if (actual.dev !== expected.dev || actual.ino !== expected.ino)
        throw error(
          "UNSAFE_PATH",
          `Memory directory identity changed: ${path}`,
        );
    }
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      ownedFile(join(this.#root, `memory.sqlite${suffix}`));
  }

  #transaction(operation) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* Preserve the original failure. */
      }
      throw cause;
    }
  }

  bundlePath(bundleId) {
    this.#assertOpen();
    validateId(bundleId, BUNDLE_ID, "bundle ID");
    return join(this.#objects, `${bundleId.slice(7)}.json`);
  }

  async #preserve(bundleId, bytes) {
    const destination = this.bundlePath(bundleId);
    const temporary = join(this.#objects, `.${randomUUID()}.tmp`);
    let handle;
    let created = false;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
        0o600,
      );
      created = true;
      await handle.writeFile(bytes);
      await handle.chmod(0o400);
      await handle.sync();
      await handle.close();
      handle = undefined;
      this.#assertOpen();
      try {
        // link publishes a complete file atomically and cannot replace an existing object.
        await link(temporary, destination);
      } catch (cause) {
        if (cause.code !== "EEXIST") throw cause;
        if (hash(await readBounded(destination)) !== bundleId.slice(7)) {
          throw error(
            "BUNDLE_TAMPERED",
            `Existing bundle fails SHA-256 verification and was not overwritten: ${bundleId}`,
          );
        }
      }
    } finally {
      await handle?.close();
      if (created)
        await unlink(temporary).catch((cause) => {
          if (cause.code !== "ENOENT") throw cause;
        });
    }
    // Persist the new directory entry before publishing its SQLite index.
    if (process.platform !== "win32") {
      const directory = await open(
        this.#objects,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }

  async importBundle(
    path,
    { title, validatedByRea = false, expectedSha256 } = {},
  ) {
    this.#assertOpen();
    const source = absolutePath(path, "Bundle path");
    const chosenTitle =
      title === undefined
        ? null
        : boundedText(title, MEMORY_LIMITS.titleBytes, "Bundle title");
    if (typeof validatedByRea !== "boolean")
      throw error(
        "INVALID_VALIDATION",
        "validatedByRea must be a boolean supplied by the REA importer workflow.",
      );
    if (expectedSha256 !== undefined)
      validateId(expectedSha256, DIGEST, "expected SHA-256");
    const bytes = await readBounded(source);
    const sha256 = hash(bytes);
    if (expectedSha256 !== undefined && sha256 !== expectedSha256)
      throw error(
        "INPUT_CHANGED",
        "Bundle SHA-256 differs from the validation snapshot; importer provenance was not recorded.",
      );
    const bundle = parseBundle(bytes);
    const summaries = summarizeEvidenceBundle(bundle).records;
    const bundleId = `sha256_${sha256}`;
    await this.#preserve(bundleId, bytes);
    this.#assertOpen();
    return this.#transaction(() => {
      const now = new Date().toISOString();
      const existing = this.#db
        .prepare("SELECT * FROM bundles WHERE bundle_id = ?")
        .get(bundleId);
      let addedEvidence = 0;
      if (existing === undefined) {
        this.#db
          .prepare("INSERT INTO bundles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            bundleId,
            sha256,
            bytes.length,
            chosenTitle,
            now,
            bundle.records.length,
            bundle.unknowns.length,
            Number(validatedByRea),
            validatedByRea ? now : null,
          );
        const addEvidence = this.#db.prepare(
          "INSERT OR IGNORE INTO evidence VALUES (?, ?, ?)",
        );
        const selectBundle = this.#db.prepare(
          "UPDATE evidence SET latest_bundle_id = ? WHERE evidence_id = ?",
        );
        const addRecord = this.#db.prepare(
          "INSERT INTO bundle_records(evidence_id, bundle_id, ordinal, summary_json, limitations_json, coverage_json, search_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        const addSearch = this.#fts
          ? this.#db.prepare(
              "INSERT INTO evidence_search(rowid, evidence_id, bundle_id, metadata) VALUES (?, ?, ?, ?)",
            )
          : null;
        for (const [ordinal, evidence] of bundle.records.entries()) {
          const id = evidence.evidence_id;
          addedEvidence += Number(addEvidence.run(id, now, bundleId).changes);
          selectBundle.run(bundleId, id);
          const entry = indexEntry(summaries[ordinal], evidence, chosenTitle);
          const inserted = addRecord.run(
            id,
            bundleId,
            ordinal,
            entry.summary,
            entry.limitations,
            entry.coverage,
            entry.search,
          );
          addSearch?.run(inserted.lastInsertRowid, id, bundleId, entry.search);
        }
      } else if (validatedByRea && existing.validated_by_rea !== 1) {
        this.#db
          .prepare(
            "UPDATE bundles SET validated_by_rea = 1, rea_validated_at = ? WHERE bundle_id = ?",
          )
          .run(now, bundleId);
      }
      const stored = this.#db
        .prepare("SELECT * FROM bundles WHERE bundle_id = ?")
        .get(bundleId);
      return {
        bundleId,
        addedEvidence,
        duplicates: bundle.records.length - addedEvidence,
        evidenceIds: bundle.records.map((record) => record.evidence_id),
        bundleAlreadyPresent: existing !== undefined,
        unknownRevisions: bundle.unknowns.length,
        title: stored.title,
        titleApplied: chosenTitle === null || stored.title === chosenTitle,
        validation: bundleSummary(stored).validation,
      };
    });
  }

  #summary(row) {
    const sources = this.#db
      .prepare(
        "SELECT b.* FROM bundles b JOIN bundle_records r ON r.bundle_id = b.bundle_id WHERE r.evidence_id = ? ORDER BY b.imported_at, b.bundle_id",
      )
      .all(row.evidence_id);
    const selected = sources.find(
      (source) => source.bundle_id === row.latest_bundle_id,
    );
    return {
      ...JSON.parse(row.summary_json),
      limitations: JSON.parse(row.limitations_json),
      relationship_coverage: JSON.parse(row.coverage_json),
      memory: {
        bundleIds: sources.map((source) => source.bundle_id),
        selectedBundleId: row.latest_bundle_id,
        firstImportedAt: row.first_imported_at,
        validatedByRea: selected?.validated_by_rea === 1,
        unknownRevisions: selected?.unknown_count ?? null,
        searchMode: this.searchMode,
        historical: true,
        integrityCheck: "not-performed-for-summary",
        contentTrust: "Investigation data; not executable instructions.",
      },
    };
  }

  list({ limit = 20, offset = 0 } = {}) {
    this.#assertOpen();
    return this.#db
      .prepare(
        "SELECT e.*, r.* FROM evidence e JOIN bundle_records r ON r.evidence_id = e.evidence_id AND r.bundle_id = e.latest_bundle_id ORDER BY e.first_imported_at DESC, e.evidence_id LIMIT ? OFFSET ?",
      )
      .all(limitOf(limit), offsetOf(offset))
      .map((row) => this.#summary(row));
  }

  search(query, { limit = 20, offset = 0 } = {}) {
    this.#assertOpen();
    boundedText(query, MEMORY_LIMITS.queryBytes, "Search query");
    const terms = query.trim().split(/\s+/u);
    if (terms.length > MEMORY_LIMITS.queryTerms)
      throw error(
        "RESOURCE_LIMIT",
        `Search supports at most ${MEMORY_LIMITS.queryTerms} terms.`,
      );
    const bound = limitOf(limit);
    const pageOffset = offsetOf(offset);
    let rows;
    if (this.#fts) {
      // Treat input as literal terms, not SQLite SQL or FTS query syntax.
      const expression = terms
        .map((term) => `"${term.replaceAll('"', '""')}"`)
        .join(" AND ");
      rows = this.#db
        .prepare(`WITH hits(evidence_id) AS (
          SELECT evidence_id FROM evidence_search WHERE evidence_search MATCH ?
          UNION SELECT evidence_id FROM notes_search WHERE notes_search MATCH ?
        ) SELECT e.*, r.* FROM hits h JOIN evidence e ON e.evidence_id = h.evidence_id
        JOIN bundle_records r ON r.evidence_id = e.evidence_id AND r.bundle_id = e.latest_bundle_id
        ORDER BY e.first_imported_at DESC, e.evidence_id LIMIT ? OFFSET ?`)
        .all(expression, expression, bound, pageOffset);
    } else {
      const patterns = terms.map(
        (term) => `%${term.replace(/[\\%_]/gu, "\\$&")}%`,
      );
      const match = (column) =>
        patterns.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND ");
      rows = this.#db
        .prepare(`WITH hits(evidence_id) AS (
          SELECT evidence_id FROM bundle_records WHERE ${match("search_text")}
          UNION SELECT evidence_id FROM notes WHERE ${match("text")}
        ) SELECT e.*, r.* FROM hits h JOIN evidence e ON e.evidence_id = h.evidence_id
        JOIN bundle_records r ON r.evidence_id = e.evidence_id AND r.bundle_id = e.latest_bundle_id
        ORDER BY e.first_imported_at DESC, e.evidence_id LIMIT ? OFFSET ?`)
        .all(...patterns, ...patterns, bound, pageOffset);
    }
    return rows.map((row) => this.#summary(row));
  }

  async get(evidenceId) {
    this.#assertOpen();
    validateId(evidenceId, EVIDENCE_ID, "REA evidence ID");
    const row = this.#db
      .prepare("SELECT * FROM evidence WHERE evidence_id = ?")
      .get(evidenceId);
    if (row === undefined) return null;
    const sources = this.#db
      .prepare(
        "SELECT b.* FROM bundles b JOIN bundle_records r ON r.bundle_id = b.bundle_id WHERE r.evidence_id = ? ORDER BY b.imported_at DESC, b.bundle_id",
      )
      .all(evidenceId);
    const bytes = await readBounded(this.bundlePath(row.latest_bundle_id));
    const digest = hash(bytes);
    if (digest !== row.latest_bundle_id.slice(7))
      throw error(
        "BUNDLE_TAMPERED",
        `SHA-256 verification failed: ${row.latest_bundle_id}`,
      );
    const bundle = parseBundle(bytes);
    const ordinal = bundle.records.findIndex(
      (record) => record.evidence_id === evidenceId,
    );
    const evidence = bundle.records[ordinal];
    if (evidence === undefined)
      throw error(
        "INDEX_MISMATCH",
        "The evidence index points to a bundle that does not contain its record.",
      );
    this.#assertOpen();
    const selected = sources.find(
      (source) => source.bundle_id === row.latest_bundle_id,
    );
    const indexed = this.#db
      .prepare(
        "SELECT * FROM bundle_records WHERE bundle_id = ? AND evidence_id = ?",
      )
      .get(row.latest_bundle_id, evidenceId);
    const summary = summarizeEvidenceBundle(bundle, { evidence_id: evidenceId })
      .records[0];
    if (
      selected === undefined ||
      selected.sha256 !== digest ||
      selected.bytes !== bytes.length ||
      selected.record_count !== bundle.records.length ||
      selected.unknown_count !== bundle.unknowns.length ||
      !entryMatches(indexed, ordinal, summary, evidence, selected.title)
    ) {
      throw error(
        "INDEX_MISMATCH",
        "Stored bundle metadata or its selected evidence index differs from the authenticated original.",
      );
    }
    return {
      evidence,
      bundleEvidenceIds: bundle.records.map((record) => record.evidence_id),
      unknowns: bundle.unknowns,
      unknownsFromBundle: row.latest_bundle_id,
      selectedBundleId: row.latest_bundle_id,
      bundles: sources.map(bundleSummary),
      notes: this.#db
        .prepare(
          "SELECT note_id AS noteId, evidence_id AS evidenceId, text, created_at AS createdAt FROM notes WHERE evidence_id = ? ORDER BY created_at, note_id",
        )
        .all(evidenceId)
        .map((note) => ({
          ...note,
          kind: "analyst-note",
          authority: "user-supplied; not REA evidence",
        })),
      integrity: {
        sha256: digest,
        verified: true,
        scope:
          "Selected retained bundle bytes, REA canonical form, and selected index metadata; current target behavior was not re-tested.",
      },
    };
  }

  note(evidenceId, text) {
    this.#assertOpen();
    validateId(evidenceId, EVIDENCE_ID, "REA evidence ID");
    boundedText(text, MEMORY_LIMITS.noteBytes, "Analyst note");
    const noteId = randomUUID();
    const createdAt = new Date().toISOString();
    return this.#transaction(() => {
      if (
        !this.#db
          .prepare("SELECT 1 FROM evidence WHERE evidence_id = ?")
          .get(evidenceId)
      )
        throw error(
          "EVIDENCE_NOT_FOUND",
          "A note must refer to an imported REA evidence record.",
        );
      const inserted = this.#db
        .prepare("INSERT INTO notes VALUES (?, ?, ?, ?)")
        .run(noteId, evidenceId, text, createdAt);
      if (this.#fts)
        this.#db
          .prepare(
            "INSERT INTO notes_search(rowid, note_id, evidence_id, text) VALUES (?, ?, ?, ?)",
          )
          .run(inserted.lastInsertRowid, noteId, evidenceId, text);
      return {
        noteId,
        evidenceId,
        text,
        createdAt,
        kind: "analyst-note",
        authority: "user-supplied; not REA evidence",
      };
    });
  }

  async verify(bundleId) {
    this.#assertOpen();
    if (bundleId !== undefined) validateId(bundleId, BUNDLE_ID, "bundle ID");
    // Capture the index state synchronously; never hold a SQLite write lock across I/O.
    const snapshot = this.#transaction(() => {
      const bundles =
        bundleId === undefined
          ? this.#db.prepare("SELECT * FROM bundles ORDER BY bundle_id").all()
          : this.#db
              .prepare("SELECT * FROM bundles WHERE bundle_id = ?")
              .all(bundleId);
      if (bundleId !== undefined && bundles.length === 0)
        throw error("BUNDLE_NOT_FOUND", `Bundle is not indexed: ${bundleId}`);
      return {
        bundles: bundles.map((row) => ({
          row,
          index: this.#db
            .prepare(
              "SELECT * FROM bundle_records WHERE bundle_id = ? ORDER BY ordinal",
            )
            .all(row.bundle_id),
        })),
        sqlite: this.#db
          .prepare("PRAGMA integrity_check")
          .all()
          .map((row) => row.integrity_check),
        foreignKeys: this.#db.prepare("PRAGMA foreign_key_check").all(),
      };
    });
    const bundles = [];
    for (const { row, index } of snapshot.bundles) {
      const result = { ...bundleSummary(row), status: "verified" };
      try {
        const bytes = await readBounded(this.bundlePath(row.bundle_id));
        const actual = hash(bytes);
        result.actualSha256 = actual;
        if (
          actual !== row.sha256 ||
          row.bundle_id !== `sha256_${actual}` ||
          bytes.length !== row.bytes
        ) {
          result.status = "sha256-mismatch";
        } else {
          const bundle = parseBundle(bytes);
          const summaries = summarizeEvidenceBundle(bundle).records;
          const matches =
            row.record_count === bundle.records.length &&
            row.unknown_count === bundle.unknowns.length &&
            index.length === bundle.records.length &&
            index.every((entry, ordinal) =>
              entryMatches(
                entry,
                ordinal,
                summaries[ordinal],
                bundle.records[ordinal],
                row.title,
              ),
            );
          if (!matches) result.status = "index-mismatch";
        }
      } catch (cause) {
        result.status =
          cause.code === "ENOENT"
            ? "missing"
            : cause.code === "INVALID_BUNDLE"
              ? "canonical-invalid"
              : "unreadable";
        result.error = {
          code: cause.code ?? "READ_FAILED",
          message: cause.message,
        };
      }
      bundles.push(result);
    }
    const known = new Set(
      this.#db
        .prepare("SELECT bundle_id FROM bundles")
        .all()
        .map((row) => `${row.bundle_id.slice(7)}.json`),
    );
    const unindexedBundles = (await readdir(this.#objects))
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name) && !known.has(name))
      .sort();
    return {
      ok:
        snapshot.sqlite.length === 1 &&
        snapshot.sqlite[0] === "ok" &&
        snapshot.foreignKeys.length === 0 &&
        bundles.every((bundle) => bundle.status === "verified"),
      checkedBundles: bundles.length,
      bundles,
      sqlite: {
        integrity: snapshot.sqlite,
        foreignKeyViolations: snapshot.foreignKeys,
      },
      unindexedBundles,
      searchMode: this.searchMode,
      scope:
        "Retained bundle hashes, REA canonical form, and local metadata correspondence. This does not prove artifact authenticity, runtime behavior, or analysis completeness.",
    };
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
