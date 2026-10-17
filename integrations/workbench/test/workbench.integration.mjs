import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = join(
  dirname(fileURLToPath(import.meta.url)),
  "../bin/workbench.mjs",
);
async function run(args, { expectFailure = false } = {}) {
  try {
    const result = await execute(process.execPath, [cli, ...args], {
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(expectFailure, false, "CLI unexpectedly succeeded");
    return JSON.parse(result.stdout);
  } catch (error) {
    if (!expectFailure) throw error;
    assert.equal(error.code, 1);
    return JSON.parse(error.stdout);
  }
}

test(
  "published REA: selected-source analysis, exact export, notes, fresh-session resume using the displayed summary ID",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-workbench-live-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const app = join(directory, "selected-app");
    const memory = join(directory, "memory");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        name: "owned-workbench-fixture",
        version: "0.0.0",
        type: "module",
        main: "src/main.mjs",
      }),
    );
    await writeFile(
      join(app, "src/main.mjs"),
      'import { label } from "./helper.mjs";\nexport function welcome(name) { return label + name; }\n',
    );
    await writeFile(
      join(app, "src/helper.mjs"),
      'export const label = "Hello ";\n',
    );
    const analyzed = await run([
      "analyze-js",
      app,
      "--source",
      "src/main.mjs",
      "--question",
      "Find the selected launcher imports",
      "--memory",
      memory,
    ]);
    assert.equal(analyzed.status, "retained");
    assert.match(analyzed.evidence_id, /^ev_[a-f0-9]{64}$/);
    assert.notEqual(analyzed.evidence_id, analyzed.view_source_evidence_id);
    assert.equal(analyzed.memory.validation.validatedByRea, true);
    assert.deepEqual(
      analyzed.analysis.normalized_result.summary.source_selection
        .requested_paths,
      ["src/main.mjs"],
    );
    assert.equal(
      analyzed.analysis.normalized_result.summary.statistics
        .parsed_javascript_files,
      1,
    );
    assert.ok(
      analyzed.analysis.normalized_result.summary.source_selection
        .unselected_files > 0,
    );
    const bytes = await readFile(analyzed.memory.bundlePath);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      analyzed.memory.bundleId.slice(7),
    );
    const canonical = JSON.parse(bytes);
    assert.ok(
      canonical.records.some(
        (record) => record.evidence_id === analyzed.evidence_id,
      ),
    );
    assert.ok(
      canonical.records.some(
        (record) => record.evidence_id === analyzed.view_source_evidence_id,
      ),
    );
    await run([
      "memory",
      "note",
      analyzed.evidence_id,
      "Second session hypothesis MercuryZebra",
      "--memory",
      memory,
    ]);
    const search = await run([
      "memory",
      "search",
      "MercuryZebra",
      "--limit",
      "1",
      "--memory",
      memory,
    ]);
    assert.equal(search.records[0].evidence_id, analyzed.evidence_id);
    assert.equal(search.has_more, false);
    const shown = await run([
      "memory",
      "show",
      analyzed.evidence_id,
      "--memory",
      memory,
    ]);
    assert.equal(shown.note_count, 2);
    assert.equal(shown.bundle.integrity.verified, true);
    assert.match(shown.freshness, /Historical/);
    // Remove the selected target from its original path: resume must use saved evidence.
    await rename(app, join(directory, "moved-after-analysis"));
    const resumed = await run([
      "resume",
      analyzed.evidence_id,
      "--memory",
      memory,
    ]);
    assert.equal(resumed.status, "resumed");
    assert.equal(resumed.evidence_id, analyzed.evidence_id);
    assert.equal(
      resumed.view_source_evidence_id,
      analyzed.view_source_evidence_id,
    );
    assert.ok(resumed.successful_checks.includes("import_evidence_bundle"));
    assert.ok(resumed.successful_checks.includes("inspect_analysis_view"));
    assert.ok(
      !resumed.successful_checks.includes("analyze_javascript_application"),
    );
    assert.match(resumed.freshness, /no target was reanalyzed/);
    assert.deepEqual(await readFile(analyzed.memory.bundlePath), bytes);
    assert.equal(
      (await run(["memory", "verify", "--memory", memory])).ok,
      true,
    );
  },
);

test(
  "published REA failure keeps the real diagnostic and exact response receipt after CLI exit",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-workbench-failure-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const failed = await run(
      [
        "analyze-js",
        join(directory, "does-not-exist"),
        "--memory",
        join(directory, "memory"),
      ],
      { expectFailure: true },
    );
    assert.notEqual(failed.code, "REA_TOOL_ERROR");
    assert.ok(failed.diagnostic_receipt);
    const receipt = JSON.parse(
      await readFile(failed.diagnostic_receipt.path, "utf8"),
    );
    assert.equal(receipt.isError, true);
    const original = JSON.parse(
      receipt.content.find((part) => part.type === "text").text,
    ).error;
    assert.equal(failed.code, original.code);
    assert.equal(failed.message, original.message);
    const badOption = await run(["--typo-option"], { expectFailure: true });
    assert.match(badOption.message, /Unknown option/);
  },
);
