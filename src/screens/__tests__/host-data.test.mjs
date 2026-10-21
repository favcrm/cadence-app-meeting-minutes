// Run: node --test src/screens/__tests__/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostData } from "../host-data.mjs";

test("no push: store reports host-unreachable and stays empty", () => {
  const store = createHostData();
  let calls = 0;
  store.subscribe(() => calls++);
  store.markUnreachable();
  assert.equal(store.isUnreachable(), true);
  assert.equal(store.isEmpty(), true);
  assert.equal(calls, 1);
});

test("a push clears host-unreachable and carries no context fields", () => {
  const store = createHostData();
  store.markUnreachable();
  store.attach({ v: 2, installId: "inst-1", digest: null, tag: "minutes", installation: {}, meetings: [] });
  assert.equal(store.isUnreachable(), false);
  assert.equal(store.isEmpty(), false);
  assert.equal("contextId" in store.read(), false);
  assert.equal("contexts" in store.read(), false);
});

test("markUnreachable is ignored once a projection is attached", () => {
  const store = createHostData();
  store.attach({ v: 2, installId: "inst-1", meetings: [] });
  store.markUnreachable();
  assert.equal(store.isUnreachable(), false);
});
