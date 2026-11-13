import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { channel } from "../../src/bridge/channel.ts";
import { resetScopeForTests } from "../../src/bridge/scope.ts";
import {
  createInitialTrackerState,
  formatClock,
  formatWallClockAtOffset,
  reconcileStreamingTranscript,
} from "../../src/features/minutes/liveTranscript.ts";
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

function makeAudioSnapshot(overrides = {}) {
  return {
    session_id: "sess-test-1",
    mode: "record",
    phase: "idle",
    held_at: "",
    elapsed_seconds: 0,
    level: 0,
    peak: 0,
    segments_total: 0,
    segments_done: 0,
    segments_in_flight: 0,
    segments_failed: 0,
    no_speech_segments: 0,
    transcript: "",
    error: null,
    ...overrides,
  };
}

function mountWithMockHost({
  records = [],
  route = { section: "all", view: "list", record_id: null, segment_id: null },
  audioCapture = false,
  onAudioSession = null,
} = {}) {
  const rows = [...records];
  let currentRoute = { ...route };
  const calls = [];
  const audioCommands = [];
  let hostPort = null;
  let audioSnap = makeAudioSnapshot();

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

  const emitAudio = (next) => {
    audioSnap = next;
    hostPort.postMessage({ v: 2, op: "audio-session-event", state: next });
  };

  const pushCurrent = () => {
    hostPort.postMessage({
      v: 2,
      op: "screen",
      tag: "minutes",
      install_id: INSTALL_ID,
      context_id: "org-ui",
      digest: DIGEST,
      presentation_locale: "en",
      ...(audioCapture ? { audio_capture: 1 } : {}),
      installation: {
        install_id: INSTALL_ID,
        name: "meeting-minutes",
        title: "Meeting minutes",
        version: "0.6.1",
        digest: DIGEST,
        summary: "Meeting minutes",
      },
      actions: [
        "records.list",
        "records.show",
        "records.create",
        "records.update",
        "screen.route.patch",
      ],
      route: { ...currentRoute },
      read_observations: [],
    });
  };

  hostPort.onmessage = (event) => {
    const msg = event.data;
    if (msg?.op === "ready") {
      pushCurrent();
      return;
    }
    if (msg?.op === "audio-session") {
      audioCommands.push(msg);
      if (onAudioSession) {
        const custom = onAudioSession(msg, { emitAudio, getState: () => audioSnap });
        hostPort.postMessage({
          v: 2,
          op: "audio-session-reply",
          id: msg.id,
          ...custom,
        });
        return;
      }

      if (msg.action === "start") {
        const started = makeAudioSnapshot({
          session_id: "sess-rec-01",
          mode: "record",
          phase: "recording",
          held_at: "2026-11-13T04:00:00Z",
          elapsed_seconds: 12,
          level: 64,
          peak: 82,
          segments_total: 1,
          segments_done: 1,
          transcript: "Ada Lin: Confirm Harbour City launch date next Tuesday.",
        });
        emitAudio(started);
        hostPort.postMessage({ v: 2, op: "audio-session-reply", id: msg.id, ok: true, data: started });
        return;
      }
      if (msg.action === "stop") {
        const stopped = makeAudioSnapshot({
          ...audioSnap,
          phase: "ready",
          held_at: audioSnap.held_at || "2026-11-13T04:00:00Z",
          elapsed_seconds: 125,
          level: 0,
          peak: 0,
          segments_total: 3,
          segments_done: 3,
          no_speech_segments: 1,
          transcript:
            "Ada Lin: Confirm Harbour City launch date next Tuesday.\nMarcus Ho: Staging sign-off finishes Friday.",
        });
        emitAudio(stopped);
        hostPort.postMessage({ v: 2, op: "audio-session-reply", id: msg.id, ok: true, data: stopped });
        return;
      }
      if (msg.action === "upload") {
        const heldAt =
          typeof msg.last_modified === "number" && msg.last_modified > 0
            ? new Date(msg.last_modified).toISOString().replace(/\.\d{3}Z$/, "Z")
            : "2026-11-13T04:00:00Z";
        const uploaded = makeAudioSnapshot({
          session_id: "sess-up-01",
          mode: "upload",
          phase: "ready",
          held_at: heldAt,
          elapsed_seconds: 184,
          segments_total: 2,
          segments_done: 2,
          transcript:
            "Carmen Leung: Upload Harbour City roster.\nAlex Wong: Circulate vendor delivery schedule.",
        });
        emitAudio(uploaded);
        hostPort.postMessage({ v: 2, op: "audio-session-reply", id: msg.id, ok: true, data: uploaded });
        return;
      }
      if (msg.action === "cancel") {
        const idle = makeAudioSnapshot({ session_id: "", phase: "idle", held_at: "" });
        emitAudio(idle);
        hostPort.postMessage({ v: 2, op: "audio-session-reply", id: msg.id, ok: true, data: idle });
        return;
      }
      hostPort.postMessage({ v: 2, op: "audio-session-reply", id: msg.id, ok: true, data: audioSnap });
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

  return { container: mountedEl, calls, audioCommands, emitAudio, rows };
}

describe("Meeting minutes domain model & dedicated full-page screen interactions", () => {
  test("derives generated titles from discussion while never overwriting user-set titles", () => {
    expect(
      deriveGeneratedTitle("[00:15] Carmen: Kickoff Q4 retail staffing plan for Harbour City."),
    ).toBe("Kickoff Q4 retail staffing plan for Harbour City");
    expect(
      deriveGeneratedTitle("00:12 林雅婷：確認下星期二前完成海港城快閃店排班與收銀機測試。"),
    ).toBe("確認下星期二前完成海港城快閃店排班與收銀機測試");

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

  test("stamps untimestamped streaming audio segments accurately across silent gaps, uploads, and middle retries", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(125)).toBe("02:05");
    expect(formatClock(3725)).toBe("01:02:05");
    expect(formatWallClockAtOffset("2026-11-13T04:00:00Z", "00:20", "en")).toMatch(/^\d{2}:00:20$/);

    // Live record mode: segment 0 spoken (00:00), segment 1 silent, segment 2 failed -> segment 3 spoken (00:30), then segment 2 retried -> inserted at 00:20!
    let state = createInitialTrackerState();
    state = reconcileStreamingTranscript(
      state,
      makeAudioSnapshot({
        session_id: "s-rec",
        mode: "record",
        phase: "recording",
        elapsed_seconds: 10,
        segments_total: 1,
        segments_done: 1,
        no_speech_segments: 0,
        transcript: "First spoken segment",
      }),
    );
    expect(state.formattedTranscript).toBe("[00:00] First spoken segment");

    // Segment 1 silent at 20s
    state = reconcileStreamingTranscript(
      state,
      makeAudioSnapshot({
        session_id: "s-rec",
        mode: "record",
        phase: "recording",
        elapsed_seconds: 20,
        segments_total: 2,
        segments_done: 2,
        no_speech_segments: 1,
        transcript: "First spoken segment",
      }),
    );
    expect(state.formattedTranscript).toBe("[00:00] First spoken segment");

    // Segment 2 fails at 30s
    state = reconcileStreamingTranscript(
      state,
      makeAudioSnapshot({
        session_id: "s-rec",
        mode: "record",
        phase: "recording",
        elapsed_seconds: 30,
        segments_total: 3,
        segments_done: 2,
        segments_failed: 1,
        no_speech_segments: 1,
        transcript: "First spoken segment",
      }),
    );

    // Segment 3 succeeds at 40s -> should get [00:30]
    state = reconcileStreamingTranscript(
      state,
      makeAudioSnapshot({
        session_id: "s-rec",
        mode: "record",
        phase: "ready",
        elapsed_seconds: 40,
        segments_total: 4,
        segments_done: 3,
        segments_failed: 1,
        no_speech_segments: 1,
        transcript: "First spoken segment\nFourth segment after failure",
      }),
    );
    expect(state.formattedTranscript).toBe(
      "[00:00] First spoken segment\n[00:30] Fourth segment after failure",
    );

    // Retry re-queues failed segment 2 (segments_failed drops 1 -> 0, in_flight = 1)
    state = reconcileStreamingTranscript(
      state,
      makeAudioSnapshot({
        session_id: "s-rec",
        mode: "record",
        phase: "transcribing",
        elapsed_seconds: 40,
        segments_total: 4,
        segments_done: 3,
        segments_in_flight: 1,
        segments_failed: 0,
        no_speech_segments: 1,
        transcript: "First spoken segment\nFourth segment after failure",
      }),
    );

    // Retried segment 2 completes -> inserted in middle with its exact original [00:20] timestamp!
    state = reconcileStreamingTranscript(
      state,
      makeAudioSnapshot({
        session_id: "s-rec",
        mode: "record",
        phase: "ready",
        elapsed_seconds: 40,
        segments_total: 4,
        segments_done: 4,
        segments_in_flight: 0,
        segments_failed: 0,
        no_speech_segments: 1,
        transcript: "First spoken segment\nRecovered third segment\nFourth segment after failure",
      }),
    );
    expect(state.formattedTranscript).toBe(
      "[00:00] First spoken segment\n[00:20] Recovered third segment\n[00:30] Fourth segment after failure",
    );

    // Upload mode (45s chunks) + passthrough of pre-timestamped lines
    const upState = reconcileStreamingTranscript(
      createInitialTrackerState(),
      makeAudioSnapshot({
        session_id: "s-up",
        mode: "upload",
        phase: "ready",
        elapsed_seconds: 130,
        segments_total: 3,
        segments_done: 3,
        transcript: "Opening remarks\nSecond chunk notes\n[01:35] Explicit timestamp preserved",
      }),
    );
    expect(upState.formattedTranscript).toBe(
      "[00:00] Opening remarks\n[00:45] Second chunk notes\n[01:35] Explicit timestamp preserved",
    );
  });

  test("opens dedicated full-page MeetingDetailPage with underline tabs and supports inline Rename to user title (zero drawers)", async () => {
    const r1 = makeRecord("mtg-user-1", {
      profile: { title: "Q4 onboarding sync", title_source: "user" },
    });
    const r2 = makeRecord("mtg-gen-2", {
      profile: { title: "Harbour City pop-up staffing", title_source: "generated" },
    });

    const { container, calls } = mountWithMockHost({
      records: [r1, r2],
      route: { section: "all", view: "list", record_id: null, segment_id: null },
    });

    await waitFor(() => (container.textContent ?? "").includes("Harbour City pop-up staffing"));
    expect(container.textContent).toContain("your title");
    expect(container.textContent).toContain("from the discussion");

    // Click meeting row link -> routes to dedicated full-page MeetingDetailPage (no drawer).
    const secondCard = [...container.querySelectorAll(".mm-row-link")].find((el) =>
      (el.textContent ?? "").includes("Harbour City pop-up staffing"),
    );
    expect(secondCard).toBeTruthy();
    secondCard.click();

    await waitFor(() => container.querySelector(".mm-detail-page") !== null);
    expect(container.querySelector(".mm-hosted-drawer")).toBeNull();
    expect(container.querySelector(".mm-frame-drawer")).toBeNull();
    expect(container.querySelector(".mm-back-link")?.textContent).toContain("All meetings");

    // Verify 4 underline tabs exist and switch cleanly.
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((el) => el.textContent?.trim());
    expect(tabs.some((t) => t?.startsWith("Summary"))).toBe(true);
    expect(tabs.some((t) => t?.startsWith("Decisions & Follow-ups"))).toBe(true);
    expect(tabs.some((t) => t?.startsWith("Transcript"))).toBe(true);
    expect(tabs.some((t) => t?.startsWith("History"))).toBe(true);

    // Verify full-width 2-column executive result layout, 4 KPI cells, inline digest table & right rail
    expect(container.querySelector(".mm-detail-grid")).not.toBeNull();
    expect(container.querySelectorAll(".mm-result-kpi-cell").length).toBe(4);
    expect(container.querySelector(".mm-digest-card")).not.toBeNull();
    expect(container.querySelector(".mm-result-actions-table")).not.toBeNull();
    expect(container.querySelectorAll(".mm-participant-chip").length).toBe(2);

    // Clicking decision [02:10] evidence pill jumps to Transcript tab & highlights cited row
    const jumpBtn = container.querySelector(".mm-ts-pill-jump");
    expect(jumpBtn?.textContent?.trim()).toBe("02:10");
    jumpBtn.click();

    await waitFor(() => container.querySelector(".mm-transcript-panel-card") !== null);
    const highlightedRow = container.querySelector('.mm-transcript-line[data-highlighted="true"]');
    expect(highlightedRow).not.toBeNull();
    expect(highlightedRow?.getAttribute("data-ts-key")).toBe("02:10");
    expect(highlightedRow?.textContent).toContain("Cited in decision: Use two-stage checklist");

    // Search filter highlights matches with <mark>
    const filterInput = container.querySelector(".mm-transcript-search-input");
    setReactValue(filterInput, "checklist");
    await waitFor(() => container.querySelector("mark.mm-search-mark") !== null);
    expect(container.querySelector("mark.mm-search-mark")?.textContent?.toLowerCase()).toBe("checklist");

    const renameBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Rename",
    );
    expect(renameBtn).toBeTruthy();
    renameBtn.click();

    await waitFor(() => container.querySelector(".mm-rename-box") !== null);
    const renameForm = container.querySelector(".mm-rename-box");
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

  test("creates minutes on dedicated NewMeetingPage (section=new) with Paste transcript fallback and opens full-page MeetingDetailPage", async () => {
    const { container, calls } = mountWithMockHost({
      records: [],
      route: { section: "new", view: "list", record_id: null, segment_id: null },
      audioCapture: false,
    });

    await waitFor(() => container.querySelector(".mm-new-page") !== null);
    const createForm = container.querySelector("#mm-create-form");
    expect(createForm).toBeTruthy();

    const optionalDetails = createForm.querySelector("details.mm-optional-settings");
    expect(optionalDetails).toBeTruthy();
    expect(optionalDetails.hasAttribute("open")).toBe(false);
    expect(optionalDetails.textContent).toContain("Untitled meeting (named from discussion)");
    expect(optionalDetails.textContent).toContain("No attendees listed");
    expect(createForm.querySelector(".mm-wire-meter")).toBeNull();

    const transcriptArea = createForm.querySelector(".mm-mono-textarea");
    setReactValue(
      transcriptArea,
      "[00:30] Priya Nair: Finalize Q1 partner SLA terms before next Tuesday.",
    );
    await waitFor(() => transcriptArea.value.includes("Finalize Q1 partner SLA terms"));

    expect(optionalDetails.querySelector(".mm-optional-summary-title")?.textContent).toBe(
      "Finalize Q1 partner SLA terms before next Tuesday",
    );

    createForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => calls.some((c) => c.verb === "records.create"));
    const createCall = calls.find((c) => c.verb === "records.create");
    expect(createCall.args.profile.title).toBe(
      "Finalize Q1 partner SLA terms before next Tuesday",
    );
    expect(createCall.args.profile.title_source).toBe("generated");
    expect(createCall.args.profile.status).toBe("draft");
    expect(createCall.args.profile.duration_seconds).toBeNull();

    // Routes directly to dedicated full-page MeetingDetailPage -> Edit minutes opens full-page MeetingEditForm.
    await waitFor(() => container.querySelector(".mm-detail-page") !== null);
    const editBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Edit minutes",
    );
    expect(editBtn).toBeTruthy();
    editBtn.click();

    await waitFor(() => container.querySelector("#mm-edit-form") !== null);
    const addFollowupBtn = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Add follow-up"),
    );
    addFollowupBtn.click();
    await waitFor(() => container.querySelectorAll(".mm-subeditor-card").length >= 1);

    const followupTaskInput = container.querySelector(".mm-subeditor-card input");
    setReactValue(followupTaskInput, "Circulate redlined SLA appendix");
    await waitFor(() => followupTaskInput.value === "Circulate redlined SLA appendix");

    const editForm = container.querySelector("#mm-edit-form");
    editForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => calls.some((c) => c.verb === "records.update"));
    const updateCall = calls.find((c) => c.verb === "records.update");
    expect(updateCall.args.profile.followups).toEqual([
      expect.objectContaining({
        task: "Circulate redlined SLA appendix",
        owner: null,
        due: null,
        status: "open",
      }),
    ]);
  });

  test("renders Follow-ups section with Unassigned/No due date honesty and navigates back to Follow-ups from detail page", async () => {
    const r1 = makeRecord("mtg-1");
    const { container } = mountWithMockHost({
      records: [r1],
      route: { section: "followups", view: "list", record_id: null, segment_id: null },
    });

    await waitFor(() => (container.textContent ?? "").includes("Verify retry window"));
    expect(container.textContent).toContain("Unassigned");
    expect(container.textContent).toContain("No due date");

    const openMeetingLink = container.querySelector(".mm-row-link");
    expect(openMeetingLink).toBeTruthy();
    openMeetingLink.click();

    await waitFor(() => container.querySelector(".mm-detail-page") !== null);
    expect(container.querySelector(".mm-back-link")?.textContent).toContain("Follow-ups");
  });

  test("renders ErrorNotice immediately instead of hanging on loading when initial scope push is refused", async () => {
    let hostPort = null;
    channel.start({
      boot: {
        tag: "minutes",
        bridge_nonce: NONCE,
        generation: 9,
        parent_origin: "http://localhost:3187",
      },
      parent: {
        postMessage(_msg, _origin, transfer) {
          hostPort = transfer[0];
        },
      },
    });

    mountedEl = document.createElement("div");
    document.body.appendChild(mountedEl);
    mountedRoot = createRoot(mountedEl);
    mountedRoot.render(React.createElement(MinutesScreen));

    await waitFor(() => (mountedEl.textContent ?? "").includes("Reading meetings…"));

    const readyPromise = new Promise((resolve) => {
      hostPort.onmessage = (event) => {
        if (event.data?.op === "ready") resolve(event.data);
      };
    });
    hostPort.start();
    await readyPromise;

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
        name: "foreign-app",
        title: "Foreign",
        version: "0.6.1",
        digest: DIGEST,
        summary: "Foreign",
      },
      actions: ["records.list"],
      route: { section: "all", view: "list", record_id: null, segment_id: null },
      read_observations: [],
    });

    await waitFor(() =>
      (mountedEl.textContent ?? "").includes("Invalid screen scope projection"),
    );
    expect(mountedEl.textContent).not.toContain("Reading meetings…");
  });

  test("streams inline Live recording via screen-audio.v2 with VoiceLevelMeter and saves in 1 click via End meeting & save", async () => {
    const { container, calls, audioCommands } = mountWithMockHost({
      records: [],
      route: { section: "new", view: "list", record_id: null, segment_id: null },
      audioCapture: true,
    });

    await waitFor(() => container.querySelector("#mm-btn-start-recording") !== null);
    const createForm = container.querySelector("#mm-create-form");
    expect(createForm).toBeTruthy();

    // Zero upfront text inputs: optional Title & Attendees stay collapsed inside <details>.
    const optionalDetails = createForm.querySelector("details.mm-optional-settings");
    expect(optionalDetails.hasAttribute("open")).toBe(false);

    // 1-click Start recording -> streams voice level meter + live transcript inline (zero modal).
    const startBtn = container.querySelector("#mm-btn-start-recording");
    expect(startBtn.textContent?.trim()).toBe("Start recording");
    startBtn.click();

    await waitFor(() => container.querySelector("#mm-btn-end-and-save") !== null);
    expect(audioCommands[0].action).toBe("start");
    expect(audioCommands[0].language).toBe("");

    const meter = container.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("64");
    expect(container.querySelector(".mm-live-transcript-text")?.textContent).toContain(
      "Confirm Harbour City launch date next Tuesday",
    );
    const livePills = [...container.querySelectorAll(".mm-live-ts-pill")].map((el) =>
      el.textContent?.trim(),
    );
    expect(livePills[0]).toBe("00:00");

    // 1-click End meeting & save -> sends stop, persists timestamped transcript, duration_seconds & held_at, opens MeetingDetailPage!
    const endAndSaveBtn = container.querySelector("#mm-btn-end-and-save");
    endAndSaveBtn.click();

    await waitFor(() => calls.some((c) => c.verb === "records.create"));
    expect(audioCommands.some((cmd) => cmd.action === "stop")).toBe(true);
    const createCall = calls.find((c) => c.verb === "records.create");
    expect(createCall.args.profile.title).toBe("Confirm Harbour City launch date next Tuesday");
    expect(createCall.args.profile.title_source).toBe("generated");
    expect(createCall.args.profile.duration_seconds).toBe(125);
    expect(createCall.args.profile.held_at).toBe("2026-11-13T04:00:00Z");
    expect(createCall.args.profile.transcript).toBe(
      "[00:00] Ada Lin: Confirm Harbour City launch date next Tuesday.\n[00:20] Marcus Ho: Staging sign-off finishes Friday.",
    );

    await waitFor(() => container.querySelector(".mm-detail-page") !== null);
  });

  test("uploads multi-format audio file via screen-audio.v2 with structured 45s timestamps and preserves file.lastModified as held_at", async () => {
    const { container, calls, audioCommands } = mountWithMockHost({
      records: [],
      route: { section: "new", view: "list", record_id: null, segment_id: null },
      audioCapture: true,
    });

    await waitFor(() => container.querySelector("#mm-tab-mode-upload") !== null);
    container.querySelector("#mm-tab-mode-upload").click();

    await waitFor(() => container.querySelector("#mm-audio-file-input") !== null);
    const input = container.querySelector("#mm-audio-file-input");
    const lastModifiedMs = Date.parse("2026-11-12T09:30:00Z");
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6])], "standup.m4a", {
      type: "audio/mp4",
      lastModified: lastModifiedMs,
    });

    const propKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"));
    await input[propKey].onChange({ target: { files: [file] } });

    await waitFor(() =>
      (container.querySelector(".mm-live-transcript-card")?.textContent ?? "").includes(
        "Upload Harbour City roster",
      ),
    );
    const uploadTsPills = [...container.querySelectorAll(".mm-live-ts-pill")].map((el) =>
      el.textContent?.trim(),
    );
    expect(uploadTsPills).toEqual(["00:00", "00:45"]);

    // Toggle inline raw text editor and verify timestamped text is editable
    container.querySelector("#mm-btn-toggle-transcript-edit").click();
    await waitFor(() =>
      container.querySelector(".mm-mono-textarea")?.value.includes("[00:45] Alex Wong"),
    );

    const uploadCmd = audioCommands.find((cmd) => cmd.action === "upload");
    expect(uploadCmd).toBeTruthy();
    expect(uploadCmd.file_name).toBe("standup.m4a");
    expect(uploadCmd.last_modified).toBe(lastModifiedMs);

    const createForm = container.querySelector("#mm-create-form");
    createForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => calls.some((c) => c.verb === "records.create"));
    const createCall = calls.find((c) => c.verb === "records.create");
    expect(createCall.args.profile.duration_seconds).toBe(184);
    expect(createCall.args.profile.held_at).toBe("2026-11-12T09:30:00Z");
    expect(createCall.args.profile.transcript).toBe(
      "[00:00] Carmen Leung: Upload Harbour City roster.\n[00:45] Alex Wong: Circulate vendor delivery schedule.",
    );
  });
});
