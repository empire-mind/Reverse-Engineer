#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { verifyPackage } from "../lib/package-integrity.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--directory" || !isAbsolute(args[1]))
    throw new Error(
      "Usage: npm run verify:plugin -- --directory /absolute/package-directory",
    );
  process.stdout.write(
    `${JSON.stringify(await verifyPackage(args[1]), null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`Plugin verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
