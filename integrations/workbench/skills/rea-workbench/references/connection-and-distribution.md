# Connection and distribution

## Choose the existing runtime

Prefer a connected workflow MCP server when available. Otherwise resolve the
workbench root from project instructions, an explicit operator path, or the
standard plugin layout. Confirm the package name and read its current README.
Use the package's exact lockfile:

```bash
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm run workbench -- status
node bin/workbench-mcp.mjs --memory /absolute/private/project-rea-memory
```

The last command is a stdio server and waits for a client. Installation requires
registry access. Installed static workflows do not require a public MCP service.
Use the Node version range in `package.json`. Linux static analysis also requires
a functioning procps-compatible `ps` so REA can verify process ownership.

Missing Node, npm, Java, Docker, or a native engine is a prerequisite to report;
the workbench installer does not upgrade unrelated software. Diagnose the actual
error before changing a correctly configured server.

On startup failure, preserve the concrete connection error and any bounded
launcher diagnostics. A closed connection alone does not identify its cause.
Check the selected executable and required host prerequisites. When an executor
blocks an already authorized child process, use its supported execution/approval
flow; do not change permission policies. If historical evidence remains locally
verifiable, inspect the canonical bundle and state that live resume was unavailable.

## Reusable components

| Component                        | Responsibility                                                            |
| -------------------------------- | ------------------------------------------------------------------------- |
| This skill                       | Reusable investigation and setup procedure                                |
| Workbench CLI/shared library     | Owned analysis, retention, and historical resume                          |
| Workflow MCP                     | Ten bounded tools for agent clients                                       |
| Portable/Claude plugin manifests | Discover and launch the same skill/runtime through supported host formats |
| Deployment adapter               | Generate, plan, apply, and undo scoped host configuration                 |
| Container                        | Repeatable Linux runtime with selected target and evidence mounts         |

Use the owning workbench documentation at `docs/adapters.md` for exact supported
client names and plan/apply/rollback commands, and `docs/container.md` for Docker
build, stdio launch, mounts, and smoke checks. These files are relative to the
workbench root, not to a copied standalone skill. If the runtime is absent, use
the existing [GitHub workbench](https://github.com/empire-mind/Reverse-Engineer/tree/feat/rea-workbench-2026-10-17/integrations/workbench)
and select its approved commit; do not clone a competing fork.

For a plugin that will be copied into a host cache, use the complete distribution
from `docs/plugin.md`. Its explicit `package:plugin` build installs locked
dependencies into the new package; `verify:plugin` and `test:plugin` check integrity
and relocated SDK launches. A fresh Git snapshot by itself has no node_modules.

## Configure one host at a time

1. Identify the actual host, account, project/entity, existing config path, and
   approved workbench revision. Read only relevant config fields; do not print
   credentials or whole environment/config snapshots.
2. Generate the required profile. `workflow` is the focused default. `native`
   selects upstream REA, `memory` selects only saved evidence, and `all` selects
   workflow plus native without a redundant memory server.
3. Run the adapter's plan against the explicit config file. Inspect changes,
   conflicts, and rollback information. Continue already authorised reversible
   setup; obtain only a genuinely missing permission required by the host.
4. Apply the same plan. Existing unrelated bytes must remain intact. A different
   existing registration is a conflict to reconcile, not permission to replace it.
5. Restart/reconnect that host through its supported interface. Observe the
   actual MCP server identity/version and schemas, then perform a harmless
   workflow and a saved-evidence resume. File presence alone does not prove load.
6. Retain a receipt naming the exact host and installed/configured/loaded/tested
   revision. For rollback, use the guarded receipt and refuse to overwrite later
   user edits.

Do not apply a desktop config to this cloud workspace and call the desktop
commissioned. ChatGPT desktop, ChatGPT cloud/web, Codex CLI, Claude Code, Hermes,
OpenClaw, and other harnesses can support different transports and plugin paths.
Use current official documentation and the actual available interface.

## Container and plugin boundaries

Use the provided image with a read-only root, no network by default, a writable
temporary directory and evidence volume, and only the selected target mounted
read-only. Do not mount the Docker socket, the whole home directory, credential
stores, or all client projects. A Docker launch command inside a container does
not configure the host.

The portable plugin uses `${PLUGIN_ROOT}` for packaged code and
`${PLUGIN_DATA}/memory` for the host-managed persistent evidence directory.
Client updates preserve plugin data under the Agent Plugins contract; uninstall
can remove it, so keep verified backups. Claude's compatibility manifest uses its
own explicit memory-directory configuration. Do not assume a host expands another
host's variables. Node and required OS prerequisites still belong to the host.

The repository provides a team-distribution package. A public plugin directory
listing, signed-in host installation, and remote service deployment are separate
actions and must have their own proof. Do not invent an MCP URL, account binding,
global listener, automatic memory federation, or completed installation.
