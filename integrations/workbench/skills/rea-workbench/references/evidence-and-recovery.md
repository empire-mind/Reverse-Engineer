# Evidence, continuity, and recovery

## Authority and storage

REA owns canonical evidence identities, manifests, unknown ledgers, summaries,
and analysis views. The workbench stores exact original bundle bytes separately
from its SQLite search index and analyst notes. Repeated imports deduplicate
without combining independent histories into a new authority claim.

Use a private local filesystem with normal file locking for the SQLite store.
Use a separate directory per project/entity when access boundaries differ. A
shared SQLite directory is not an access-control layer or a distributed memory
service. Do not run a live WAL database from a Drive/Dropbox-style sync folder
or infer cross-device replication from a copied directory.

Search results are discovery aids. Read the canonical record, its source scope,
unknowns, and freshness before drawing a conclusion. Preserve producer-selected
paths and source fields. Never persist ambient credentials or copy the entire
process environment. Explicit provider variables can be forwarded by name with
`--pass-env NAME`; values belong in the approved secret-injection mechanism.

## Transfer or restore

1. Stop all workbench and memory writers for the selected store using their
   owned session/process lifecycle. Do not remove WAL or lock files while live.
2. Verify the store and retain the integrity report.
3. Copy the complete quiescent directory, including the database, canonical
   bundles, and any remaining SQLite sidecars. Keep the original until restore
   verification succeeds. A bundle-only handoff does not include analyst notes.
4. Transfer it through the authorised private artifact route for that entity.
5. Open the restored store with the same compatible package version and run
   `memory verify`. Read a saved note and resume a known evidence ID in a fresh
   process. Confirm identity, scope, unknowns, and historical freshness.
6. Record the package revision, bundle digests, source/destination instance,
   observation time, and verification result. A hash alone is not a restore test.

For a bundle-only import, use `memory import /absolute/bundle.json`. The workbench
uses REA's canonical parser; that validation is distinct from successfully
importing the bundle into a live REA session. Do not upgrade provenance labels.

## Failure handling

- For an integrity or index mismatch, preserve the affected evidence and report
  the named failure. Recover from a verified copy; do not edit bytes to match a
  stored digest or silently regenerate IDs.
- For MCP timeout or cancellation, inspect the returned workflow status and
  retained receipts before retrying. Cancellation is not a rollback of already
  retained evidence. Keep a meaningful partial result and its original error.
- For truncated replies, follow continuation/omission pointers and retained
  bundle locations. Do not assume the preview is canonical JSON.
- For a busy workflow server, finish or cancel its owned request before
  resubmitting. The server bounds expensive workflow concurrency.
- For a missing engine or unsupported host, report that specific provider lane;
  continue supported static or historical work that answers the task.
- For a host approval rejection, preserve the boundary and name the rejected
  action. Use a supported alternative; never rewrite policy or route an indirect
  command around the rejection.

## Handoff record

Include the question, artifact identity/version/digest, selected sources, evidence
IDs, complete-bundle location and hash, separate notes, unknowns, freshness,
completed operations, failures, next unanswered question, and required host or
provider. Exclude raw secrets. Bind the record to the actual executing instance;
another machine must produce its own commissioning evidence.
