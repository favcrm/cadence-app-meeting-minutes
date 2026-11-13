import type {
  ScreenAudioMode,
  ScreenAudioSessionPhase,
  ScreenAudioSessionSnapshot,
} from "@cadence/app-kit";
import type { MeetingProfile } from "../../src/features/minutes/types";
import { createSeedMeetings, syntheticDigest, type SyntheticMeetingRow } from "./fixtures";

type LocaleOption = "en" | "zh-TW";
type ThemeOption = "dark" | "light";
type AccessOption = "owner" | "viewer";
type DatasetOption = "populated" | "empty";
type SectionOption = "all" | "new" | "followups";

interface RouteState {
  section: SectionOption;
  view: "list" | "new";
  record_id: string | null;
  segment_id: string | null;
}

const INSTALL_ID = "inst-minutes-preview-01";
const DIGEST = "sha256:0303030303030303030303030303030303030303030303030303030303030300";
const CONTEXT_ID = "org-fav-synthetic-preview";
const BRIDGE_NONCE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const frame = document.getElementById("preview-frame") as HTMLIFrameElement;
const stage = document.getElementById("preview-stage") as HTMLElement;
const routeReadout = document.getElementById("preview-route-readout") as HTMLElement;
const leaveIndicator = document.getElementById("preview-leave-indicator") as HTMLElement;

const ctrlSection = document.getElementById("ctrl-section") as HTMLSelectElement;
const ctrlLocale = document.getElementById("ctrl-locale") as HTMLSelectElement;
const ctrlTheme = document.getElementById("ctrl-theme") as HTMLSelectElement;
const ctrlAccess = document.getElementById("ctrl-access") as HTMLSelectElement;
const ctrlDataset = document.getElementById("ctrl-dataset") as HTMLSelectElement;
const ctrlViewport = document.getElementById("ctrl-viewport") as HTMLSelectElement;

let locale: LocaleOption = "en";
let theme: ThemeOption = "dark";
let access: AccessOption = "owner";
let dataset: DatasetOption = "populated";
let generation = 1;
let digestSeq = 50;
let sessionSeq = 0;
let activePort: MessagePort | null = null;
let meetings: SyntheticMeetingRow[] = createSeedMeetings();
let route: RouteState = {
  section: "all",
  view: "list",
  record_id: null,
  segment_id: null,
};

let audioTimer: number | null = null;
let audioState: ScreenAudioSessionSnapshot = createIdleAudioSnapshot();

function createIdleAudioSnapshot(mode: ScreenAudioMode = "record"): ScreenAudioSessionSnapshot {
  return {
    session_id: "",
    mode,
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
  };
}

function stopAudioTimer(): void {
  if (audioTimer !== null) {
    window.clearInterval(audioTimer);
    audioTimer = null;
  }
}

function emitAudioEvent(next: ScreenAudioSessionSnapshot): void {
  audioState = next;
  activePort?.postMessage({
    v: 2,
    op: "audio-session-event",
    state: next,
  });
}

function sampleLines(): [string, string] {
  if (locale === "zh-TW") {
    return [
      "[00:08] 梁嘉敏：確定下星期二尖沙咀海港城門市開幕排更同物資清單。",
      "[00:42] 黃俊傑：我星期五前整理好供應商送貨時間表，並發畀大家確認。",
    ];
  }
  return [
    "[00:08] Carmen Leung: Confirm Harbour City launch roster and logistics checklist for next Tuesday.",
    "[00:42] Alex Wong: I will circulate the vendor delivery schedule before Friday for sign-off.",
  ];
}

function toWireRecord(row: SyntheticMeetingRow, includeHistory = false) {
  return {
    id: row.id,
    install_id: INSTALL_ID,
    context_id: CONTEXT_ID,
    kind: "meeting",
    revision: row.revision,
    digest: row.digest,
    profile: row.profile,
    history: includeHistory ? row.history : [],
    history_truncated: false,
  };
}

