import { describe, expect, test } from "bun:test";
import { admitted, channel, createChannel } from "../../src/bridge/channel.ts";
import { getScope, resetScopeForTests, scopeError } from "../../src/bridge/scope.ts";
import { cleanArgs, SCREEN_SERVICE_ARGS_BYTES } from "../../src/bridge/services.ts";

const NONCE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const INSTALL_ID = "inst-minutes-test";

function makePush(overrides = {}) {
  return {
    v: 2,
    op: "screen",
    tag: "minutes",
    install_id: INSTALL_ID,
    context_id: "org-test",
    digest: DIGEST,
    presentation_locale: "en",
    installation: {
      install_id: INSTALL_ID,
      name: "meeting-minutes",
      title: "Meeting minutes",
      version: "0.6.0",
      digest: DIGEST,
      summary: "Structured meeting minutes",
    },
    actions: ["records.list", "records.show", "records.create", "records.update", "screen.route.patch"],
    route: { section: "all", view: "list", record_id: null, segment_id: null },
    read_observations: [],
    ...overrides,
  };
}

describe("Meeting minutes @cadence/app-kit bridge contract", () => {
  test("refuses a foreign app tag or malformed boot nonce", () => {
    const ch = createChannel();
    expect(() =>
      ch.start({
        boot: {
          tag: "crm",
          bridge_nonce: NONCE,
          generation: 1,
          parent_origin: "http://localhost:3187",
        },
        parent: { postMessage() {} },
      }),
    ).toThrow();

    const ch2 = createChannel();
    expect(() =>
      ch2.start({
        boot: {
          tag: "minutes",
          bridge_nonce: "not-a-valid-hex-nonce",
          generation: 1,
          parent_origin: "http://localhost:3187",
        },
        parent: { postMessage() {} },
      }),
    ).toThrow();
  });

  test("advertises the exact 4 capabilities (including screen-audio.v2, without drawers) on ready and maps refusal codes accurately", async () => {
    resetScopeForTests();
    let hostPort = null;
    let initPayload = null;

    const ch = createChannel();
    ch.start({
      boot: {
        tag: "minutes",
        bridge_nonce: NONCE,
        generation: 3,
        parent_origin: "http://localhost:3187",
      },
      parent: {
        postMessage(msg, _origin, transfer) {
          initPayload = msg;
          hostPort = transfer[0];
        },
      },
    });

    expect(initPayload).toEqual({
      v: 1,
      op: "init",
      tag: "minutes",
      bridge_nonce: NONCE,
      generation: 3,
    });
    expect(hostPort).toBeTruthy();

    let resolveReady;
    const readyPromise = new Promise((resolve) => {
      resolveReady = resolve;
    });
    hostPort.onmessage = (event) => {
      const msg = event.data;
      if (msg?.op === "ready") {
        resolveReady(msg);
        return;
      }
      if (msg?.op === "audio-session") {
        const state = {
          session_id: "sess-01",
          mode: "record",
          phase: "recording",
          held_at: "2026-11-13T04:00:00Z",
          elapsed_seconds: 3,
          level: 64,
          peak: 82,
          segments_total: 1,
          segments_done: 1,
          segments_in_flight: 0,
          segments_failed: 0,
          no_speech_segments: 0,
          transcript: "[00:03] Carmen: Kickoff.",
          error: null,
        };
        hostPort.postMessage({ v: 2, op: "audio-session-event", state });
        hostPort.postMessage({ v: 2, op: "audio-session-reply", id: msg.id, ok: true, data: state });
        return;
      }
      if (msg?.op !== "call") return;
      if (msg.args?.record_id === "missing") {
        hostPort.postMessage({
          v: 2,
          op: "reply",
          id: msg.id,
          ok: false,
          refusal: { code: "not_found", text: "Meeting not found" },
        });
      } else if (msg.args?.record_id === "stale") {
        hostPort.postMessage({
          v: 2,
          op: "reply",
          id: msg.id,
          ok: false,
          refusal: { code: "stale_revision", text: "Revision conflict" },
        });
      }
    };
    hostPort.start();
    const ready = await readyPromise;
    expect(ready).toEqual({
      v: 1,
      op: "ready",
      accepts: [
        "screen.v2",
        "screen-records.v1",
        "screen-locale.v1",
        "screen-audio.v2",
      ],
    });

    hostPort.postMessage(makePush({ route: { section: "new", view: "list", record_id: null, segment_id: null } }));
    await new Promise((r) => setTimeout(r, 15));

    let ungrantedErr = null;
    try {
      await ch.audioSession(
        { installId: INSTALL_ID, digest: DIGEST, contextId: "org-test" },
        { action: "start", language: "zh" },
      );
    } catch (err) {
      ungrantedErr = err;
    }
    expect(ungrantedErr?.status).toBe(403);

    hostPort.postMessage(
      makePush({
        audio_capture: 1,
        route: { section: "new", view: "list", record_id: null, segment_id: null },
      }),
    );
    await new Promise((r) => setTimeout(r, 15));

    const snap = await ch.audioSession(
      { installId: INSTALL_ID, digest: DIGEST, contextId: "org-test" },
      { action: "start", language: "zh" },
    );
    expect(snap.phase).toBe("recording");
    expect(ch.getAudioSession()?.level).toBe(64);

    let missingErr = null;
    try {
      await ch.request("records.show", { record_id: "missing" });
    } catch (err) {
      missingErr = err;
    }
    expect(missingErr?.status).toBe(404);

    let staleErr = null;
    try {
      await ch.request("records.update", {
        record_id: "stale",
        expected_revision: 1,
        profile: { title: "Updated" },
      });
    } catch (err) {
      staleErr = err;
    }
    expect(staleErr?.status).toBe(409);

    hostPort.close();
    ch.resetForTests();
  });

  test("enforces the 16 KiB wire args ceiling and closed field allowlist", () => {
    expect(SCREEN_SERVICE_ARGS_BYTES).toBe(16384);
    expect(() =>
      cleanArgs("records.show", { record_id: "mtg-1", unexpected_field: true }),
    ).toThrow(/Refused Meeting minutes field/);

    const oversizedTranscript = "x".repeat(17000);
    expect(() =>
      cleanArgs("records.create", {
        record_id: "mtg-huge",
        profile: { transcript: oversizedTranscript },
      }),
    ).toThrow(/16 KiB wire budget/);
  });

  test("admits section=new route and publishes generic v2 leave state while rejecting malformed actions", async () => {
    resetScopeForTests();
    let hostPort = null;
    const leaves = [];

    channel.start({
      boot: {
        tag: "minutes",
        bridge_nonce: NONCE,
        generation: 7,
        parent_origin: "https://demo-company.cadencecloud.app",
      },
      parent: {
        postMessage(_msg, _origin, transfer) {
          hostPort = transfer[0];
        },
      },
    });

    const readyPromise = new Promise((resolve) => {
      hostPort.onmessage = (event) => {
        if (event.data?.op === "ready") resolve(event.data);
      };
    });
    hostPort.start();
    await readyPromise;

    hostPort.onmessage = (event) => {
      if (event.data?.op === "leave") leaves.push(event.data);
    };

    hostPort.postMessage(
      makePush({
        context_id: "default",
        presentation_locale: "zh-TW",
        route: { section: "new", view: "list", record_id: null, segment_id: null },
        contexts: [{ id: "default", label: "Meeting minutes" }],
        runs: [],
        outbox: [],
        publish_intents: { status: "ok", withheld: 0, rows: [] },
        defaults: {},
        readiness: { workflows: {} },
        now: 1794445512,
        actions: [
          "records.list",
          "records.show",
          "records.create",
          "records.update",
          "screen.route.patch",
          "screen.drawer.open",
          "screen.drawer.close",
          "records.delete",
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 15));

    const scope = getScope();
    expect(scope).toBeTruthy();
    expect(scope.presentationLocale).toBe("zh-HK");
    expect(scope.route?.section).toBe("new");
    expect(admitted("records.create", scope.actions)).toBe(true);
    expect(admitted("screen.drawer.open", scope.actions)).toBe(false);
    expect(scope.actions).not.toContain("records.delete");
    expect(admitted("records.delete", scope.actions)).toBe(false);

    const leave = channel.ownMinutesLeaveState();
    expect(leave).toBeTruthy();
    leave.publish(true);
    leave.release();
    await new Promise((r) => setTimeout(r, 15));
    expect(leaves).toEqual([
      { v: 2, op: "leave", unsaved: true },
      { v: 2, op: "leave", unsaved: false },
    ]);

    // Malformed action tokens fail closed and retire the bridge.
    hostPort.postMessage(
      makePush({
        context_id: "default",
        actions: ["records.list", "BAD VERB"],
      }),
    );
    await new Promise((r) => setTimeout(r, 15));
    expect(getScope()).toBeNull();
    expect(scopeError()).toContain("Invalid screen scope projection");

    hostPort.close();
    resetScopeForTests();
  });
});
