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
export async function validateStoredBundle(client, memory, imported) {
  const path = memory.bundlePath(imported.bundleId);
  await client.importBundle(path);
  return memory.importBundle(path, {
    validatedByRea: true,
    expectedSha256: imported.bundleId.slice(7),
  });
}

/** Export before the owning session closes; keep recovery files on any failure. */
export async function retainSession(client, memory, { title, question } = {}) {
  const pending = await mkdtemp(join(memory.root, "pending-"));
  const destination = join(pending, "bundle.json");
  let imported;
  try {
    await client.exportBundle(destination);
    imported = await memory.importBundle(destination, { title });
    // Only this invocation owns the newly created pending directory.
    await rm(pending, { recursive: true });
  } catch (error) {
    error.pendingEvidencePath = destination;
    throw error;
  }
  let validationError = null;
  try {
    const verified = await validateStoredBundle(client, memory, imported);
    imported.validation = verified.validation;
  } catch (error) {
    try {
      await saveErrorReceipt(memory, error);
    } catch (failure) {
      error.retentionError = failure.message;
    }
    validationError = resultError(error);
  }
  if (question)
    for (const id of imported.evidenceIds)
      memory.note(id, `Investigation question: ${question}`);
  return {
    ...imported,
    bundlePath: memory.bundlePath(imported.bundleId),
    validation_error: validationError,
  };
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
