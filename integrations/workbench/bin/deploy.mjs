#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  DeploymentError,
  applyDeployment,
  applyRollback,
  createDeployment,
  planDeployment,
  planRollback,
} from "../lib/deployment.mjs";

const HELP = `REA deployment adapters

node bin/deploy.mjs generate --client CLIENT --memory ABSOLUTE_DIRECTORY
node bin/deploy.mjs plan --client CLIENT --config ABSOLUTE_FILE --memory ABSOLUTE_DIRECTORY
node bin/deploy.mjs plan --client CLIENT --config ABSOLUTE_FILE --memory ABSOLUTE_DIRECTORY --apply
node bin/deploy.mjs rollback --config ABSOLUTE_FILE --receipt ABSOLUTE_FILE [--apply]

Clients: generic, claude-code, cursor, gemini, codex, hermes, openclaw.
Profiles: --profile workflow (default), native, memory, all (workflow + native).
Runtime: --runtime node (default) or container.
Node: --workbench-root ABSOLUTE_DIRECTORY, --node ABSOLUTE_EXECUTABLE.
Container: --target-root ABSOLUTE_DIRECTORY, --image REFERENCE,
           either --memory ABSOLUTE_DIRECTORY or --evidence-volume NAME,
           optional --docker EXECUTABLE.
Common: --pass-env NAME (repeat; names only), --state ABSOLUTE_DIRECTORY.

generate prints only proposed REA settings. plan is read-only by default.
--apply is explicit authorization for the displayed additive local configuration
operation; it does not install software, weaken permissions, restart a client,
or claim the host loaded the tools. Existing conflicting entries are preserved.
Rollback requires the exact post-install file and restores original bytes.
Backups store only inserted text and hashes, never unrelated config values.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      client: { type: "string", default: "generic" },
      config: { type: "string" },
      memory: { type: "string" },
      profile: { type: "string", default: "workflow" },
      runtime: { type: "string", default: "node" },
      "workbench-root": { type: "string" },
      node: { type: "string" },
      docker: { type: "string" },
      image: { type: "string" },
      "target-root": { type: "string" },
      "evidence-volume": { type: "string" },
      "pass-env": { type: "string", multiple: true },
      state: { type: "string" },
      receipt: { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0] ?? "plan";
  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (
    positionals.length > 1 ||
    !["generate", "plan", "rollback"].includes(command)
  )
    throw new DeploymentError(
      "INVALID_COMMAND",
      "Choose generate, plan, or rollback; see --help.",
    );
  const options = {
    client: values.client,
    configPath: values.config,
    memoryRoot: values.memory,
    profile: values.profile,
    runtime: values.runtime,
    workbenchRoot: values["workbench-root"],
    nodeCommand: values.node,
    dockerCommand: values.docker,
    image: values.image,
    targetRoot: values["target-root"],
    evidenceVolume: values["evidence-volume"],
    passEnv: values["pass-env"],
  };
  let result;
  if (command === "generate") {
    if (values.apply)
      throw new DeploymentError(
        "INVALID_OPTION",
        "generate never writes; use plan with --config and --apply.",
      );
    result = createDeployment(options);
  } else if (command === "rollback") {
    const plan = await planRollback({
      configPath: values.config,
      receiptPath: values.receipt,
    });
    result = values.apply ? await applyRollback(plan) : plan;
  } else {
    const plan = await planDeployment(options);
    result = values.apply
      ? await applyDeployment(plan, { stateDirectory: values.state })
      : plan;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  // Parser exceptions can contain excerpts of unrelated config. Only our typed
  // diagnostics are safe to emit; system/argument errors use a bounded label.
  const known = error.name === "DeploymentError";
  process.stderr.write(
    `${JSON.stringify({ error: { code: error.code ?? "DEPLOYMENT_FAILED", message: known ? error.message : "Deployment failed before completion; check paths, permissions and --help.", ...(known ? { details: error.details } : {}) } }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
