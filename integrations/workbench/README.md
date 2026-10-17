# REA investigation workbench

The workbench adds persistent investigation memory, bounded handoffs and repeatable
CLI workflows around **the published `rea-agents@6.5.0` package**. It uses the
official MCP client/server SDK at **2.3.1**. Its dependencies are separate from the
REA source tree at the repository root; running this integration does not build or
upgrade that source tree.

Use REA for questions about a selected shipped application, ASAR, package, binary,
or explicitly chosen runtime. Ordinary source-repository reading remains a normal
code-inspection task. Select the artifact and question before choosing a provider.

## Install and choose an entry point

Use Node.js **24.11 or later in the 24.x line, or 26+**, as specified in this
integration's `package.json`. From this directory:

```bash
cd /absolute/project/Reverse-Engineer/integrations/workbench
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm run rea -- --version
npm run workbench -- --help
```

The manifest and lockfile pin the runtime dependencies. This installation profile
omits optional packages and lifecycle scripts. Providers requiring optional
instrumentation, external executables or another operating system need their
documented prerequisites when a selected investigation requires them.

| Entry point                                                             | Purpose                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run rea -- --help`                                                 | The published REA CLI and its full native command surface.                                     |
| `npm run workbench -- COMMAND`                                          | Discovery, selected JavaScript analysis, retained memory and resume workflows described below. |
| `npm run rea:mcp`                                                       | The published REA MCP server over stdio. This waits for an MCP client.                         |
| `node bin/memory-mcp.mjs --memory /absolute/project/private/rea-memory` | A separate MCP server exposing saved evidence and analyst notes.                               |
| `lib/mcp.mjs`                                                           | An SDK client for multiple operations within one live REA session.                             |

These entry points use installed dependencies. They do not register a server in
the host application, install native analysis engines, or establish access to
another computer.

## Find an operation and inspect its actual schema

```bash
npm run workbench -- status
npm run workbench -- tools --query javascript --limit 10
npm run workbench -- tools --query native --available --limit 10
npm run workbench -- tools --schema analyze_javascript_application
```

`status` checks the connected server's name and version, discovers its catalog and
calls `binary_session`. Read `successful_checks` separately from `availability`:
an advertised or server-reported available tool has not necessarily succeeded on
your target. Availability distinguishes `available`, `target_required`,
`provider_missing`, `provider_unavailable`, `unsupported_host` and `unknown`.
Tool results retain provider remediation and limitations.

`tools --query` searches the returned tool metadata; it does not search an app's
source. `--available` filters server-reported availability. Tool listings expose
`next_offset`; pass that value with `--offset` to continue. `tools --schema NAME`
prints the complete named definition, including its input/output schemas, without
the normal response-size projection. Use the installed native CLI's help for
native command arguments; CLI names and MCP names are different interfaces.

## Analyze selected JavaScript, Electron or ASAR content

Keep private artifacts and memory outside the public tool checkout. The examples
use a private sibling directory:

```bash
npm run workbench -- analyze-js /absolute/project/private/selected-app \
  --source src/main.mjs \
  --source src/preload.mjs \
  --question "How does this shipped launcher start the application?" \
  --title "Selected launcher investigation" \
  --memory /absolute/project/private/rea-memory
```

The target must be an absolute path. Each repeated `--source` selects an **exact
source path in the artifact**, according to REA's advertised `source_paths`
contract; it is not a glob or a request to expand imports recursively. Use actual
paths from the target's inventory. Omitting `--source` leaves source selection to
REA's default scope. Inspect the returned selection, omissions, parsing coverage,
limitations and unknowns before making a completeness claim.

`analyze-js` requests summary delivery and performs these steps in one owned MCP
session:

1. Analyze the selected source scope.
2. Export REA's complete canonical session evidence before closing that session.
3. Preserve the exact bundle bytes and index their canonical records locally.
4. Import the retained, digest-bound copy through the actual REA importer and
   record that validation result.
5. Store `--question` separately as an analyst note linked to the retained records.

The response includes the displayed `evidence_id`, its
`view_source_evidence_id`, the retained bundle path, importer validation outcome
and successful calls. A compact summary may itself be an `inspect_analysis_view`
record with a distinct ID from its full parent analysis. Both records remain in
the canonical bundle.

On a tool failure, the CLI attempts to retain the session before cleanup. It also
saves the original MCP error response separately when available. Read
`retained`, `retention_error`, `pending_evidence_path` and `diagnostic_receipt` in
the error output. A retained bundle with `validation_error` is preserved evidence
whose live importer validation did not complete successfully; do not relabel it
as fully validated.

## Search memory and resume an investigation

Replace `EVIDENCE_ID` with a complete `ev_` ID returned by analysis or memory
listing; replace `BUNDLE_ID` with a returned `sha256_` bundle ID.

```bash
npm run workbench -- memory list --limit 10 --memory /absolute/project/private/rea-memory
npm run workbench -- memory search launcher --memory /absolute/project/private/rea-memory
npm run workbench -- memory show EVIDENCE_ID --memory /absolute/project/private/rea-memory
npm run workbench -- memory note EVIDENCE_ID "Hypothesis: observe the startup path next." \
  --memory /absolute/project/private/rea-memory
