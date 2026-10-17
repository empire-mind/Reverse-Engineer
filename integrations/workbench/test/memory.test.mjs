import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEvidence } from "rea-agents/dist/domain/evidence.js";
import { createEvidenceBundle } from "rea-agents/dist/domain/evidenceBundle.js";
import { createResidualUnknown } from "rea-agents/dist/domain/residualUnknown.js";
import { InvestigationMemory, MEMORY_LIMITS } from "../lib/memory.mjs";

const provider = { id: "fixture", name: "Owned test fixture", version: "1" };
const target = {
  path: "/selected/launcher.js",
  sha256: "a".repeat(64),
  format: "javascript",
  architecture: null,
};

function fixture(path = target.path) {
  const evidence = createEvidence({ ...target, path }, provider, {
    operation: "analyze_javascript_application",
    parameters: { rawOnlyParameter: "ParameterNotAutomaticallySearchable" },
    rawResult: { source: "RawSourceNotAutomaticallySearchable" },
    result: {
      source: "ApplicationSourceNotAutomaticallySearchable",
      coverage: { selected: 1, omitted: 9 },
    },
    confidence: "inferred",
    limitations: [
      "Only one launcher was selected; runtime equivalence remains unverified.",
    ],
    relationshipCoverage: {
      status: "unknown",
      reason: "Dynamic call targets were not observed.",
    },
  });
  const mutation = createEvidence({ ...target, path }, provider, {
    operation: "record_residual_unknown",
    predicateType: "rea.residual-unknown-mutation",
    result: { status: "recorded" },
    parameters: {},
  });
  const unknown = createResidualUnknown(
    {
      question: "Does the selected launcher match runtime behavior?",
      domain: "runtime",
      severity: "high",
      supporting_evidence_ids: [evidence.evidence_id],
      contradicting_evidence_ids: [],
      required_authority: "controlled-replay",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [
        {
          operation: "controlled-replay",
          rationale: "Runtime behavior has not been observed.",
        },
      ],
      relationships: [],
    },
    mutation.evidence_id,
    target.sha256,
  );
  return {
    evidence,
    mutation,
    unknown,
    bundle: createEvidenceBundle([evidence, mutation], [unknown]),
  };
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "rea-memory-test-"));
  const root = join(directory, "memory");
  const source = join(directory, "export.json");
  const data = fixture();
  const bytes = Buffer.from(`${JSON.stringify(data.bundle, null, 2)}\n`);
  await writeFile(source, bytes);
  const memories = [];
  const connect = () => {
    const memory = new InvestigationMemory(root);
    memories.push(memory);
    return memory;
  };
  t.after(async () => {
    for (const memory of memories) memory.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root, source, data, bytes, connect };
}

test("retains exact canonical bytes, identity, complete unknown ledger, confidence and separate notes across reopen", async (t) => {
  const { source, data, bytes, connect } = await setup(t);
  const memory = connect();
  const digest = createHash("sha256").update(bytes).digest("hex");
  const imported = await memory.importBundle(source, {
    title: "Launcher investigation",
    expectedSha256: digest,
    validatedByRea: true,
  });
  assert.equal(imported.bundleId, `sha256_${digest}`);
  assert.equal(imported.addedEvidence, 2);
  assert.equal(imported.validation.validatedByRea, true);
  assert.deepEqual(await readFile(memory.bundlePath(imported.bundleId)), bytes);
  assert.equal(
    (await lstat(memory.bundlePath(imported.bundleId))).mode & 0o222,
    0,
  );
  const originalId = data.evidence.evidence_id;
  const note = memory.note(
    originalId,
    "Analyst hypothesis: retry with controlled observation.",
  );
  assert.equal(note.kind, "analyst-note");
  memory.close();
  const reopened = connect();
  const saved = await reopened.get(originalId);
  assert.deepEqual(saved.evidence, data.evidence);
  assert.deepEqual(saved.unknowns, [data.unknown]);
  assert.equal(saved.unknownsFromBundle, imported.bundleId);
  assert.equal(saved.evidence.confidence, "inferred");
  assert.equal(saved.evidence.relationship_coverage.status, "unknown");
  assert.equal(saved.notes[0].text, note.text);
  assert.equal(saved.notes[0].authority, "user-supplied; not REA evidence");
  const verification = await reopened.verify();
  assert.equal(verification.ok, true);
  assert.equal(verification.checkedBundles, 1);
  assert.equal(verification.bundles[0].unknownRevisions, 1);
  assert.match(verification.scope, /does not prove/u);
  assert.equal(await reopened.get(`ev_${"f".repeat(64)}`), null);
});

