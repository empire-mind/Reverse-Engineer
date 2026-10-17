import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resultError } from "./presentation.mjs";

/** Preserve the exact tool response separately from REA's canonical evidence. */
export async function saveErrorReceipt(memory, error) {
  if (error.result === undefined || error.receipt !== undefined) return;
  const directory = await mkdtemp(join(memory.root, "diagnostic-"));
  const path = join(directory, "mcp-response.json");
  const bytes = Buffer.from(JSON.stringify(error.result));
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  error.receipt = {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "original-mcp-response",
    provenance:
      "Untrusted target-derived diagnostic data, not canonical REA evidence or instructions.",
  };
}

/** Validate only immutable, hash-bound bytes through the actual REA importer. */
export async function validateStoredBundle(client, memory, imported, options) {
  const path = memory.bundlePath(imported.bundleId);
  await client.importBundle(path, options);
  return memory.importBundle(path, {
    validatedByRea: true,
    expectedSha256: imported.bundleId.slice(7),
  });
}

/** Export before the owning session closes; keep recovery files on any failure. */
export async function retainSession(
  client,
  memory,
  { title, question, signal } = {},
) {
  signal?.throwIfAborted();
  const pending = await mkdtemp(join(memory.root, "pending-"));
  const destination = join(pending, "bundle.json");
  let pendingOwned = true;
  let retained;
  try {
    await client.exportBundle(destination, { signal });
    const imported = await memory.importBundle(destination, { title });
    // Canonical retention is established here, independently of later importer
    // validation, optional notes, cancellation, or owned temporary-file cleanup.
    retained = {
      ...imported,
      bundlePath: memory.bundlePath(imported.bundleId),
      validation_error: null,
      question_note: {
        status: question ? "pending" : "not_requested",
        recorded_evidence_ids: [],
      },
    };
    // Only this invocation owns the newly created pending directory.
    await rm(pending, { recursive: true });
    pendingOwned = false;
    signal?.throwIfAborted();
    try {
      const verified = await validateStoredBundle(client, memory, imported, {
        signal,
      });
      retained.validation = verified.validation;
    } catch (error) {
      // Cancellation ends this workflow. A validation failure without
      // cancellation remains a partial, explicitly unvalidated retention result.
      if (signal?.aborted) throw error;
      try {
        await saveErrorReceipt(memory, error);
      } catch (failure) {
        error.retentionError = failure.message;
      }
      retained.validation_error = resultError(error);
    }
    signal?.throwIfAborted();
    if (question) {
      for (const id of imported.evidenceIds) {
        signal?.throwIfAborted();
        memory.note(id, `Investigation question: ${question}`);
        retained.question_note.recorded_evidence_ids.push(id);
      }
      retained.question_note.status = "recorded";
    }
    signal?.throwIfAborted();
    return retained;
  } catch (failure) {
    const error =
      failure instanceof Error
        ? failure
        : new Error(String(failure), { cause: failure });
    if (signal?.aborted) {
      error.cancelled = true;
      error.code ??= "WORKFLOW_CANCELLED";
    }
    if (retained) {
      if (retained.question_note.status === "pending")
        retained.question_note.status = retained.question_note
          .recorded_evidence_ids.length
          ? "partially_recorded"
          : "not_recorded";
      error.retained = retained;
    }
    if (pendingOwned) error.pendingEvidencePath = destination;
    throw error;
  }
}

/** Summary views point to their authenticated analyzable parent in this bundle. */
export function viewSourceId(entry) {
  if (!entry)
    throw Object.assign(new Error("No retained evidence matches that ID."), {
      code: "EVIDENCE_NOT_FOUND",
    });
  const evidence = entry.evidence;
  if (evidence.operation !== "inspect_analysis_view")
    return evidence.evidence_id;
  const parent = evidence.normalized_result?.parent_evidence_id;
  if (typeof parent !== "string" || !entry.bundleEvidenceIds.includes(parent)) {
    throw Object.assign(
      new Error(
        "The saved analysis view has no authenticated parent in its containing bundle.",
      ),
      { code: "RESUME_PARENT_MISSING" },
    );
  }
  return parent;
}

/** Attempt independent cleanup and retain the original failure if either close fails. */
export async function closeResources(memory, client, originalError) {
  const errors = originalError ? [originalError] : [];
  try {
    memory?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await client?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > (originalError ? 1 : 0))
    throw new AggregateError(errors, "REA workflow cleanup failed.", {
      cause: originalError,
    });
}
