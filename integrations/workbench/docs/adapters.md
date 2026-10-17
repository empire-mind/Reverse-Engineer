# Deploy REA across clients

Use **one workbench workflow MCP server per client and project** as the default.
It provides investigation workflows and the five memory tools from one local
launch. The portable skill supplies the operating procedure. The same pinned
workbench package supplies the CLI, native SDK client, MCP server and container.
This keeps the analysis and evidence contract consistent across models.

Choose native Node execution on a machine that needs its locally installed
analysis providers. Choose the container for an isolated static-analysis worker
with explicit target and evidence mounts. A container cannot establish access to
desktop applications or install the host's Ghidra, IDA or Hopper prerequisites.
See [the container guide](container.md) for its verified scope.

## What each client adapter produces

The following formats were checked against current primary documentation on
17 October 2026. Generated schema compatibility is separate from a live connection
in the user's particular installed host version.

| Client                                     | Generated setting                                                                               | Normal destination                                          | Source                                                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI / compatible Codex configuration | TOML `mcp_servers` entries with `command` and `args`; explicit forwarding uses `env_vars` names | Selected project or user `config.toml`                      | [OpenAI MCP documentation](https://developers.openai.com/codex/mcp/)                                                                     |
| Claude Code                                | JSON `mcpServers`, or the bundled Claude plugin                                                 | Project `.mcp.json`; user-scope entries in `~/.claude.json` | [Claude Code MCP](https://code.claude.com/docs/en/mcp)                                                                                   |
| Cursor                                     | JSON `mcpServers`                                                                               | Project `.cursor/mcp.json` or `~/.cursor/mcp.json`          | [Cursor MCP](https://cursor.com/docs/mcp)                                                                                                |
| Gemini CLI                                 | JSON `mcpServers`                                                                               | Selected `.gemini/settings.json`                            | [Gemini MCP](https://geminicli.com/docs/tools/mcp-server/) and [settings locations](https://geminicli.com/docs/reference/configuration/) |
| Hermes                                     | YAML `mcp_servers`                                                                              | The active profile's `config.yaml`                          | [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)                                                         |
| OpenClaw                                   | JSON `mcp.servers`                                                                              | The selected active OpenClaw configuration                  | [OpenClaw saved MCP registry](https://docs.openclaw.ai/cli/mcp/registry) and [transports](https://docs.openclaw.ai/cli/mcp/transports)   |
| Generic stdio client                       | JSON `mcpServers`                                                                               | An explicit file selected by the operator                   | Adapt to the host's own supported import/setup flow.                                                                                     |

The current OpenAI documentation covers more than one surface, including desktop
MCP settings. This adapter writes a selected Codex configuration file; it does not
register a ChatGPT account connector or silently change application settings.
Use that particular host's supported settings/import flow and verify its live
tool list. A configured entry alone is insufficient evidence of connection.

The registry is deliberately one implementation with client-specific configuration
shapes. It does not install a separate custom runtime into every assistant. A host
that can launch stdio MCP can use the same process; an API-only workflow can call
the CLI or SDK in its authorized executor. This package does not add an HTTP
listener or new authentication service.

## Bootstrap the pinned package

Use a reviewed checkout or extracted workbench distribution on each authorized
machine. From the workbench directory, with the supported Node version:

```bash
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm run workbench -- status
npm run deploy -- --help
```

The installer never installs or upgrades Node, npm, a container engine, a model,
or a native decompiler. Its parser dependencies are pinned in the lockfile:
`jsonc-parser@3.3.1`, `smol-toml@1.9.1`, and `yaml@2.9.1`. Configuration parsing uses
the libraries' actual JSONC tree, TOML document and YAML source-token interfaces;
original files are not reformatted. See the primary [JSONC parser](https://github.com/microsoft/node-jsonc-parser),
[TOML parser](https://github.com/squirrelchat/smol-toml), and
[YAML document](https://eemeli.org/yaml/) documentation.

Set a private memory directory outside the distribution and its enclosing Git
checkout. Reuse that exact directory across clients on the same machine for the
same project. The adapters require an explicit absolute path; they never select
a plugin cache or client working directory as the evidence store. The path is a
local filesystem dependency, so another machine must choose its own usable path.

## Generate, review, apply and reverse

`generate` prints a proposed configuration and launch facts without reading client
settings. The `snippet` field is ready for the chosen format. It contains only
REA settings and explicitly named environment references.

```bash
npm run deploy -- generate \
  --client codex \
  --memory /absolute/private/woop-rea-memory
```

`plan` reads only the explicitly selected settings file and shows the intended
REA entries, before/after digests, additions, unchanged entries and launcher-file
prerequisites. It writes nothing unless `--apply` is supplied.

```bash
npm run deploy -- plan \
  --client codex \
  --config /absolute/user/.codex/config.toml \
  --memory /absolute/private/woop-rea-memory

npm run deploy -- plan \
  --client codex \
  --config /absolute/user/.codex/config.toml \
  --memory /absolute/private/woop-rea-memory \
  --apply
```

`--apply` authorizes this additive local write. It leaves permission policies,
approval settings and other registrations intact. The explicit path is the
authority boundary: neither a home directory nor a running client is probed to
find somewhere else to write. A project-scoped path must be appropriate for that
client and project. Use the client-specific normal destination in the table; the
installer does not reinterpret an arbitrary file as a supported host location.

The result distinguishes these states:

| Field/result                  | Meaning                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `intended: true`              | A concrete REA launch configuration was generated.                                         |
| `action: unchanged`           | The selected file already contains exactly those entries; no new backup or write occurred. |
| `configuration_applied: true` | This operation wrote and hash-verified the selected file.                                  |
| `configuration_matches: true` | The selected file matches the intended entries at the last check.                          |
| `host_loaded: unverified`     | No application connection has been inferred from writing a file.                           |

By default, the inverse backup is written beneath the selected private memory
directory in `deployment-backups/`. Use `--state /absolute/private/deployment-state`
to choose a separate location. Container named-volume deployments require this
explicit host-side state path when applying because they have no host memory
directory. The backup has mode `0600` and contains only the inserted fragments,
the selected path, file mode and SHA-256 digests. Existing settings and credentials
are never copied into a full configuration backup or printed in the plan.

The receipt is prepared before the write. Its `status: prepared` describes that
recovery record, not proof that an application loaded the result. Compare its
hashes with the actual file; the apply result separately reports successful write
verification. A failed apply retains the prepared receipt when one was created.

```bash
npm run deploy -- rollback \
  --config /absolute/user/.codex/config.toml \
  --receipt /absolute/private/woop-rea-memory/deployment-backups/RECEIPT.json

npm run deploy -- rollback \
  --config /absolute/user/.codex/config.toml \
  --receipt /absolute/private/woop-rea-memory/deployment-backups/RECEIPT.json \
  --apply
```

Rollback requires the exact post-install file digest and independently proves
that the inverse describes only REA insertions. It restores the original bytes
or removes a settings file this operation created. It refuses to overwrite
subsequent user edits. Repeating rollback after restoration reports
`already-restored`. Backup receipts remain for audit and are not uploaded.

### Conflict and format behavior

An identical same-name entry is unchanged. A different same-name entry is a
conflict; there is no overwrite flag. An identical command and argument list
under another name is also a conflict, so repeated installs do not create aliases.
Plugin registrations and other configuration scopes may not be visible in the
selected file. Check the host's live catalog before choosing a second route.

JSON/JSONC and YAML changes insert source fragments while preserving every
pre-existing byte. TOML adds a table after validating the complete document; an
inline `mcp_servers` table that cannot be extended is refused. Duplicate keys,
malformed documents, invalid UTF-8, BOM encoding, oversized files, symlink paths
and multiple hard links are refused. YAML aliases are preserved when the edit
can use an ordinary concrete mapping. Unsupported YAML tags and ambiguous
documents fail without printing their contents. Configurations are bounded to
4 MiB and inverse receipts to 1 MiB.

OpenClaw's full configuration language includes syntax beyond JSONC. Files using
unquoted keys or single-quoted JSON5 strings are refused by this adapter. Use the
documented native `openclaw mcp add` / `set` commands or explicitly normalize that
file; a failed parser is not permission to rewrite unrelated settings.

Apply uses an exclusive REA lock, rechecks content/inode/mode, writes a temporary
file and atomically replaces the result. Creating a new settings file uses a
no-replace claim, so another creator's file is preserved. Existing-file updates
are not a transaction with an unrelated editor or host process: avoid concurrent
settings saves during the brief apply step. Lock files are never automatically
declared stale or deleted without establishing their owner.

## Select advanced profiles deliberately

| `--profile` | Registered servers     | Use                                                                        |
| ----------- | ---------------------- | -------------------------------------------------------------------------- |
| `workflow`  | `rea-workbench`        | Default: investigation workflows plus retained memory.                     |
| `native`    | `rea`                  | Direct access to upstream's full named tool catalog and session semantics. |
| `memory`    | `rea-memory`           | Retained evidence access without starting a new REA analysis process.      |
| `all`       | `rea-workbench`, `rea` | An advanced client needing both managed workflows and direct native calls. |

`all` avoids registering the five memory tools twice. A direct native server owns
its own session; evidence is not automatically part of the workflow server's
session. Export before closing it and import the canonical bundle deliberately.

For provider configuration, `--pass-env NAME` takes variable names only. Codex
receives `env_vars`; Claude Code, Cursor, Gemini and Hermes receive their supported
environment-reference syntax. The workflow server forwards the same named values
to its REA child. No environment values are read by the generator or written to
the backup. Other client adapters refuse this option until their protected
environment mechanism is configured through that host's supported flow.

```bash
npm run deploy -- generate --client codex \
  --memory /absolute/private/woop-rea-memory \
  --pass-env GHIDRA_INSTALL_DIR --pass-env JAVA_HOME
```

## Claude Code plugin

The **workbench directory itself is the Claude plugin root**. It contains
`.claude-plugin/plugin.json`, `.mcp.json`, `skills/rea-workbench/`, and the runnable
`bin/` and `lib/` paths. The launch uses `${CLAUDE_PLUGIN_ROOT}` and cannot escape
into a parent checkout. The required `memory_directory` user configuration is
passed as an argument rather than being parsed by a shell. No install hooks,
approval bypasses, permission grants or automatic dependency downloads are
included. These layouts and substitution rules follow the official
[Claude plugin manifest reference](https://code.claude.com/docs/en/plugins-reference).

Prefer the self-contained plugin built by the explicit packaging command. It
copies the allowlisted runtime, skill and manifests, installs the exact locked
dependencies without lifecycle scripts, and records their integrity. See
[plugin packaging and verification](plugin.md) for the shared distribution flow.
Use a new output directory, then validate and load that final directory:

```bash
npm run package:plugin -- --output /absolute/new/rea-workbench-plugin
npm run verify:plugin -- --directory /absolute/new/rea-workbench-plugin
claude plugin validate /absolute/new/rea-workbench-plugin
claude --plugin-dir /absolute/new/rea-workbench-plugin
```

Choose the private memory directory when the client requests it. Use the plugin
route or a manual workflow MCP registration for a given client/project. The
installer does not alter Claude's installed-plugin registry. The built folder
includes its pinned dependency tree and can be relocated as one unit; a fresh Git
source checkout still requires explicit `npm ci`. Dependencies are not committed
into Git. Follow the official [plugin distribution guidance](https://code.claude.com/docs/en/plugin-marketplaces)
for a team marketplace, and preserve the workbench root as the distributable
unit. Marketplace registration, host loading and a live tool call are separate
verification steps.

## Container-backed client configuration

```bash
npm run deploy -- generate --client cursor --runtime container \
  --target-root /absolute/selected-application \
  --evidence-volume rea-woop-evidence \
  --image rea-workbench:local
```

The generated command runs `docker run -i --rm --init`, with no TTY, no network,
a read-only root filesystem and target mount, dropped capabilities, no new
privileges, process/memory/CPU limits, and a bounded `/tmp` tmpfs. The target is
visible as `/targets`; memory is `/evidence`. Tool arguments inside the container
must use those paths. The image default `rea-workbench:local` is a local build
name, not a published image or an immutable digest. Supply an approved image
digest after building and verifying a release if that is your deployment policy.

A named volume avoids host UID mismatches. To use a bind directory, substitute
`--memory /absolute/private/rea-memory`; it must already exist and be writable by
the container's UID 1000. The adapter never changes existing directory ownership.
Target and evidence mounts cannot overlap. Mounts containing commas are refused
instead of being reinterpreted as Docker mount options. Image presence, engine
availability and evidence write access remain unverified until an actual
container launch succeeds. Provider paths must exist inside that container;
forwarding a host path alone does not mount the provider.

## Verify through each actual host

After a supported install/reload, inspect the live tool list and call
`rea_workbench_status`. Then perform a small authorized investigation, retrieve
it through memory, and resume it in a fresh client session. Keep that host's
connection receipt separate from REA's artifact evidence.

Useful supported host checks are Codex `/mcp`, Claude Code `/mcp`, Gemini `/mcp`,
the Cursor MCP settings panel, Hermes MCP connection/tool output, and OpenClaw
`openclaw mcp probe rea-workbench --json`. OpenClaw registry list/status commands
alone do not connect to the target server; a probe supplies connection evidence.
Repeat the connection check on each machine/runtime that will use the tool.

The automated adapter tests verify generation, exact-byte apply/rollback,
idempotence, conflicts, parser boundaries and private inverse receipts. They do
not attest an installed Claude, Cursor, Gemini, Hermes, OpenClaw or desktop
ChatGPT instance. Report the installed host version and successful tool call
before promoting any machine from configured to verified.
