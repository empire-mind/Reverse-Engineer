import assert from "node:assert/strict";
import test from "node:test";
import { boundResult, RESPONSE_BYTES } from "../lib/presentation.mjs";

test("byte-limited tool pages continue immediately after the last actually delivered tool", () => {
  const tools = Array.from({ length: 100 }, (_, index) => ({
    name: `tool_${index}`,
    description: "x".repeat(10000),
  }));
  const page = {
    total: 100,
    offset: 0,
    shown: 100,
    truncated: false,
    next_offset: null,
    tools,
  };
  const bounded = boundResult(page);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= RESPONSE_BYTES);
  assert.ok(bounded.tools.length < tools.length);
  assert.equal(bounded.shown, bounded.tools.length);
  assert.equal(bounded.next_offset, bounded.tools.length);
  assert.equal(bounded.total, 100);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.response_bounds.omitted_items[0].field, "tools");
  assert.deepEqual(
    bounded.tools.map((tool) => tool.name),
    tools.slice(0, bounded.shown).map((tool) => tool.name),
  );
  assert.equal(page.tools.length, 100);
});
