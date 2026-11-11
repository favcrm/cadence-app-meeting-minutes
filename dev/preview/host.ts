import type { MeetingProfile } from "../../src/features/minutes/types";
import { createSeedMeetings, syntheticDigest, type SyntheticMeetingRow } from "./fixtures";

type LocaleOption = "en" | "zh-TW";
type ThemeOption = "dark" | "light";
type AccessOption = "owner" | "viewer";
type DatasetOption = "populated" | "empty";

interface RouteState {
  section: "all" | "followups";
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
let activePort: MessagePort | null = null;
let meetings: SyntheticMeetingRow[] = createSeedMeetings();
let route: RouteState = {
  section: "all",
  view: "list",
  record_id: null,
  segment_id: null,
};

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
    ? ["records.list", "records.show", "records.create", "records.update", "screen.route.patch"]
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
    installation: {
      install_id: INSTALL_ID,
      name: "meeting-minutes",
      title: "Meeting minutes",
      version: "0.3.0",
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

function handleCall(id: string, verb: string, args: Record<string, unknown>): void {
  if (!activePort) return;
  const replyOk = (data: unknown) => activePort?.postMessage({ v: 2, op: "reply", id, ok: true, data });
  const replyErr = (code: string, text: string) =>
    activePort?.postMessage({ v: 2, op: "reply", id, ok: false, refusal: { code, text } });

  if (verb === "screen.drawer.open" || verb === "screen.drawer.close") {
    replyOk({ ok: true });
    return;
  }

  if (verb === "screen.route.patch") {
    const nextSection =
      args.section === "followups" ? "followups" : args.section === "all" ? "all" : route.section;
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
      record_id: nextView === "new" ? null : nextRecord,
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
      port.postMessage({ v: 1, op: "surface", role: "primary", modal: false });
      pushScreen();
      return;
    }
    if (msg.op === "state" && typeof msg.data === "string") {
      try {
        const parsed = JSON.parse(msg.data) as { unsaved?: boolean };
        const unsaved = parsed.unsaved === true;
        leaveIndicator.dataset.unsaved = unsaved ? "true" : "false";
        leaveIndicator.textContent = unsaved ? "Unsaved draft" : "Saved";
      } catch {
        // ignore
      }
      return;
    }
    if (msg.op === "call" && typeof msg.id === "string" && typeof msg.verb === "string") {
      handleCall(msg.id, msg.verb, (msg.args ?? {}) as Record<string, unknown>);
    }
  };
  port.start();
});

function bootFrame(): void {
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
  route = {
    section: ctrlSection.value === "followups" ? "followups" : "all",
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