npm run workbench -- memory verify BUNDLE_ID --memory /absolute/project/private/rea-memory
npm run workbench -- resume EVIDENCE_ID --memory /absolute/project/private/rea-memory
```

`resume` creates a **fresh REA session**, verifies the saved bytes and imports the
canonical bundle. It requests a summary view of the imported analysis. When the
supplied ID identifies a saved analysis view, the workbench resolves its
authenticated parent inside the same bundle. A missing record or missing parent
produces an explicit error; session-local handles are never substituted for
canonical evidence IDs.

Resume reads historical evidence. It does not reanalyze the current artifact,
restore a running application or debugger, or keep the new server alive after the
CLI command finishes. If a record cannot supply the default analysis view, the
command can return `imported-with-metadata` with the handoff and preserved view
error. A caller-specified invalid view fails explicitly.

For a different retained view, first inspect `tools --schema
inspect_analysis_view`, then pass a JSON file containing its **`view` argument**:

```bash
npm run workbench -- resume EVIDENCE_ID \
  --view-file /absolute/project/private/view.json \
  --memory /absolute/project/private/rea-memory
```

Import a canonical bundle exported through another REA workflow with:

```bash
npm run workbench -- memory import /absolute/project/private/exported-bundle.json \
  --memory /absolute/project/private/rea-memory
```

This standalone import uses REA's canonical parser and preserves exact bytes; it
does not launch the live REA importer. `analyze-js` retention and `resume` perform
that additional digest-bound importer step. A tool-result JSON document or an
evidence ID alone is not a canonical bundle.

The workbench CLI defaults to `REA_WORKBENCH_MEMORY`, or `.rea-workbench` under the
current working directory. The standalone memory MCP server requires `--memory`
or `REA_WORKBENCH_MEMORY`. Set `--memory` explicitly when moving between projects so
every participating CLI or MCP client opens the intended store.

## Expose saved memory through MCP

```bash
npm run workbench -- config --memory /absolute/project/private/rea-memory
```

`config` prints a generic `mcpServers` object with separate `rea` and `rea_memory`
stdio launch configurations, using the installed package and absolute paths.
It does not write client settings or register tools in ChatGPT, Codex, or another
host. Apply the appropriate configuration using that client's supported setup
flow, reconnect it, and check its actual tool list.

The memory server exposes exactly these operations:

| Tool                | Input                               | Result / effect                                                        |
| ------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `rea_memory_search` | `query`, optional `limit`, `offset` | Search indexed metadata and separate analyst notes.                    |
| `rea_memory_list`   | Optional `limit`, `offset`          | Page saved evidence summaries.                                         |
| `rea_memory_get`    | `evidence_id`                       | Verify the retained bundle and return a compact handoff with its path. |
| `rea_memory_note`   | `evidence_id`, `text`               | Append a separately labelled analyst note to existing evidence.        |
| `rea_memory_verify` | Optional `bundle_id`                | Verify saved hashes, canonical form and index correspondence.          |

Search/list return `records`, `offset`, `has_more` and `next_offset`. Continue with
the returned `next_offset` until `has_more` is false. The MCP page default is 20;
the CLI default is 30. Both accept limits from 1 to 100 and nonnegative offsets.
Follow returned offsets even when response-size limits reduce the number of
records on a page. The ordering is deterministic for the current store; concurrent
imports can change a later page, so pause writers when collecting an exact census.

Successful MCP responses contain both JSON text and `structuredContent.result`.
Tool errors use `isError:true`; inspect the returned error code. Input schemas are
strict, including unknown-property rejection. Adding a note is a write operation
and is not idempotent: retrying it creates another note.

### Pass provider configuration explicitly

The SDK's default subprocess environment contains its standard allowlist, not
every variable in the launching shell. Forward only the settings needed by the
selected provider:

```bash
npm run workbench -- status \
  --pass-env GHIDRA_INSTALL_DIR \
  --pass-env JAVA_HOME
