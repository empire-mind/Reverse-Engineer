# Run the REA workbench in a container

Use the same local image for command-line investigations and stdio MCP clients.
Give each project an explicit evidence volume, and mount only the selected target
read-only when an investigation needs it. Clients on one Docker host can use that
same volume; historical evidence can then be searched or resumed from a new
container. The container is an execution option for the workbench, and the skill
provides the investigation method.

This image supports Linux execution with the pinned REA package. An Apple Silicon
Mac can run the image through its Linux container runtime, but that does not give
it macOS process or desktop access. A Windows Docker host must use Linux
containers. External Ghidra, IDA, Hopper and Frida providers are not installed or
qualified by this profile. Choose an appropriate native host when the selected
provider or runtime requires one.

## Build the runtime

From `integrations/workbench`:

```bash
docker compose build --pull rea
docker compose run --rm -T rea status
```

The image name is `rea-workbench:local`. The Dockerfile's build context is only
this integration, and `.dockerignore` allows only the dependency manifests,
runtime source, entrypoint, README and license. It excludes local dependencies, tests,
targets, evidence, databases and other repository content. Installation uses the
lockfile, omits optional and development packages, and does not run npm lifecycle
scripts. The runtime contains the published `rea-agents@6.5.0` package rather
than a repository-root source build.

Build-time access to Docker Hub, npm and Debian package repositories is required.
The runtime defaults below have no network access. The image itself does not
register an MCP server, start an HTTP endpoint or install anything on another
machine.

### Pinned base and process inspection

The Dockerfile pins the official
`node:24.22.0-bookworm-slim` multi-platform index:

```text
sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
```

