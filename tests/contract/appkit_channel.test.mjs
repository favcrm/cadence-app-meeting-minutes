import { describe, expect, test } from "bun:test";
import { createChannel } from "../../src/bridge/channel.ts";
import { resetScopeForTests } from "../../src/bridge/scope.ts";
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
      version: "0.3.0",
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

  test("advertises the exact 4 capabilities on ready and maps refusal codes accurately", async () => {
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

    const readyPromise = new Promise((resolve) => {
      hostPort.onmessage = (event) => {
        if (event.data?.op === "ready") resolve(event.data);
      };
    });
    hostPort.start();
    const ready = await readyPromise;
    expect(ready).toEqual({
      v: 1,
      op: "ready",
      accepts: ["screen.v2", "screen-surfaces.v1", "screen-records.v1", "crm-locale.v1"],
    });

    hostPort.postMessage({ v: 1, op: "surface", role: "primary", modal: false });
    hostPort.postMessage(makePush());
    await new Promise((r) => setTimeout(r, 15));

    hostPort.onmessage = (event) => {
      const msg = event.data;
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

    await expect(ch.request("records.show", { record_id: "missing" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      ch.request("records.update", {
        record_id: "stale",
        expected_revision: 1,
        profile: { title: "Updated" },
      }),
    ).rejects.toMatchObject({
      status: 409,
    });

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
});
