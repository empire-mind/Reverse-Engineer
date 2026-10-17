import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvidence } from "rea-agents/dist/domain/evidence.js";
import { createEvidenceBundle } from "rea-agents/dist/domain/evidenceBundle.js";
import { InvestigationMemory } from "../lib/memory.mjs";
import { resultError } from "../lib/presentation.mjs";
import {
  closeResources,
  retainSession,
  saveErrorReceipt,
  viewSourceId,
} from "../lib/retention.mjs";

test("real-shaped text-only failures retain exact partial observations and useful bounded diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rea-error-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "resource_constraint",
            message: "Worker budget exceeded",
            retryable: true,
            remediation: "Select fewer source paths",
            partial_observation: {
              count: 17,
              continuation: "retained evidence",
              large: "x".repeat(12000),
            },
          },
        }),
      },
    ],
    _meta: { source: "rea" },
  };
  const error = Object.assign(new Error("Generic wrapper"), {
    result: raw,
    code: "REA_TOOL_ERROR",
  });
  await saveErrorReceipt({ root }, error);
  const projected = resultError(error);
  assert.equal(projected.code, "resource_constraint");
  assert.equal(projected.retryable, true);
  assert.equal(projected.message, "Worker budget exceeded");
  assert.equal(projected.diagnostic.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 16000);
  assert.deepEqual(
    JSON.parse(await readFile(projected.diagnostic_receipt.path, "utf8")),
    raw,
  );
  const smaller = Object.assign(new Error("wrapper"), {
    result: {
      content: [
        {
          type: "text",
          text: '{"error":{"code":"analysis_failed","remediation":"Use saved parent","partial_observation":{"count":17}}}',
        },
      ],
    },
  });
  assert.equal(resultError(smaller).diagnostic.partial_observation.count, 17);
  assert.equal(resultError(smaller).diagnostic.remediation, "Use saved parent");
});

test("failed live importer validation retains original canonical evidence without elevating provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rea-retention-"));
  const memory = new InvestigationMemory(join(root, "memory"));
  t.after(async () => {
    memory.close();
    await rm(root, { recursive: true, force: true });
  });
  const evidence = createEvidence(
    {
      path: "/fixture.js",
      sha256: "a".repeat(64),
      format: "javascript",
      architecture: null,
    },
    { id: "fixture", name: "Owned fixture", version: "1" },
    {
      operation: "analyze_javascript_application",
      parameters: {},
      result: { value: 1 },
    },
  );
  const bytes = Buffer.from(JSON.stringify(createEvidenceBundle([evidence])));
  const client = {
    exportBundle: async (path) => writeFile(path, bytes, { flag: "wx" }),
    importBundle: async () => {
      throw Object.assign(new Error("Provider-specific import refused"), {
        code: "IMPORT_REFUSED",
      });
    },
  };
  const retained = await retainSession(client, memory, {
    question: "Check hypothesis",
  });
  assert.equal(retained.validation.validatedByRea, false);
  assert.equal(retained.validation_error.code, "IMPORT_REFUSED");
  assert.deepEqual(await readFile(retained.bundlePath), bytes);
  assert.equal((await memory.get(evidence.evidence_id)).notes.length, 1);
  assert.equal((await memory.verify()).ok, true);
});

test("resume follows only an authenticated parent; independent cleanup preserves both failures", async () => {
  const id = `ev_${"a".repeat(64)}`;
  const parent = `ev_${"b".repeat(64)}`;
  const entry = {
    evidence: {
      evidence_id: id,
      operation: "inspect_analysis_view",
      normalized_result: { parent_evidence_id: parent },
    },
    bundleEvidenceIds: [id, parent],
  };
  assert.equal(viewSourceId(entry), parent);
  assert.throws(() => viewSourceId({ ...entry, bundleEvidenceIds: [id] }), {
    code: "RESUME_PARENT_MISSING",
  });
  assert.throws(() => viewSourceId(null), { code: "EVIDENCE_NOT_FOUND" });
  const original = Object.assign(new Error("Analysis failed"), {
    code: "ORIGINAL",
  });
  let clientClosed = false;
  await assert.rejects(
    closeResources(
      {
        close() {
          throw new Error("SQLite close failed");
        },
      },
      {
        async close() {
          clientClosed = true;
        },
      },
      original,
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.equal(resultError(error).code, "ORIGINAL");
      assert.equal(resultError(error).cleanup_errors.length, 1);
      return true;
    },
  );
  assert.equal(clientClosed, true);
});

test("aggregate projection preserves all wrapper recovery pointers as well as the actual primary and cleanup diagnoses", async () => {
  const primary = Object.assign(new Error("Analysis interrupted"), {
    code: "ANALYSIS_INTERRUPTED",
  });
  const cleanup = Object.assign(new Error("Owned SQLite close failed"), {
    code: "SQLITE_IOERR",
  });
  let aggregate;
  try {
    await closeResources(
      {
        close() {
          throw cleanup;
        },
      },
      undefined,
      primary,
    );
  } catch (error) {
    aggregate = error;
  }
  const retained = {
    bundleId: `sha256_${"a".repeat(64)}`,
    bundlePath: "/private/memory/bundle.json",
  };
  Object.assign(aggregate, {
    retained,
    completedWorkflowStatus: "retained",
    cancelled: true,
    analysisReceipt: { path: "/private/memory/analysis-response.json" },
    receipt: { path: "/private/memory/error-response.json" },
    pendingEvidencePath: "/private/memory/pending/bundle.json",
  });
  const diagnostic = resultError(aggregate);
  assert.equal(diagnostic.code, "ANALYSIS_INTERRUPTED");
  assert.equal(diagnostic.cleanup_errors[0].code, "SQLITE_IOERR");
  assert.equal(diagnostic.retained, retained);
  assert.equal(diagnostic.completed_workflow_status, "retained");
  assert.equal(diagnostic.cancelled, true);
  assert.equal(
    diagnostic.completed_analysis_receipt.path,
    "/private/memory/analysis-response.json",
  );
  assert.equal(
    diagnostic.diagnostic_receipt.path,
    "/private/memory/error-response.json",
  );
  assert.equal(
    diagnostic.pending_evidence_path,
    "/private/memory/pending/bundle.json",
  );
});
