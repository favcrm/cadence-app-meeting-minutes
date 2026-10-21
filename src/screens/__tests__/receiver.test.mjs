// Run: node --test src/screens/__tests__/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPush } from "../receiver.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const base = {
  v: 2,
  op: "screen",
  install_id: "inst-1",
  digest: DIGEST,
  tag: "minutes",
  installation: { title: "Meeting minutes", name: "meeting-minutes", version: "0.2.4", summary: "" },
  runs: [],
};

test("real context id from today's host is accepted and ignored", () => {
  const out = readPush({ ...base, context_id: "ctx-General_1" });
  assert.equal(out.installId, "inst-1");
  assert.equal("contextId" in out, false);
  assert.equal("contexts" in out, false);
});

test("empty context id with empty contexts renders", () => {
  const out = readPush({ ...base, context_id: "", contexts: [] });
  assert.equal(out.installId, "inst-1");
});

test("absent context fields render", () => {
  const out = readPush({ ...base });
  assert.equal(out.installId, "inst-1");
  assert.equal(out.meetings.length, 0);
});

test("malformed non-empty context id is refused", () => {
  for (const bad of ["has space", "../etc", "x".repeat(129), 42, null, { id: "x" }]) {
    assert.throws(() => readPush({ ...base, context_id: bad }), /malformed context_id/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("runs still project when context is absent", () => {
  const out = readPush({ ...base, runs: [{ id: "run-1", state: "ready", title: "Weekly" }] });
  assert.deepEqual(out.meetings.map((m) => m.id), ["run-1"]);
});
