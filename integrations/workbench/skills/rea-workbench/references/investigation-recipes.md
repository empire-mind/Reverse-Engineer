# Investigation recipes

Run these commands from the verified workbench root. Replace example paths and
IDs with the actual task inputs. Use the same private memory directory throughout.

## Selected JavaScript or ASAR

```bash
npm run workbench -- tools --query javascript --available --limit 10
npm run workbench -- tools --schema analyze_javascript_application
npm run workbench -- analyze-js /absolute/path/to/application \
  --source src/main.js --source src/feature.js \
  --question "How does the selected feature transform its input?" \
  --memory /absolute/private/project-rea-memory
```

The CLI accepts repeated `--source` values. The workflow MCP requires nonempty
`source_paths`; discover its exact schema before calling. Do not conflate a
source path with a graph node identity: use returned node IDs for graph views.

When paths are unknown, use the installed native REA inventory commands and
schemas to obtain candidate paths before selecting them. Preserve excluded-file
counts and parser failures. Static relationships alone do not establish runtime
control flow, user-visible behavior, or coverage of an entire application.

## Memory and resume

```bash
npm run workbench -- memory search "selected feature" \
  --memory /absolute/private/project-rea-memory
npm run workbench -- memory show ev_SAVED_ID \
  --memory /absolute/private/project-rea-memory
npm run workbench -- memory verify \
  --memory /absolute/private/project-rea-memory
npm run workbench -- resume ev_SAVED_ID \
  --memory /absolute/private/project-rea-memory
```

`resume` creates a fresh REA session and imports the saved canonical bundle. It
does not reacquire the target. If the supplied record is a saved summary view,
the workbench resolves its parent in the same verified bundle. A record that
cannot produce an analysis view returns an explicit historical metadata fallback.

Add a note only after observing the relevant evidence:

```bash
npm run workbench -- memory note ev_SAVED_ID \
  "Hypothesis: this relation may explain the selected feature; runtime confirmation remains open." \
  --memory /absolute/private/project-rea-memory
```

## Native REA and advanced functions

The workbench does not proxy arbitrary native tool execution. Use the direct
published server or CLI when the selected task needs it:

```bash
npm run rea -- --help
npm run rea:mcp
npm run workbench -- config --profile native
```

The `rea:mcp` command waits for an MCP client; it is not an interactive shell.
Find the installed upstream skill with:

```bash
node -p "require.resolve('rea-agents/package.json')"
```

Read `skills/reverse-engineer-anything/SKILL.md` under that package directory and
only its task-relevant references. Use its named tool contracts, target routing,
provider limits, and process ownership rules. Native engines, instrumentation,
and explicit runtime observations have distinct prerequisites and side effects.

For a multi-step direct MCP investigation, keep the same `ReaClient` alive through
analysis and export. Use `lib/retention.mjs` and the documented shared workflows
instead of reimplementing canonical evidence handling. Retain original tool
responses when an operation reports partial results or fails. Close the selected
native target and owned session after exporting; do not kill an arbitrary PID.

## Schema paging

`rea_workbench_tool_schema` provides bounded UTF-8 pages for exact advertised
tool or schema JSON. Follow `next_offset` until complete; check the stable hash
and total size when assembling pages. Never dispatch a native call using only a
truncated schema. The CLI `tools --schema NAME` prints the full selected schema.