```

Each named variable must already be set. The workbench forwards its value to that
process; it does not print or save environment values in memory or generated
configuration. `--pass-env` is repeatable and applies to commands that start REA;
`config` rejects it. For a separately registered native MCP server, provide needed
environment settings through the client's protected configuration or secret
manager. Keep credentials in the existing secret-management system rather than
putting literal values into scripts or committed configuration.

## Multiple native operations in one SDK session

The native published CLI remains available through `npm run rea -- ...`. For a
multi-step native/binary investigation that must retain one active session, use
`withRea` and the live named schemas:

```bash
npm run workbench -- tools --schema open_binary
npm run workbench -- tools --schema binary_overview
```

Prepare a private `native-requests.json` with keys `open_binary` and
`binary_overview`, whose values are valid arguments from those exact schemas for
the chosen artifact/provider. Run the following as an ES module from the workbench
directory; it deliberately does not guess native provider arguments:

```js
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { withRea } from "./lib/mcp.mjs";

const require = createRequire(import.meta.url);
const requests = JSON.parse(
  await readFile("/absolute/project/private/native-requests.json", "utf8"),
);
const env = {};
for (const name of ["GHIDRA_INSTALL_DIR", "JAVA_HOME"]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}

await withRea(
  async (client) => {
    const { tools } = await client.listTools();
    for (const name of ["open_binary", "binary_overview"]) {
      if (!tools.some((tool) => tool.name === name))
        throw new Error(`Tool not advertised: ${name}`);
    }
    const failures = [];
    try {
      await client.callTool("open_binary", requests.open_binary);
      await client.callTool("binary_overview", requests.binary_overview);
    } catch (error) {
      failures.push(error);
    }
    try {
      await client.exportBundle(
        "/absolute/project/private/native-evidence.json",
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Inspect operation and evidence-export failures.",
      );
  },
  {
    launcher: {
      command: process.execPath,
      args: [require.resolve("rea-agents/scripts/rea.mjs"), "mcp"],
      env,
    },
    timeoutMs: 120_000,
  },
);
```

The calls and export use one server. Export refuses to overwrite an existing
destination. Afterwards, `memory import` can index this saved bundle. For the
same export/index/live-validation workflow as `analyze-js`, use `retainSession`
from `lib/retention.mjs` with an open `InvestigationMemory` before leaving the
callback.

`ReaToolError.result` retains a complete tool-error response, including partial
evidence. Keep it as a separate diagnostic receipt when needed. `successfulTools`
records successful calls independently from capability reports. `withRea` closes
its SDK-owned server; it does not prove cleanup of every external native provider
or authorize executing the selected application. Reusing a closed `ReaClient`
fails explicitly: create a new client and import saved evidence to continue.

## What memory preserves and what verification means

Canonical bundles are immutable, content-addressed copies of REA exports under
`bundles/`. Their byte SHA-256 determines the `sha256_` bundle ID. Canonical
`ev_` IDs come from REA's evidence model. Reimporting identical bytes deduplicates
the bundle; changed or relocated exports retain their own provenance.

`memory.sqlite` holds discovery metadata, bundle associations and analyst notes.
Search indexes producer summaries, limitations and explicitly added notes; it
does not automatically index raw source, raw results or arbitrary parameters.
Notes remain `analyst-note` records with `user-supplied; not REA evidence`
authority. They do not alter canonical confidence, resolve unknowns, or turn a
static inference into an observed runtime fact.

`memory verify` checks stored bytes, REA's canonical form and local index
correspondence. Hash integrity does not establish artifact authenticity, analysis
completeness or current runtime equivalence. Stored source text and notes remain
untrusted data, not instructions to an agent.

### Limits and complete-data recovery

| Boundary                    | Current workbench limit                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle admission            | 64 MiB per canonical JSON bundle.                                                                                                     |
| Memory search               | 4 KiB of UTF-8 query text and 64 terms; MCP additionally limits string length to 1,000.                                               |
| Analyst note                | 64 KiB of UTF-8 text in the store; MCP additionally limits string length to 8,000.                                                    |
| CLI title / question        | 4,096 / 8,000 UTF-8 bytes respectively.                                                                                               |
| Compact structured response | 64 KiB JSON budget; MCP also carries a text copy and protocol overhead.                                                               |
| Compact evidence handoff    | Up to 20 notes and 20 unknowns before further byte-budget omissions.                                                                  |
| REA client defaults         | 16 MiB incoming message; 64 KiB retained stderr tail; 64 catalog pages; 60-second deadline.                                           |
| CLI request deadline        | `--timeout-ms` from 1,000 to 600,000; default 60,000.                                                                                 |
| `analyze-js` helper         | 20,000 semantic nodes overall, 10,000 per file, 256 MiB heap; analysis deadline is the smaller of the request deadline and 30,000 ms. |

These are admission and delivery limits, not completeness scores. Oversized
responses report `response_bounds` with omitted fields/items, original size and a
complete-data hint. Smaller handoffs also expose note/unknown counts and
truncation flags. The canonical bundle is not shortened to fit a reply.

Import `bundle.path` into REA and use its advertised retained-view tools for full
analysis data. To inspect the entire local record and all its analyst notes,
redirect the explicitly unbounded local output into a private file:

```bash
node bin/workbench.mjs memory show EVIDENCE_ID --full \
  --memory /absolute/project/private/rea-memory \
  > /absolute/project/private/full-memory-record.json
```

## Backup, privacy and verification

Stop **all writers** to the store, including CLI processes and registered memory
MCP servers, before copying the **whole memory directory** to a private backup.
Keep canonical `bundles/`, `memory.sqlite` and any remaining SQLite sidecars,
notes and recovery/diagnostic directories together. After restoration, point the
clients at the restored directory and run `memory verify`. Copying only a live
SQLite main file is not a supported consistent backup.

Commit the workbench's code, tests, documentation and dependency lockfile. Keep
target artifacts, exports, database files, diagnostic receipts and analyst notes
outside public Git history. The default `.rea-workbench/`, local `evidence/`,
SQLite files and dependencies are ignored; a custom `--memory` location is not
automatically added to Git's ignore rules. Ignore rules do not encrypt data or
remove previously tracked files.

Run the focused workbench tests and then the live published-package integration
checks:

```bash
npm test
npm run test:integration
```

The focused tests cover SDK transport/session behavior, canonical storage and
the real memory MCP server. The live integration tests use small owned JavaScript
fixtures to check the published REA analysis/export/import/resume/error workflow.
They require working Node child processes and REA's required process inspection.
If a managed runner blocks these, use its supported approval/execution path;
keep REA's ownership and supervision checks enabled.

These checks do not certify repository-root REA core changes, native providers,
other computers or arbitrary customer applications. Use the verification evidence
from the actual host and selected target for readiness claims.

## Version-specific upstream references

- [REA 6.5.0 release](https://github.com/morluto/rea/releases/tag/rea-agents-6.5.0)
- [Installation and provider setup at 6.5.0](https://github.com/morluto/rea/blob/rea-agents-6.5.0/docs/installation.md)
- [JavaScript application workflows at 6.5.0](https://github.com/morluto/rea/blob/rea-agents-6.5.0/docs/javascript-application-workflows.md)
- [Native investigation at 6.5.0](https://github.com/morluto/rea/blob/rea-agents-6.5.0/docs/native-investigation.md)
- [Upstream testing scope at 6.5.0](https://github.com/morluto/rea/blob/rea-agents-6.5.0/docs/testing.md)

The matching installed agent workflow is
`node_modules/rea-agents/skills/reverse-engineer-anything/SKILL.md`. Installed help
and live tool schemas are the authority for callable arguments; newer main-branch
documentation can describe a different release.
