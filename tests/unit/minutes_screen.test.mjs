import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { channel } from "../../src/bridge/channel.ts";
import { resetScopeForTests } from "../../src/bridge/scope.ts";
import {
  deriveGeneratedTitle,
  parseTranscriptLines,
  resolveTitleSubmission,
} from "../../src/features/minutes/model.ts";
import MinutesScreen from "../../src/features/minutes/MinutesScreen.tsx";

beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
  }
});

let mountedRoot = null;
let mountedEl = null;

afterEach(() => {
  if (mountedRoot) {
    mountedRoot.unmount();
    mountedRoot = null;
  }
  if (mountedEl) {
    mountedEl.remove();
    mountedEl = null;
  }
  channel.resetForTests();
  resetScopeForTests();
});

const NONCE = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const DIGEST = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const INSTALL_ID = "inst-minutes-ui";

function makeRecord(id, overrides = {}) {
  const profile = {
    schema: 1,
    title: "Q4 onboarding sync",
    title_source: "user",
    held_at: "2026-11-10T02:00:00Z",
    duration_seconds: 1800,
    status: "reviewed",
    participants: ["Carmen Leung", "Alex Wong"],
    participants_text: "Carmen Leung, Alex Wong",
    tags: ["q4"],
    summary: "Agreed two-stage onboarding.",
    decisions: [{ id: "dec-1", text: "Use two-stage checklist", quote: null, timestamp: "02:10" }],
    followups: [
      { id: "fup-1", task: "Send welcome template", owner: "Carmen Leung", due: "2026-11-14", status: "open" },
      { id: "fup-2", task: "Verify retry window", owner: null, due: null, status: "open" },
    ],
    transcript: "[02:10] Carmen Leung: Let's use the two-stage checklist.",
    synthetic: true,
    ...(overrides.profile ?? {}),
  };
  return {
    id,
    install_id: INSTALL_ID,
    context_id: "org-ui",
    kind: "meeting",
    revision: overrides.revision ?? 1,
    digest: DIGEST,
    profile,
    history: overrides.history ?? [
      {
        revision: 1,
        operation: "create",
        actor: "user:carmen",
        at: Date.parse("2026-11-10T02:15:00Z"),
        digest: DIGEST,
        before: null,
        after: profile,
        provenance: { method: "screen_form" },
      },
    ],
    history_truncated: false,
  };
}