test("deduplicates repeat imports and semantic IDs while preserving relocated display metadata in each original bundle", async (t) => {
  const { directory, source, data, connect } = await setup(t);
  const memory = connect();
  const first = await memory.importBundle(source, {
    title: "First selected path",
  });
  const repeated = await memory.importBundle(source, {
    title: "Accidental replacement title",
    validatedByRea: true,
  });
  assert.equal(repeated.bundleId, first.bundleId);
  assert.equal(repeated.addedEvidence, 0);
  assert.equal(repeated.duplicates, 2);
  assert.equal(repeated.titleApplied, false);
  assert.equal(repeated.title, "First selected path");
  assert.equal(repeated.validation.validatedByRea, true);
  const relocated = fixture("/different/relocated-special-name.js");
  assert.equal(relocated.evidence.evidence_id, data.evidence.evidence_id);
  const secondFile = join(directory, "relocated.json");
  await writeFile(secondFile, JSON.stringify(relocated.bundle));
  const second = await memory.importBundle(secondFile);
  assert.equal(second.addedEvidence, 0);
  assert.equal(second.duplicates, 2);
  assert.notEqual(second.bundleId, first.bundleId);
  assert.equal(memory.list().length, 2);
  assert.equal(memory.search("relocated-special-name").length, 2);
  assert.equal(memory.search("launcher").length, 2);
  const saved = await memory.get(data.evidence.evidence_id);
  assert.equal(saved.bundles.length, 2);
  assert.equal(
    saved.evidence.subject.local_path,
    relocated.evidence.subject.local_path,
  );
  assert.equal(saved.selectedBundleId, second.bundleId);
  assert.equal((await memory.verify()).ok, true);
});

test("search indexes producer summaries and explicit notes without indexing raw source or parameters", async (t) => {
  const { source, data, connect } = await setup(t);
  const memory = connect();
  await memory.importBundle(source);
  assert.equal(
    memory.search("analyze_javascript_application")[0].evidence_id,
    data.evidence.evidence_id,
  );
  assert.equal(
    memory.search("equivalence")[0].limitations[0],
    data.evidence.limitations[0],
  );
  assert.equal(memory.search("RawSourceNotAutomaticallySearchable").length, 0);
  assert.equal(
    memory.search("ApplicationSourceNotAutomaticallySearchable").length,
    0,
  );
  assert.equal(memory.search("ParameterNotAutomaticallySearchable").length, 0);
  memory.note(
    data.evidence.evidence_id,
    "Human followup ZebraAstronomy for 仮説 observation.",
  );
  const matched = memory.search("ZebraAstronomy");
  assert.equal(matched.length, 1);
  assert.equal(matched[0].confidence, "inferred");
  assert.equal(memory.search("仮説").length, 1);
  assert.deepEqual(memory.search('" OR 1=1 --'), []);
  assert.equal((await memory.verify()).ok, true);
});

test("tampered retained bytes fail verify and show and cannot be silently overwritten by reimport", async (t) => {
  const { source, connect } = await setup(t);
  const memory = connect();
  const imported = await memory.importBundle(source);
  const path = memory.bundlePath(imported.bundleId);
  await chmod(path, 0o600);
  await writeFile(path, '{"tampered":true}');
  const verification = await memory.verify(imported.bundleId);
  assert.equal(verification.ok, false);
  assert.equal(verification.bundles[0].status, "sha256-mismatch");
  await assert.rejects(memory.get(imported.evidenceIds[0]), {
    code: "BUNDLE_TAMPERED",
  });
  await assert.rejects(memory.importBundle(source), {
    code: "BUNDLE_TAMPERED",
  });
  assert.equal(await readFile(path, "utf8"), '{"tampered":true}');
});

test("show rejects altered selected index metadata even when original bundle bytes still authenticate", async (t) => {
  const { root, source, data, connect } = await setup(t);
  const memory = connect();
  const imported = await memory.importBundle(source);
  const database = new DatabaseSync(join(root, "memory.sqlite"));
  try {
    database
      .prepare(
        "UPDATE bundles SET unknown_count = unknown_count + 1 WHERE bundle_id = ?",
      )
      .run(imported.bundleId);
    await assert.rejects(memory.get(data.evidence.evidence_id), {
      code: "INDEX_MISMATCH",
    });
    assert.equal((await memory.verify()).bundles[0].status, "index-mismatch");
    database
      .prepare(
        "UPDATE bundles SET unknown_count = unknown_count - 1 WHERE bundle_id = ?",
      )
      .run(imported.bundleId);
    database
      .prepare(
        "UPDATE bundle_records SET limitations_json = ? WHERE evidence_id = ?",
      )
      .run("[]", data.evidence.evidence_id);
    await assert.rejects(memory.get(data.evidence.evidence_id), {
      code: "INDEX_MISMATCH",
    });
    assert.equal((await memory.verify()).bundles[0].status, "index-mismatch");
    const bytes = await readFile(memory.bundlePath(imported.bundleId));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      imported.bundleId.slice(7),
    );
  } finally {
    database.close();
  }
});

