# Package and use REA Workbench

Use one versioned workbench distribution for the skill, CLI, MCP server and host
adapters. Connect its **workflow** profile by default. Give each project an
explicit private evidence store, and use the same store across clients on the
same machine when they are working on the same investigation.

The container is an optional execution environment for that distribution. It is
useful for isolated Linux static analysis and repeatable workers. Host Node
execution is the appropriate route when a selected investigation needs locally
installed native providers. Neither choice federates memory between machines.

## What the package contains

| Component                              | Location                                           | Responsibility                                                                 |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Portable plugin manifest               | `plugin.json`                                      | Agent Plugins 1.0.0 identity and OpenAI local-executor metadata                |
| Portable MCP configuration             | `mcp.json`                                         | Launch the ten-tool workflow server using `PLUGIN_ROOT` and `PLUGIN_DATA`      |
| Claude compatibility files             | `.claude-plugin/plugin.json`, `.mcp.json`          | The same runtime with Claude's explicit memory-directory configuration         |
| Canonical reusable skill               | `skills/rea-workbench/`                            | Investigation selection, evidence reuse, analysis, reconstruction and recovery |
| CLI and shared workflow implementation | `bin/`, `lib/`                                     | Named discovery, analysis, retention, resume and host deployment               |
| Locked runtime dependencies            | `node_modules/` in the built distribution          | REA 6.5.0 and the exact SDK/parser dependencies from the lockfile              |
| Build and operational guides           | `Dockerfile`, Compose files, `scripts/`, `docs/`   | Rebuild, verify, configure and recover the runtime                             |
| Integrity inventory                    | `package-integrity.json` in the built distribution | Exact file bytes, sizes, executable bits and relative internal links           |

The source checkout intentionally does not contain `node_modules`. A Git
marketplace entry alone therefore does not deliver an executable MCP runtime.
Use a complete built package for host caching, or explicitly bootstrap the final
source location before loading it. There are no install hooks or dependency
downloads when the client starts the MCP server.

