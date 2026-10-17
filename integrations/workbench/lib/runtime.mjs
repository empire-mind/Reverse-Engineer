import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
export const WORKBENCH_VERSION = require("../package.json").version;
export const REA_LAUNCHER = join(
  dirname(require.resolve("rea-agents/package.json")),
  "scripts/rea.mjs",
);

/** Select only explicitly named provider settings; never persist the environment. */
export function selectedEnvironment(names = [], environment = process.env) {
  const selected = {};
  for (const name of names) {
    if (
      typeof name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      environment[name] === undefined
    )
      throw Object.assign(
        new Error(
          `Requested environment variable is invalid or unset: ${name}`,
        ),
        { code: "REA_INVALID_ENVIRONMENT" },
      );
    selected[name] = environment[name];
  }
  return selected;
}