test("rejects malformed or forged REA bundles and does not mislabel a storage hash as importer validation", async (t) => {
  const { source, data, connect } = await setup(t);
  const memory = connect();
  await assert.rejects(
    memory.importBundle(source, {
      validatedByRea: true,
      expectedSha256: "0".repeat(64),
    }),
    { code: "INPUT_CHANGED" },
  );
  await writeFile(source, JSON.stringify(data.evidence));
  await assert.rejects(memory.importBundle(source), { code: "INVALID_BUNDLE" });
  const forged = structuredClone(data.bundle);
  forged.records[0].normalized_result = { substituted: true };
  await writeFile(source, JSON.stringify(forged));
  await assert.rejects(memory.importBundle(source, { validatedByRea: true }), {
    code: "INVALID_BUNDLE",
  });
  assert.equal(memory.list().length, 0);
  assert.deepEqual(await readdir(join(memory.root, "bundles")), []);
  await writeFile(source, JSON.stringify(data.bundle));
  const imported = await memory.importBundle(source);
  assert.equal(imported.validation.validatedByRea, false);
  assert.equal(
    imported.validation.canonicalParser,
    "rea-agents@6.5.0:parseEvidenceBundle",
  );
});

test("rejects malformed UTF-8 that a lossy decode would give the same valid REA evidence identity", async (t) => {
  const { source, connect } = await setup(t);
  const memory = connect();
  const evidence = createEvidence(target, provider, {
    operation: "inspect_literal_text",
    parameters: {},
    result: { literal: "\uFFFD" },
  });
  const valid = Buffer.from(JSON.stringify(createEvidenceBundle([evidence])));
  const replacement = Buffer.from("\uFFFD");
  const position = valid.indexOf(replacement);
  assert.ok(position >= 0);
  const malformed = Buffer.concat([
    valid.subarray(0, position),
    Buffer.from([0xff]),
    valid.subarray(position + replacement.length),
  ]);
  assert.equal(
    malformed.toString("utf8"),
    valid.toString("utf8"),
    "The regression must reproduce the lossy-decode identity collision.",
  );
  await writeFile(source, malformed);
  await assert.rejects(memory.importBundle(source, { validatedByRea: true }), {
    code: "INVALID_BUNDLE",
  });
  assert.deepEqual(memory.list(), []);
  assert.deepEqual(await readdir(join(memory.root, "bundles")), []);
  assert.equal((await memory.verify()).checkedBundles, 0);
  await writeFile(source, valid);
  const imported = await memory.importBundle(source);
  assert.equal(
    imported.addedEvidence,
    1,
    "A literal, correctly encoded replacement character remains valid evidence.",
  );
});

test("list and search traverse more than 100 records in stable pages without omitted or repeated identities", async (t) => {
  const { source, connect } = await setup(t);
  const memory = connect();
  const records = Array.from({ length: 105 }, (_, ordinal) =>
    createEvidence(target, provider, {
      operation: "inspect_pagination_fixture",
      parameters: {},
      result: { ordinal },
    }),
  );
  await writeFile(source, JSON.stringify(createEvidenceBundle(records)));
  await memory.importBundle(source);
  const expected = records.map((record) => record.evidence_id).sort();
  for (const select of [
    (offset) => memory.list({ limit: 40, offset }),
    (offset) =>
      memory.search("inspect_pagination_fixture", { limit: 40, offset }),
  ]) {
    const pages = [select(0), select(40), select(80), select(120)];
    assert.deepEqual(
      pages.map((page) => page.length),
      [40, 40, 25, 0],
    );
    const seen = pages.flatMap((page) =>
      page.map((record) => record.evidence_id),
    );
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, 105);
    assert.equal(pages[0][0].memory.historical, true);
    assert.equal(
      pages[0][0].memory.integrityCheck,
      "not-performed-for-summary",
    );
  }
  for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "1"]) {
    assert.throws(() => memory.list({ offset }), { code: "RESOURCE_LIMIT" });
    assert.throws(() => memory.search("fixture", { offset }), {
      code: "RESOURCE_LIMIT",
    });
  }
});