function updateReadout(): void {
  const parts: string[] = [`minutes=${route.section}`];
  if (route.view === "new") parts.push("view=new");
  if (route.record_id) parts.push(`record=${route.record_id}`);
  routeReadout.textContent = parts.join("&");
  ctrlSection.value = route.section;
}

function currentActions(): string[] {
  return access === "owner"
    ? [
        "records.list",
        "records.show",
        "records.create",
        "records.update",
        "screen.route.patch",
      ]
    : ["records.list", "records.show", "screen.route.patch"];
}

function pushScreen(): void {
  if (!activePort) return;
  updateReadout();
  activePort.postMessage({
    v: 2,
    op: "screen",
    tag: "minutes",
    install_id: INSTALL_ID,
    digest: DIGEST,
    context_id: CONTEXT_ID,
    presentation_locale: locale,
    ...(access === "owner" ? { audio_capture: 1 } : {}),
    installation: {
      install_id: INSTALL_ID,
      name: "meeting-minutes",
      title: "Meeting minutes",
      version: "0.6.0",
      digest: DIGEST,
      summary:
        "Turn meeting discussions and notes into structured minutes, decisions, and follow-ups.",
    },
    actions: currentActions(),
    route: { ...route },
    read_observations: [],
  });
}

function matchesQuery(row: SyntheticMeetingRow, rawQuery: string | undefined): boolean {
  const q = (rawQuery ?? "").trim().toLowerCase();
  if (!q) return true;
  const hay = [
    row.profile.title,
    row.profile.participants_text,
    row.profile.summary,
    row.profile.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function handleAudioSession(id: string, msg: Record<string, unknown>): void {
  if (!activePort) return;
  const replyOk = (state: ScreenAudioSessionSnapshot) =>
    activePort?.postMessage({ v: 2, op: "audio-session-reply", id, ok: true, data: state });
  const replyErr = (code: string, text: string) =>
    activePort?.postMessage({ v: 2, op: "audio-session-reply", id, ok: false, refusal: { code, text } });

  const action = msg.action;
  if (access !== "owner" && action !== "cancel") {
    replyErr("forbidden", "Audio capture requires owner access.");
    return;
  }

  if (action === "start") {
    stopAudioTimer();
    const sessionId = `aud-prev-${++sessionSeq}`;
    const heldAt = "2026-11-13T04:00:00Z";
    const [line1, line2] = sampleLines();
    const started: ScreenAudioSessionSnapshot = {
      session_id: sessionId,
      mode: "record",
      phase: "recording",
      held_at: heldAt,
      elapsed_seconds: 1,
      level: 58,
      peak: 76,
      segments_total: 1,
      segments_done: 1,
      segments_in_flight: 0,
      segments_failed: 0,
      no_speech_segments: 0,
      transcript: line1,
      error: null,
    };
    emitAudioEvent(started);
    replyOk(started);

    let tick = 1;
    audioTimer = window.setInterval(() => {
      if (audioState.session_id !== sessionId || audioState.phase !== "recording") return;
      tick += 1;
      const level = 38 + ((tick * 19) % 44);
      const peak = Math.min(96, level + 16);
      const hasSecondLine = tick >= 2;
      emitAudioEvent({
        ...audioState,
        elapsed_seconds: tick,
        level,
        peak,
        segments_total: hasSecondLine ? 2 : 1,
        segments_done: hasSecondLine ? 2 : 1,
        transcript: hasSecondLine ? `${line1}\n${line2}` : line1,
      });
    }, 600);
    return;
  }

  if (action === "pause") {
    if (audioState.phase !== "recording") {
      replyErr("conflict", "No active recording to pause.");
      return;
    }
    const paused: ScreenAudioSessionSnapshot = {
      ...audioState,
      phase: "paused",
      level: 0,
      peak: 0,
    };
    emitAudioEvent(paused);
    replyOk(paused);
    return;
  }

  if (action === "resume") {
    if (audioState.phase !== "paused") {
      replyErr("conflict", "Session is not paused.");
      return;
    }
    const resumed: ScreenAudioSessionSnapshot = {
      ...audioState,
      phase: "recording",
      level: 52,
      peak: 70,
    };
    emitAudioEvent(resumed);
    replyOk(resumed);
    return;
  }

  if (action === "stop") {
    stopAudioTimer();
    const [line1, line2] = sampleLines();
    const finalTranscript = audioState.transcript.trim() || `${line1}\n${line2}`;
    const ready: ScreenAudioSessionSnapshot = {
      ...audioState,
      session_id: audioState.session_id || `aud-prev-${++sessionSeq}`,
      mode: "record",
      phase: "ready",
      held_at: audioState.held_at || "2026-11-13T04:00:00Z",
      elapsed_seconds: Math.max(85, audioState.elapsed_seconds),
      level: 0,
      peak: 0,
      segments_total: Math.max(2, audioState.segments_total),
      segments_done: Math.max(2, audioState.segments_done),
      segments_in_flight: 0,
      transcript: finalTranscript,
      error: null,
    };
    emitAudioEvent(ready);
    replyOk(ready);
    return;
  }

  if (action === "upload") {
    stopAudioTimer();
    const sessionId = `aud-prev-${++sessionSeq}`;
    const lastModified =
      typeof msg.last_modified === "number" && Number.isSafeInteger(msg.last_modified) && msg.last_modified > 0
        ? new Date(msg.last_modified).toISOString().replace(/\.\d{3}Z$/, "Z")
        : "2026-11-13T04:00:00Z";
    const [line1, line2] = sampleLines();
    const transcribing: ScreenAudioSessionSnapshot = {
      session_id: sessionId,
      mode: "upload",
      phase: "transcribing",
      held_at: lastModified,
      elapsed_seconds: 125,
      level: 0,
      peak: 0,
      segments_total: 2,
      segments_done: 1,
      segments_in_flight: 1,
      segments_failed: 0,
      no_speech_segments: 0,
      transcript: line1,
      error: null,
    };
    emitAudioEvent(transcribing);
    const ready: ScreenAudioSessionSnapshot = {
      ...transcribing,
      phase: "ready",
      segments_done: 2,
      segments_in_flight: 0,
      transcript: `${line1}\n${line2}`,
    };
    emitAudioEvent(ready);
    replyOk(ready);
    return;
  }

  if (action === "retry") {
    const ready: ScreenAudioSessionSnapshot = {
      ...audioState,
      phase: "ready" as ScreenAudioSessionPhase,
      segments_failed: 0,
      segments_in_flight: 0,
      error: null,
    };
    emitAudioEvent(ready);
    replyOk(ready);
    return;
  }

  if (action === "cancel") {
    stopAudioTimer();
    const idle = createIdleAudioSnapshot(audioState.mode);
    emitAudioEvent(idle);
    replyOk(idle);
    return;
  }

  replyErr("invalid_argument", `Unsupported audio-session action: ${String(action)}`);
}

function handleCall(id: string, verb: string, args: Record<string, unknown>): void {
  if (!activePort) return;
  const replyOk = (data: unknown) => activePort?.postMessage({ v: 2, op: "reply", id, ok: true, data });
  const replyErr = (code: string, text: string) =>
    activePort?.postMessage({ v: 2, op: "reply", id, ok: false, refusal: { code, text } });

  if (verb === "screen.route.patch") {
    const nextSection: SectionOption =
      args.section === "followups"
        ? "followups"
        : args.section === "new"
          ? "new"
          : args.section === "all"
            ? "all"
            : route.section;
    const nextView = args.view === "new" ? "new" : args.view === "list" ? "list" : route.view;
    const nextRecord =
      args.record_id === null
        ? null
        : typeof args.record_id === "string"
          ? args.record_id
          : route.record_id;
    route = {
      section: nextSection,
      view: nextRecord ? "list" : nextView,
      record_id: nextSection === "new" || nextView === "new" ? null : nextRecord,
      segment_id: null,
    };
    replyOk({ route: { ...route } });
    pushScreen();
    return;
  }

  const rows = dataset === "empty" ? [] : meetings;

  if (verb === "records.list") {
    const query = typeof args.query === "string" ? args.query : undefined;
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, args.limit)) : 50;
    const sorted = [...rows]
      .filter((r) => matchesQuery(r, query))
      .sort((a, b) => (b.profile.held_at ?? "").localeCompare(a.profile.held_at ?? ""));
    const cursorId = typeof args.cursor === "string" ? args.cursor : null;
    const startIdx = cursorId ? Math.max(0, sorted.findIndex((r) => r.id === cursorId) + 1) : 0;
    const slice = sorted.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < sorted.length;
    const nextCursor = hasMore && slice.length > 0 ? slice[slice.length - 1]!.id : null;
    replyOk({
      records: slice.map((r) => toWireRecord(r, false)),
      total: sorted.length,
      truncated: hasMore,
      next_cursor: nextCursor,
    });
    return;
  }

  if (verb === "records.show") {
    const recordId = typeof args.record_id === "string" ? args.record_id : "";
    const found = rows.find((r) => r.id === recordId);
    if (!found) {
      replyErr("not_found", `Meeting ${recordId} was not found.`);
      return;
    }
    replyOk({ record: toWireRecord(found, true) });
    return;
  }

  if (access !== "owner") {
    replyErr("forbidden", "This workspace view is read-only.");
    return;
  }

  if (verb === "records.create") {
    const recordId = typeof args.record_id === "string" ? args.record_id : "";
    const profile = args.profile as MeetingProfile | undefined;
    const provenance =
      args.consent_provenance && typeof args.consent_provenance === "object"
        ? (args.consent_provenance as Record<string, unknown>)
        : { method: "screen_form" };
    if (!recordId || !profile || typeof profile !== "object") {
      replyErr("invalid_argument", "Meeting record_id and profile are required.");
      return;
    }
    if (meetings.some((r) => r.id === recordId)) {
      replyErr("conflict", `Meeting ${recordId} already exists.`);
      return;
    }
    if (dataset === "empty") {
      dataset = "populated";
      ctrlDataset.value = "populated";
      meetings = [];
    }
    const rowDigest = syntheticDigest(++digestSeq);
    const created: SyntheticMeetingRow = {
      id: recordId,
      revision: 1,
      digest: rowDigest,
      profile: { ...profile, synthetic: true },
      history: [
        {
          revision: 1,
          operation: "create",
          actor: "user:preview-owner",
          at: Date.now(),
          digest: rowDigest,
          before: null,
          after: profile as unknown as Record<string, unknown>,
          provenance,
        },
      ],
    };
    meetings = [created, ...meetings];
    replyOk({ record: toWireRecord(created, true) });
    return;
  }

  if (verb === "records.update") {
    const recordId = typeof args.record_id === "string" ? args.record_id : "";
    const expectedRevision = typeof args.expected_revision === "number" ? args.expected_revision : -1;
    const patch = (args.profile ?? {}) as Partial<MeetingProfile>;
    const provenance =
      args.consent_provenance && typeof args.consent_provenance === "object"
        ? (args.consent_provenance as Record<string, unknown>)
        : { method: "screen_form" };
    const idx = meetings.findIndex((r) => r.id === recordId);
    if (idx < 0) {
      replyErr("not_found", `Meeting ${recordId} was not found.`);
      return;
    }
    const existing = meetings[idx]!;
    if (existing.revision !== expectedRevision) {
      replyErr("stale_revision", "This meeting was updated elsewhere. Reload and try again.");
      return;
    }
    if (existing.profile.title_source === "user" && patch.title_source === "generated") {
      replyErr("validation_failed", "A user-set meeting title cannot be downgraded to generated.");
      return;
    }
    const nextRevision = existing.revision + 1;
    const rowDigest = syntheticDigest(++digestSeq);
    const mergedProfile: MeetingProfile = {
      ...existing.profile,
      ...patch,
    };
    const updated: SyntheticMeetingRow = {
      ...existing,
      revision: nextRevision,
      digest: rowDigest,
      profile: mergedProfile,
      history: [
        ...existing.history,
        {
          revision: nextRevision,
          operation: "update",
          actor: "user:preview-owner",
          at: Date.now(),
          digest: rowDigest,
          before: existing.profile as unknown as Record<string, unknown>,
          after: mergedProfile as unknown as Record<string, unknown>,
          provenance,
        },
      ],
    };
    meetings = meetings.map((item, i) => (i === idx ? updated : item));
    replyOk({ record: toWireRecord(updated, true) });
    return;
  }

  replyErr("unsupported_operation", `Unsupported preview verb: ${verb}`);
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data !== "object" || data.op !== "init") return;
  if (
    data.tag !== "minutes" ||
    data.bridge_nonce !== BRIDGE_NONCE ||
    data.generation !== generation ||
    !event.ports[0]
  ) {
    return;
  }
  stopAudioTimer();
  audioState = createIdleAudioSnapshot();
  if (activePort) {
    try {
      activePort.close();
    } catch {
      // ignore
    }
  }
  const port = event.ports[0];
  activePort = port;
  port.onmessage = (portEvent) => {
    const msg = portEvent.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.op === "ready") {
      pushScreen();
      return;
    }
    if (msg.op === "leave" && msg.v === 2 && typeof msg.unsaved === "boolean") {
      leaveIndicator.dataset.unsaved = msg.unsaved ? "true" : "false";
      leaveIndicator.textContent = msg.unsaved ? "Unsaved draft" : "Saved";
      return;
    }
    if (msg.op === "audio-session" && msg.v === 2 && typeof msg.id === "string") {
      handleAudioSession(msg.id, msg as Record<string, unknown>);
      return;
    }
    if (msg.op === "call" && typeof msg.id === "string" && typeof msg.verb === "string") {
      handleCall(msg.id, msg.verb, (msg.args ?? {}) as Record<string, unknown>);
    }
  };
  port.start();
});