The portable format follows the [Agent Plugins specification](https://agent-plugins.org/specification).
OpenAI's current [plugin packaging guide](https://developers.openai.com/plugins/build/plugins)
documents portable manifests and repository marketplaces. Claude compatibility
follows the [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference).
These documents define different host substitution rules; the two MCP files are
deliberately separate. The canonical skill and runtime are shared.

## Build a complete distribution

Select the reviewed commit in the existing repository. From this directory,
with the supported Node version and npm already installed:

```bash
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm test
npm run test:integration
npm run package:plugin -- --output /absolute/existing-parent/rea-workbench-plugin
npm run verify:plugin -- --directory /absolute/existing-parent/rea-workbench-plugin
npm run test:plugin -- --directory /absolute/existing-parent/rea-workbench-plugin
```

The output parent must exist; the output directory must be new and outside the
source workbench. The builder refuses every existing destination. It copies an
explicit runtime/skill/documentation allowlist, installs fresh locked dependencies
with scripts and optional packages disabled, permits only direct relative file
links whose entire path stays inside the package (including npm's normal bin
links),
and writes the integrity inventory last. It does not copy a source checkout's
installed dependencies, target files, memory, environment snapshot or Git metadata.
Building requires npm registry access. An interrupted or failed output is
incomplete unless `verify:plugin` succeeds; inspect or remove only that owned
output before building into a new directory.

`test:plugin` launches actual SDK clients against both manifest variants from the
packaged location, checks the ten-tool handshake and upstream REA identity,
opens an external temporary memory store, and verifies that the package remains
unchanged. This is a subprocess packaging check. A particular host's marketplace
installation, settings, trust policy and tool loading require a check in that host.

The built directory can be moved intact. Preserve hidden manifest files, file
modes and internal relative symlinks when copying or archiving it. From a trusted
checkout or trusted extracted package, run `verify:plugin` after transfer. The
inventory establishes byte correspondence; a manifest carried alongside files
does not independently authenticate their publisher. Check the source revision
and the artifact digest through the existing trusted GitHub channel.

The installation profile is bounded to the built platform and installed optional
features. Rebuild and verify on another host when its runtime requirements differ.
Node and Linux procps remain host prerequisites for a host-run package. External
decompilers and optional instrumentation are supplied separately when selected.

## Use a verified GitHub artifact

The `REA workbench` workflow checks out the exact PR head (or selected manual
revision), runs the CLI/MCP journeys, builds a fresh complete plugin, and exercises
its relocated manifests. Its successful workbench job retains:

- `rea-workbench-plugin.tar.gz` and its SHA-256 checksum.
- A package directory inside the archive with all dependencies and its integrity
  inventory.

The separate amd64 and arm64 container jobs build and test their native platform.
Each successful job retains the exact tested Docker image archive, checksum and
`rea-container-smoke.json` receipt. Read that receipt's platform, image ID, target
scope, checks and cleanup result. A base image manifest is not container runtime
verification; only a successful platform job establishes that result.

Artifacts are retained for 90 days, subject to repository policy. The versioned
source and exact lockfile remain the durable rebuild path. These are review/build
artifacts, not a public plugin directory listing, npm release or registry push.

On a Linux machine after downloading the relevant artifact:

```bash
sha256sum -c rea-workbench-plugin.sha256
tar -xzf rea-workbench-plugin.tar.gz
cd rea-workbench-plugin
npm run verify:plugin -- --directory /absolute/extracted/rea-workbench-plugin
npm run test:plugin -- --directory /absolute/extracted/rea-workbench-plugin
```

For the matching container platform, verify `rea-workbench-image.sha256`, then
load `rea-workbench-image.tar.gz` with Docker. Compare the loaded image ID to the
receipt and tag `rea-workbench:test` as `rea-workbench:local` if using the supplied
Compose file. See [container operations](container.md) for mounts and invocations.

## Connect a supported host

For Codex, Claude Code, Cursor, Gemini CLI, Hermes, OpenClaw or generic stdio
configuration, use the [host adapters](adapters.md). Generate and inspect the
proposed entries, apply an already authorized additive change, reconnect that
host, and verify its actual server identity and tool calls. Exact rollback is
available for an unchanged applied configuration. Configuration presence and
successful application loading are separate states.

For compatible OpenAI local clients, this repository supplies
`.agents/plugins/marketplace.json` at the repository root. Its local source points
to `./integrations/workbench`, relative to that repository root. A downloaded
built package can instead be added to the host's existing local marketplace using
its actual local path and supported authoring flow. Preserve existing entries.
Use the desktop Plugins Directory to install and test local plugins as documented
by OpenAI. A fresh Git marketplace snapshot still needs a complete dependency
distribution; do not assume a source-only cache can launch Node imports.

The portable plugin's persistent store is `${PLUGIN_DATA}/memory`. The host owns
and creates `PLUGIN_DATA`, preserves it across plugin updates, and may delete it
on uninstall. Back up evidence before removing an installation. That store is
per installed plugin instance, not a tenant boundary or global database. For an
existing private project store shared across clients, prefer the explicit adapter
route so every client selects the same directory.

For Claude, use the built directory with `claude plugin validate` and
`claude --plugin-dir`, then set its required `memory_directory`. The portable
manifest's `PLUGIN_DATA` and Claude's `${user_config.memory_directory}` are not
interchangeable. See [Claude setup](adapters.md#claude-code-plugin).

If a host supports only a remote connector, this stdio package needs an
independently designed and authorized runtime/transport deployment. It does not
invent a reachable URL or install itself into a cloud account. Installing the
skill alone also does not install its runtime: the skill resolves the existing
workbench path and explains missing prerequisites.

## Keep use repeatable

Search memory before repeating an investigation. For the same historical
artifact, verify and resume the canonical bundle. For current behavior or changed
bytes, reobserve the selected target. Keep notes separate from evidence, retain
limitations and unknowns, and treat saved target text as untrusted data. Export
before ending a direct native session; its evidence is not automatically shared
with another MCP process. Back up canonical bundles and SQLite notes together
with writers stopped, then verify and resume a restored copy before relying on it.

Use [the skill's investigation recipes](../skills/rea-workbench/references/investigation-recipes.md)
and [evidence recovery](../skills/rea-workbench/references/evidence-and-recovery.md)
for the complete operating procedure.