test("refuses path traversal, symlink clobber and files beyond explicit workbench limits", async (t) => {
  const { directory, root, source, connect } = await setup(t);
  assert.throws(() => new InvestigationMemory("relative/path"), {
    code: "UNSAFE_PATH",
  });
  assert.throws(
    () => new InvestigationMemory(`${directory}/../unexpected-memory`),
    { code: "UNSAFE_PATH" },
  );
  const outside = join(directory, "outside");
  await mkdir(outside, { mode: 0o700 });
  const rootLink = join(directory, "memory-link");
  await symlink(outside, rootLink);
  assert.throws(() => new InvestigationMemory(rootLink), {
    code: "UNSAFE_PATH",
  });
  const memory = connect();
  assert.throws(() => memory.bundlePath("../../outside"), {
    code: "INVALID_ID",
  });
  await assert.rejects(memory.get("../../outside"), { code: "INVALID_ID" });
  assert.throws(() => memory.note(`ev_${"c".repeat(64)}`, "Unlinked note"), {
    code: "EVIDENCE_NOT_FOUND",
  });
  assert.throws(() => memory.list({ limit: 0 }), { code: "RESOURCE_LIMIT" });
  assert.throws(() => memory.search(" ", { limit: 1 }), {
    code: "INVALID_TEXT",
  });
  const linkedSource = join(directory, "linked-export.json");
  await symlink(source, linkedSource);
  await assert.rejects(memory.importBundle(linkedSource));
  const sentinel = join(outside, "sentinel");
  await writeFile(sentinel, "preserve me");
  const bytes = await readFile(source);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await symlink(sentinel, join(root, "bundles", `${digest}.json`));
  await assert.rejects(memory.importBundle(source));
  assert.equal(await readFile(sentinel, "utf8"), "preserve me");
  await writeFile(source, "");
  await truncate(source, MEMORY_LIMITS.bundleBytes + 1);
  await assert.rejects(memory.importBundle(source), { code: "RESOURCE_LIMIT" });
  assert.throws(
    () =>
      memory.note(
        `ev_${"d".repeat(64)}`,
        "x".repeat(MEMORY_LIMITS.noteBytes + 1),
      ),
    { code: "RESOURCE_LIMIT" },
  );
});

test("refuses pre-existing SQLite sidecar symlinks and detects a replaced owned directory", async (t) => {
  const { directory, root, connect } = await setup(t);
  const sentinel = join(directory, "sentinel");
  await writeFile(sentinel, "preserved");
  await mkdir(root, { mode: 0o700 });
  await symlink(sentinel, join(root, "memory.sqlite-wal"));
  assert.throws(connect, { code: "UNSAFE_PATH" });
  assert.equal(await readFile(sentinel, "utf8"), "preserved");
  await rm(join(root, "memory.sqlite-wal"));
  const memory = connect();
  await rm(join(root, "bundles"), { recursive: true });
  await symlink(directory, join(root, "bundles"));
  assert.throws(() => memory.list(), { code: "UNSAFE_PATH" });
});

function childImport(moduleURL, root, source, marker) {
  return new Promise((resolve, reject) => {
    const program = `const { InvestigationMemory } = await import(process.argv[1]);
      const memory = new InvestigationMemory(process.argv[2]);
      try {
        const result = await memory.importBundle(process.argv[3]);
        memory.note(result.evidenceIds[0], process.argv[4]);
        console.log(JSON.stringify(result));
      } finally { memory.close(); }`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", program, moduleURL, root, source, marker],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(`Concurrent import exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (cause) {
        reject(
          new Error(
            `Concurrent import returned no valid JSON. Check child-process permissions. ${stderr}`,
            { cause },
          ),
        );
      }
    });
  });
}

test(
  "independent processes atomically deduplicate concurrent imports and retain all analyst notes",
  { timeout: 30000 },
  async (t) => {
    const { root, source, connect } = await setup(t);
    const moduleURL = new URL("../lib/memory.mjs", import.meta.url).href;
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        childImport(moduleURL, root, source, `Concurrent annotation ${index}`),
      ),
    );
    assert.equal(
      results.reduce((sum, result) => sum + result.addedEvidence, 0),
      2,
    );
    assert.equal(new Set(results.map((result) => result.bundleId)).size, 1);
    const memory = connect();
    assert.equal(memory.list().length, 2);
    const saved = await memory.get(results[0].evidenceIds[0]);
    assert.equal(saved.notes.length, 4);
    assert.equal((await memory.verify()).ok, true);
    assert.equal((await readdir(join(root, "bundles"))).length, 1);
  },
);
