import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { channel } from "../../src/bridge/channel.ts";
import { resetScopeForTests } from "../../src/bridge/scope.ts";
import { EN_TEXT, ZH_HK_TEXT } from "../../src/features/minutes/i18n.tsx";
import MinutesScreen from "../../src/features/minutes/MinutesScreen.tsx";

beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
  }
});

afterAll(() => {
  channel.resetForTests();
  resetScopeForTests();
});

const placeholders = (text) => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

describe("Bilingual i18n parity (en + written zh-HK)", () => {
  test("EN_TEXT and ZH_HK_TEXT have exact 1:1 keys, non-empty strings, and identical placeholders", () => {
    const enKeys = Object.keys(EN_TEXT).sort();
    const zhKeys = Object.keys(ZH_HK_TEXT).sort();
    expect(zhKeys).toEqual(enKeys);

    for (const key of enKeys) {
      expect(typeof EN_TEXT[key]).toBe("string");
      expect(EN_TEXT[key].trim().length).toBeGreaterThan(0);
      expect(typeof ZH_HK_TEXT[key]).toBe("string");
      expect(ZH_HK_TEXT[key].trim().length).toBeGreaterThan(0);
      expect(placeholders(ZH_HK_TEXT[key])).toEqual(placeholders(EN_TEXT[key]));
    }
  });

  test("renders written Traditional Chinese when presentation_locale is zh-TW", async () => {
    channel.resetForTests();
    resetScopeForTests();

    const NONCE = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const DIGEST = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    let hostPort = null;

    channel.start({
      boot: {
        tag: "minutes",
        bridge_nonce: NONCE,
        generation: 1,
        parent_origin: "http://localhost:3187",
      },
      parent: {
        postMessage(_msg, _origin, transfer) {
          hostPort = transfer[0];
        },
      },
    });

    hostPort.onmessage = (event) => {
      const msg = event.data;
      if (msg?.op === "ready") {
        hostPort.postMessage({
          v: 2,
          op: "screen",
          tag: "minutes",
          install_id: "inst-zh-1",
          context_id: "org-zh",
          digest: DIGEST,
          presentation_locale: "zh-TW",
          installation: {
            install_id: "inst-zh-1",
            name: "meeting-minutes",
            title: "Meeting minutes",
            version: "0.6.1",
            digest: DIGEST,
            summary: "會議紀錄",
          },
          actions: ["records.list", "records.show", "records.create", "records.update", "screen.route.patch"],
          route: { section: "all", view: "list", record_id: null, segment_id: null },
          read_observations: [],
        });
      } else if (msg?.op === "call" && msg.verb === "records.list") {
        hostPort.postMessage({
          v: 2,
          op: "reply",
          id: msg.id,
          ok: true,
          data: { records: [], total: 0, truncated: false, next_cursor: null },
        });
      }
    };
    hostPort.start();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(React.createElement(MinutesScreen));

    await new Promise((r) => setTimeout(r, 60));
    const html = container.textContent ?? "";
    expect(html).toContain(ZH_HK_TEXT.appTitle);
    expect(html).toContain(ZH_HK_TEXT.emptyTitle);
    expect(html).toContain(ZH_HK_TEXT.newMinutes);

    root.unmount();
    container.remove();
  });
});