function bootFrame(): void {
  stopAudioTimer();
  audioState = createIdleAudioSnapshot();
  generation += 1;
  leaveIndicator.dataset.unsaved = "false";
  leaveIndicator.textContent = "Saved";
  const url = new URL("./frame.html", window.location.href);
  url.searchParams.set("nonce", BRIDGE_NONCE);
  url.searchParams.set("gen", String(generation));
  url.searchParams.set("origin", window.location.origin);
  url.searchParams.set("theme", theme);
  frame.src = url.toString();
}

ctrlSection.addEventListener("change", () => {
  const val = ctrlSection.value;
  route = {
    section: val === "followups" ? "followups" : val === "new" ? "new" : "all",
    view: "list",
    record_id: null,
    segment_id: null,
  };
  pushScreen();
});

ctrlLocale.addEventListener("change", () => {
  locale = ctrlLocale.value === "zh-TW" ? "zh-TW" : "en";
  pushScreen();
});

ctrlTheme.addEventListener("change", () => {
  theme = ctrlTheme.value === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  frame.contentWindow?.postMessage({ type: "cadence-theme", theme }, window.location.origin);
});

ctrlAccess.addEventListener("change", () => {
  access = ctrlAccess.value === "viewer" ? "viewer" : "owner";
  pushScreen();
});

ctrlDataset.addEventListener("change", () => {
  dataset = ctrlDataset.value === "empty" ? "empty" : "populated";
  if (dataset === "populated" && meetings.length === 0) {
    meetings = createSeedMeetings();
  }
  route = { section: route.section, view: "list", record_id: null, segment_id: null };
  bootFrame();
});

ctrlViewport.addEventListener("change", () => {
  stage.dataset.viewport = ctrlViewport.value === "mobile" ? "mobile" : "desktop";
});

bootFrame();