function setReactValue(el, value) {
  const propKey = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (propKey && typeof el[propKey]?.onChange === "function") {
    el[propKey].onChange({ target: { value } });
  } else {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("Timed out waiting for UI condition");
}

function mountWithMockHost({
  records = [],
  route = { section: "all", view: "list", record_id: null, segment_id: null },
  surfaceRole = "primary",
} = {}) {
  const rows = [...records];
  let currentRoute = { ...route };
  const calls = [];
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

  const pushCurrent = () => {
    hostPort.postMessage({
      v: 2,
      op: "screen",
      tag: "minutes",
      install_id: INSTALL_ID,
      context_id: "org-ui",
      digest: DIGEST,
      presentation_locale: "en",
      installation: {
        install_id: INSTALL_ID,
        name: "meeting-minutes",
        title: "Meeting minutes",
        version: "0.3.0",
        digest: DIGEST,
        summary: "Meeting minutes",
      },
      actions: ["records.list", "records.show", "records.create", "records.update", "screen.route.patch"],
      route: { ...currentRoute },
      read_observations: [],
    });
  };

  hostPort.onmessage = (event) => {
    const msg = event.data;
    if (msg?.op === "ready") {
      hostPort.postMessage(
        surfaceRole === "drawer"
          ? { v: 1, op: "surface", role: "drawer", modal: false, surface: "detail" }
          : { v: 1, op: "surface", role: "primary", modal: false },
      );
      pushCurrent();
      return;
    }
    if (msg?.op !== "call") return;
    calls.push({ verb: msg.verb, args: msg.args });
    if (msg.verb === "records.list") {
      hostPort.postMessage({
        v: 2,
        op: "reply",
        id: msg.id,
        ok: true,
        data: { records: rows, total: rows.length, truncated: false, next_cursor: null },
      });
    } else if (msg.verb === "records.show") {
      const found = rows.find((r) => r.id === msg.args.record_id);
      if (!found) {
        hostPort.postMessage({
          v: 2,
          op: "reply",
          id: msg.id,
          ok: false,
          refusal: { code: "not_found", text: "Not found" },
        });
      } else {
        hostPort.postMessage({
          v: 2,
          op: "reply",
          id: msg.id,
          ok: true,
          data: { record: found },
        });
      }
    } else if (msg.verb === "records.create") {
      const created = makeRecord(msg.args.record_id, { profile: msg.args.profile, revision: 1 });
      rows.unshift(created);
      hostPort.postMessage({ v: 2, op: "reply", id: msg.id, ok: true, data: { record: created } });
    } else if (msg.verb === "records.update") {
      const idx = rows.findIndex((r) => r.id === msg.args.record_id);
      const updated = makeRecord(msg.args.record_id, {
        profile: msg.args.profile,
        revision: (rows[idx]?.revision ?? 1) + 1,
      });
      if (idx >= 0) rows[idx] = updated;
      hostPort.postMessage({ v: 2, op: "reply", id: msg.id, ok: true, data: { record: updated } });
    } else if (msg.verb === "screen.route.patch") {
      currentRoute = {
        section: msg.args.section ?? currentRoute.section,
        view: msg.args.view ?? currentRoute.view,
        record_id: msg.args.record_id === undefined ? currentRoute.record_id : msg.args.record_id,
        segment_id: null,
      };
      hostPort.postMessage({ v: 2, op: "reply", id: msg.id, ok: true, data: { route: currentRoute } });
      pushCurrent();
    } else {
      hostPort.postMessage({ v: 2, op: "reply", id: msg.id, ok: true, data: {} });
    }
  };
  hostPort.start();

  mountedEl = document.createElement("div");
  document.body.appendChild(mountedEl);
  mountedRoot = createRoot(mountedEl);
  mountedRoot.render(React.createElement(MinutesScreen));

  return { container: mountedEl, calls, rows };
}

describe("Meeting minutes domain model & screen interactions", () => {
  test("derives generated titles from discussion while never overwriting user-set titles", () => {
    expect(
      deriveGeneratedTitle("[00:15] Carmen: Kickoff Q4 retail staffing plan for Harbour City."),
    ).toBe("Kickoff Q4 retail staffing plan for Harbour City");

    const generated = resolveTitleSubmission({
      typedTitle: "   ",
      transcript: "[02:00] Alex: Finalize winter supplier contract.",
    });
    expect(generated).toEqual({
      title: "Finalize winter supplier contract",
      titleSource: "generated",
    });

    const userLocked = resolveTitleSubmission({
      typedTitle: "",
      transcript: "New transcript line that should not overwrite user title",
      existingTitle: "Board-approved Q4 Kickoff",
      existingTitleSource: "user",
    });
    expect(userLocked).toEqual({
      title: "Board-approved Q4 Kickoff",
      titleSource: "user",
    });

    const lines = parseTranscriptLines("[01:22] Alex Wong: Confirmed cutover window.\nPlain note line");
    expect(lines).toEqual([
      { timestamp: "01:22", speaker: "Alex Wong", text: "Confirmed cutover window." },
      { timestamp: null, speaker: null, text: "Plain note line" },
    ]);
  });

  test("renders populated meetings with title-origin badges and supports inline Rename to user title", async () => {
    const r1 = makeRecord("mtg-user-1", {
      profile: { title: "Q4 onboarding sync", title_source: "user" },
    });
    const r2 = makeRecord("mtg-gen-2", {
      profile: { title: "Harbour City pop-up staffing", title_source: "generated" },
    });

    const { container, calls } = mountWithMockHost({
      records: [r1, r2],
      route: { section: "all", view: "list", record_id: "mtg-gen-2", segment_id: null },
    });

    await waitFor(() => {
      const buttons = [...container.querySelectorAll("button")];
      return buttons.some((b) => b.textContent?.trim() === "Rename");
    });
    expect(container.textContent).toContain("your title");
    expect(container.textContent).toContain("from the discussion");

    // Click Rename inside the detail drawer and save a user title.
    const renameBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Rename",
    );
    expect(renameBtn).toBeTruthy();
    renameBtn.click();

    await waitFor(() => container.querySelector(".mm-rename-box") !== null);
    const renameForm = container.querySelector(".mm-rename-box");
    expect(renameForm).toBeTruthy();
    const input = renameForm.querySelector("input");
    setReactValue(input, "Harbour City Pop-up Final Plan");
    await waitFor(() => input.value === "Harbour City Pop-up Final Plan");
    const saveBtn = [...renameForm.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Save title",
    );
    saveBtn.click();

    await waitFor(() => calls.some((c) => c.verb === "records.update"));
    const updateCall = calls.find((c) => c.verb === "records.update");
    expect(updateCall.args.profile.title).toBe("Harbour City Pop-up Final Plan");
    expect(updateCall.args.profile.title_source).toBe("user");
    expect(updateCall.args.consent_provenance).toEqual({ method: "inline_rename" });
  });

  test("creates minutes from compose drawer with generated title when title left blank and null owner/due", async () => {
    const { container, calls } = mountWithMockHost({
      records: [],
      route: { section: "all", view: "new", record_id: null, segment_id: null },
    });

    await waitFor(() => container.querySelector(".mm-mono-textarea") !== null);
    const transcriptArea = container.querySelector(".mm-mono-textarea");
    setReactValue(
      transcriptArea,
      "[00:30] Priya Nair: Finalize Q1 partner SLA terms before next Tuesday.",
    );
    await waitFor(() => transcriptArea.value.includes("Finalize Q1 partner SLA terms"));

    const addFollowupBtn = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Add follow-up"),
    );
    expect(addFollowupBtn).toBeTruthy();
    addFollowupBtn.click();
    await waitFor(() => container.querySelectorAll(".mm-subeditor-card").length >= 1);

    const followupTaskInput = container.querySelector(".mm-subeditor-card input");
    setReactValue(followupTaskInput, "Circulate redlined SLA appendix");
    await waitFor(() => followupTaskInput.value === "Circulate redlined SLA appendix");

    const createForm = container.querySelector("#mm-create-form");
    expect(createForm).toBeTruthy();
    createForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => calls.some((c) => c.verb === "records.create"));
    const createCall = calls.find((c) => c.verb === "records.create");
    expect(createCall.args.profile.title).toBe(
      "Finalize Q1 partner SLA terms before next Tuesday",
    );
    expect(createCall.args.profile.title_source).toBe("generated");
    expect(createCall.args.profile.followups).toEqual([
      expect.objectContaining({
        task: "Circulate redlined SLA appendix",
        owner: null,
        due: null,
        status: "open",
      }),
    ]);
  });

  test("renders Follow-ups section with Unassigned/No due date honesty and single-chrome drawer surface", async () => {
    const r1 = makeRecord("mtg-1");
    const { container } = mountWithMockHost({
      records: [r1],
      route: { section: "followups", view: "list", record_id: null, segment_id: null },
    });

    await waitFor(() => (container.textContent ?? "").includes("Verify retry window"));
    expect(container.textContent).toContain("Unassigned");
    expect(container.textContent).toContain("No due date");

    // Unmount and mount as a host-owned drawer surface -> single chrome (.mm-hosted-drawer), no nested .mm-frame-drawer scrim.
    mountedRoot.unmount();
    mountedRoot = null;
    mountedEl.remove();
    mountedEl = null;
    channel.resetForTests();
    resetScopeForTests();

    const drawerMount = mountWithMockHost({
      records: [r1],
      route: { section: "all", view: "list", record_id: "mtg-1", segment_id: null },
      surfaceRole: "drawer",
    });

    await waitFor(() => drawerMount.container.querySelector(".mm-hosted-drawer") !== null);
    expect(drawerMount.container.querySelector(".mm-frame-drawer")).toBeNull();
  });
});