The [official Docker Hub metadata](https://hub.docker.com/v2/repositories/library/node/tags/24.22.0-bookworm-slim)
was checked on 17 October 2026. Its tag update was 14 October 2026 and its index
includes Linux amd64 and arm64 images. The verified platform digests are recorded
in [container-base.json](container-base.json). A platform being listed by the base
image does not establish that our complete image has passed on that platform;
use the CI receipts for actual executed coverage.

REA's installed `ProcessOwnershipObservation` implementation requires a
procps-compatible `ps` before launching supervised children on Linux. The slim
base does not provide that prerequisite. The Dockerfile therefore installs
[`procps` and `libproc2-0` at `2:4.0.2-3`](https://packages.debian.org/bookworm/procps)
and keeps REA's process ownership checks enabled.

The base image, application dependencies and those two explicit Debian package
versions are pinned. Other required Debian dependencies resolve from signed
bookworm repositories during the build, so separately rebuilt final image digests
are not promised to be bit-for-bit identical. For fleet rollout, build and verify
once, then distribute that verified final image by its immutable registry digest
or as an image archive. This project does not publish an image automatically.

Docker recommends [pinning base image digests and testing builds in CI](https://docs.docker.com/build/building/best-practices/).
Pinning also makes updates explicit: refresh the base and dependency evidence,
rebuild, and repeat the actual smoke checks before changing deployed images.

## The default runtime profile

The supplied [Compose file](../compose.yaml) applies these settings:

| Setting                                     | Effect                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| User `1000:1000`                            | Node runs as the image's unprivileged user.                                              |
| Read-only root                              | Runtime code and the image filesystem cannot be changed.                                 |
| Named `/evidence` volume                    | Canonical bundles, notes, SQLite data and diagnostic receipts persist across containers. |
| `/tmp` tmpfs                                | Up to 1 GiB of temporary working space, with `noexec`, `nosuid` and `nodev`.             |
| No network                                  | The runtime has no external container network.                                           |
| All capabilities dropped; no new privileges | The process cannot gain capabilities through a setuid executable.                        |
| PID limit 256; memory 2 GiB; CPU limit 2    | Work is bounded per container.                                                           |
| Init and stdin open; no TTY                 | Signals and child cleanup work while MCP keeps clean stdio framing.                      |
| No target mounted by default                | Status and historical-memory access do not expose an application.                        |

These are execution constraints, not an assurance that every possible hostile
artifact is safe to process. They also define the supported scope: providers
needing executable temporary files, more resources, network access or an attached
desktop require a separately reviewed host/profile. Do not remove REA's ownership
checks to make a provider appear available.

Compose follows Docker's [service settings](https://docs.docker.com/reference/compose-file/services/).
Running the bare image directly requires supplying the same runtime flags; a
Dockerfile cannot enforce host network, mounts or container resource limits.

## Choose one evidence store for the project

The default Docker volume is `rea-workbench-evidence`. To select a project-specific
volume consistently for every Compose invocation, set a task-specific variable:

```bash
export REA_MEMORY_VOLUME=rea-woop-evidence
docker compose run --rm -T rea memory list
docker compose run --rm -T rea memory search launcher
docker compose run --rm -T rea memory verify
```

Docker initializes a fresh named volume from `/evidence`, which the image creates
owned by UID/GID 1000 with mode 0700. The container smoke test verifies actual
write access on a fresh volume. Existing volumes must already be writable by that
user. The image never recursively changes ownership of an existing volume or
bind-mounted memory directory.

Named volumes are local to their Docker host. Giving a volume the same name on a
second machine does not synchronize it. Stop every writer before backing up the
whole store; restore and run `memory verify` before reusing it. The standard
[memory backup instructions](../README.md#backup-privacy-and-verification) apply.
Do not point several machines at a live SQLite database over a network filesystem.

Host bind-mounted memory is also possible, but its filesystem permissions must
allow UID 1000 to create and update files. A bind mount over `/evidence` replaces
the image directory's ownership. A permissions failure is a configuration issue;
switching the application to root is not required. Preserve existing evidence
and choose a compatible owned directory or named volume.

## Mount and analyze the selected artifact

The optional Compose override requires an explicit existing target. It uses a
read-only bind mount and refuses to create a missing host path:

```bash
export REA_TARGET_DIR=/absolute/path/to/selected-application
docker compose -f compose.yaml -f compose.target.yaml run --rm -T rea \
  analyze-js /targets \
  --source src/main.mjs \
  --question "How does this selected launcher start the application?"
```

`/targets` is the artifact path **inside** the container. Source selections are
exact paths inside that artifact. Use the target's actual source inventory; the
example `src/main.mjs` is not a default for arbitrary applications.

For later historical work, leave out the target override entirely:

```bash
docker compose run --rm -T rea memory search launcher
docker compose run --rm -T rea resume EVIDENCE_ID
```

The retained target path still describes the original container observation.
Resuming verified historical evidence requires the evidence volume, not a current
mount of the old application. A current-behavior question requires another
explicit observation of the target and appropriate provider.

## Use the same image from an MCP client

The entrypoint preserves stdin/stdout and uses `exec` to launch Node directly.
It never wraps an MCP server in `npm run`, which would add command banners to
stdout. Select the required interface:

| Image arguments                                        | Process                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `status`, `analyze-js ...`, `memory ...`, `resume ...` | Workbench CLI; `cli` can be supplied explicitly.           |
| `mcp --memory /evidence`                               | Unified workbench MCP with investigation and memory tools. |
| `memory-mcp --memory /evidence`                        | Standalone five-tool memory MCP server.                    |
| `rea mcp`                                              | Published REA MCP server and its native catalog.           |
| `rea --help`                                           | Published REA CLI help.                                    |

Prefer the unified workbench MCP for routine retained investigations. Add the
native REA server when a task needs its broader named tool surface. Native MCP
sessions and workbench-owned investigation sessions are separate; a handle from
one server is not a saved canonical evidence ID for the other.

For a stdio client, the following generic configuration exposes historical
memory and workbench discovery using the same named volume. It grants no target
mount. Adjust the image reference and volume name to the verified deployment:

```json
{
  "mcpServers": {
    "rea_workbench": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "--init",
        "--interactive",
        "--read-only",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "256",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=1g,mode=1777",
        "--mount",
        "type=volume,source=rea-woop-evidence,target=/evidence",
        "rea-workbench:local",
        "mcp",
        "--memory",
        "/evidence"
      ]
    }
  }
}
```

To analyze a selected artifact, add the following two arguments **before the image
argument**, then refer to `/targets` in the MCP tool input:

```json
[
  "--mount",
  "type=bind,source=/absolute/path/to/selected-application,target=/targets,readonly"
]
```

Docker `--mount` rejects missing bind sources. Do not substitute a home directory,
organization checkout, Docker socket, secret store or filesystem root for the
selected artifact. Named memory and explicitly selected target mounts are enough
for this profile. No API keys or authentication environment variables are needed
for the tested local JavaScript workflow.

Use `--interactive`/`-i`, and never `--tty`/`-t`, for MCP. The host must be able to
launch Docker and connect to its local engine. Applying JSON to a client and
reconnecting it are separate deployment steps; generated configuration alone is
not evidence that its tools registered. Likewise, `workbench config` run inside a
container reports container-internal paths; those paths are not native host
launch commands.

## Verify the actual container

Build the image, then use a Node environment with this integration's locked
dependencies to run the real Docker smoke suite:

```bash
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
docker compose config --quiet
docker build --pull -t rea-workbench:test .
node scripts/container-smoke.mjs --image rea-workbench:test
```

The smoke suite fails when Docker is unavailable; it does not skip container
verification and report success. It creates a small owned JavaScript application,
a unique labelled volume and short-lived containers, then checks:

1. The actual non-root identity, read-only mounts, writable fresh evidence volume,
   temporary space, absent external network, dropped capabilities and working
   procps-compatible process inspection.
2. The installed REA version through the CLI, and the native MCP catalog through
   a real SDK stdio connection.
3. Unified workbench MCP discovery and actual selected-source analysis, canonical
   export and REA importer validation.
4. All five standalone memory tools from another container using the retained
   evidence volume.
5. Fresh workflow-MCP resume with no target mounted, no new analysis, unchanged
   canonical bundle bytes, and a final integrity check.

Cleanup uses Docker-returned container IDs and matching ownership labels. The
script only removes its own test resources. A cleanup failure is reported and
preserves the diagnostic directory instead of claiming a clean finish.

Keep the resulting JSON receipt with the tested commit and final image ID. This
proves the actual tested platform and selected fixture. Run the same checks on an
arm64 runner or the intended desktop host before claiming equivalent execution
there. The smoke script does not qualify external decompilers, other hosts,
customer targets or native client registration.
