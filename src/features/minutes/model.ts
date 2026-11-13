import { ApiError } from "@cadence/screen-ui";
import type {
  DecisionItem,
  FollowupItem,
  FollowupStatus,
  JournalEntry,
  MeetingListResult,
  MeetingProfile,
  MeetingRecord,
  MeetingStatus,
  TitleSource,
  TranscriptLine,
} from "./types";

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const isDigest = (v: unknown): v is string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);

function invalidReceipt(reason: string): never {
  throw new ApiError(`Invalid meeting record receipt (${reason})`, 502);
}

function assertObj(v: unknown, reason: string): asserts v is Record<string, unknown> {
  if (!isObj(v)) invalidReceipt(reason);
}
function assertId(v: unknown, reason: string): asserts v is string {
  if (!isId(v)) invalidReceipt(reason);
}
function assertDigest(v: unknown, reason: string): asserts v is string {
  if (!isDigest(v)) invalidReceipt(reason);
}

export const UNTITLED_MEETING = "Untitled meeting";

export function createMeetingId(): string {
  const stamp = Date.now().toString(36).toLowerCase();
  const suffix = Math.random().toString(36).slice(2, 8).toLowerCase() || "0001";
  return `mtg-${stamp}-${suffix}`.slice(0, 48);
}

export function createSubItemId(prefix: "dec" | "fup", index: number): string {
  const suffix = Math.random().toString(36).slice(2, 6).toLowerCase() || "01";
  return `${prefix}-${index + 1}-${suffix}`;
}

const TIMESTAMP_PREFIX = /^\s*(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s+(.*)$/;
const SPEAKER_PREFIX = /^([A-Za-z0-9\u4e00-\u9fff .,'()-]{1,40})(?::\s+|：\s*)(.+)$/;

export function parseTranscriptLines(transcript: string): TranscriptLine[] {
  const rawLines = transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return rawLines.map((line) => {
    let timestamp: string | null = null;
    let body = line;
    const tsMatch = TIMESTAMP_PREFIX.exec(body);
    if (tsMatch) {
      timestamp = tsMatch[1] ?? null;
      body = (tsMatch[2] ?? "").trim();
    }
    let speaker: string | null = null;
    const spMatch = SPEAKER_PREFIX.exec(body);
    if (spMatch && spMatch[1] && spMatch[2]) {
      speaker = spMatch[1].trim();
      body = spMatch[2].trim();
    }
    return { timestamp, speaker, text: body };
  });
}

/**
 * Derive a short factual heading from words actually present in the discussion
 * when the operator left the title blank. Never invents topics outside the text.
 */
export function deriveGeneratedTitle(transcript: string, fallback = UNTITLED_MEETING): string {
  const lines = parseTranscriptLines(transcript);
  for (const line of lines) {
    const cleaned = line.text
      .replace(/^[-*•#>\s]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length < 4) continue;
    const firstClause = cleaned.split(/[.!?。！？；;]/)[0]?.trim() ?? cleaned;
    const candidate = firstClause.length >= 4 ? firstClause : cleaned;
    if (candidate.length <= 72) return candidate;
    const clipped = candidate.slice(0, 72);
    const lastSpace = clipped.lastIndexOf(" ");
    return (lastSpace >= 24 ? clipped.slice(0, lastSpace) : clipped).trim() + "…";
  }
  return fallback;
}

export function resolveTitleSubmission(input: {
  typedTitle: string;
  transcript: string;
  existingTitle?: string;
  existingTitleSource?: TitleSource;
}): { title: string; titleSource: TitleSource } {
  const trimmed = input.typedTitle.replace(/\s+/g, " ").trim();
  if (trimmed.length > 0) {
    return {
      title: trimmed.slice(0, 200),
      titleSource: "user",
    };
  }
  if (input.existingTitleSource === "user" && input.existingTitle) {
    return {
      title: input.existingTitle.slice(0, 200),
      titleSource: "user",
    };
  }
  return {
    title: deriveGeneratedTitle(input.transcript, UNTITLED_MEETING).slice(0, 200),
    titleSource: "generated",
  };
}

export function normalizeParticipants(raw: string): {
  participants: string[];
  participantsText: string;
} {
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const token of raw.split(/[,\n，、;；]+/)) {
    const name = token.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    participants.push(name);
    if (participants.length >= 50) break;
  }
  return {
    participants,
    participantsText: participants.join(", ").slice(0, 1000),
  };
}

export function normalizeTags(raw: string): { tags: string[]; invalidTags: string[] } {
  const seen = new Set<string>();
  const tags: string[] = [];
  const invalidTags: string[] = [];
  for (const token of raw.split(/[,\s，、]+/)) {
    const trimmed = token.trim().replace(/^#/, "");
    if (!trimmed) continue;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(trimmed)) {
      invalidTags.push(trimmed);
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    tags.push(lower);
    if (tags.length >= 16) break;
  }
  return { tags, invalidTags };
}

function parseDecision(raw: unknown, idx: number): DecisionItem {
  assertObj(raw, `decisions[${idx}]`);
  const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `dec-${idx + 1}`;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) invalidReceipt(`decisions[${idx}].text`);
  const quote = typeof raw.quote === "string" && raw.quote.trim() ? raw.quote.trim() : null;
  const timestamp =
    typeof raw.timestamp === "string" && raw.timestamp.trim() ? raw.timestamp.trim() : null;
  return { id, text, quote, timestamp };
}

function parseFollowup(raw: unknown, idx: number): FollowupItem {
  assertObj(raw, `followups[${idx}]`);
  const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `fup-${idx + 1}`;
  const task = typeof raw.task === "string" ? raw.task.trim() : "";
  if (!task) invalidReceipt(`followups[${idx}].task`);
  const owner = typeof raw.owner === "string" && raw.owner.trim() ? raw.owner.trim() : null;
  const due = typeof raw.due === "string" && raw.due.trim() ? raw.due.trim() : null;
  const status: FollowupStatus =
    raw.status === "done" ? "done" : raw.status === "open" ? "open" : invalidReceipt(`followups[${idx}].status`);
  return { id, task, owner, due, status };
}

function parseProfile(raw: unknown): MeetingProfile {
  assertObj(raw, "profile");
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : UNTITLED_MEETING;
  const titleSource: TitleSource =
    raw.title_source === "user"
      ? "user"
      : raw.title_source === "generated" || raw.title_source === undefined
        ? "generated"
        : invalidReceipt("title_source");
  const status: MeetingStatus =
    raw.status === "draft" || raw.status === "reviewed" || raw.status === "archived"
      ? raw.status
      : raw.status === undefined
        ? "draft"
        : invalidReceipt("status");
  const heldAt = typeof raw.held_at === "string" && raw.held_at.trim() ? raw.held_at.trim() : null;
  const durationSeconds =
    typeof raw.duration_seconds === "number" &&
    Number.isFinite(raw.duration_seconds) &&
    raw.duration_seconds >= 0
      ? Math.round(raw.duration_seconds)
      : null;
  const participants = Array.isArray(raw.participants)
    ? raw.participants.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];
  const participantsText =
    typeof raw.participants_text === "string"
      ? raw.participants_text
      : participants.join(", ");
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  const decisions = Array.isArray(raw.decisions) ? raw.decisions.map(parseDecision) : [];
  const followups = Array.isArray(raw.followups) ? raw.followups.map(parseFollowup) : [];
  const transcript = typeof raw.transcript === "string" ? raw.transcript : "";
  const synthetic = raw.synthetic === true;
  return {
    schema: 1,
    title,
    title_source: titleSource,
    held_at: heldAt,
    duration_seconds: durationSeconds,
    status,
    participants,
    participants_text: participantsText,
    tags,
    summary,
    decisions,
    followups,
    transcript,
    synthetic,
  };
}

function parseJournalEntry(raw: unknown, idx: number): JournalEntry {
  assertObj(raw, `history[${idx}]`);
  const revision = raw.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    invalidReceipt(`history[${idx}].revision`);
  }
  const operation = raw.operation;
  if (operation !== "create" && operation !== "update") {
    invalidReceipt(`history[${idx}].operation`);
  }
  const actor = raw.actor;
  if (typeof actor !== "string" || !actor) invalidReceipt(`history[${idx}].actor`);
  const at = raw.at;
  if (typeof at !== "number" || !Number.isFinite(at)) invalidReceipt(`history[${idx}].at`);
  const digest = raw.digest;
  assertDigest(digest, `history[${idx}].digest`);
  if (raw.before !== null && !isObj(raw.before)) invalidReceipt(`history[${idx}].before`);
  const after = raw.after;
  assertObj(after, `history[${idx}].after`);
  if (raw.provenance !== null && raw.provenance !== undefined && !isObj(raw.provenance)) {
    invalidReceipt(`history[${idx}].provenance`);
  }
  return {
    revision,
    operation,
    actor,
    at,
    digest,
    before: (raw.before as Record<string, unknown> | null) ?? null,
    after,
    provenance: (raw.provenance as Record<string, unknown> | null) ?? null,
  };
}

export function parseMeetingRecord(raw: unknown): MeetingRecord {
  assertObj(raw, "record");
  const id = raw.id;
  assertId(id, "id");
  const installId = raw.install_id;
  assertId(installId, "install_id");
  const contextId = raw.context_id;
  if (typeof contextId !== "string") invalidReceipt("context_id");
  if (raw.kind !== "meeting") invalidReceipt("kind");
  const revision = raw.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    invalidReceipt("revision");
  }
  const digest = raw.digest;
  assertDigest(digest, "digest");
  const history = Array.isArray(raw.history) ? raw.history.map(parseJournalEntry) : [];
  return {
    id,
    installId,
    contextId,
    revision,
    digest,
    profile: parseProfile(raw.profile),
    history,
    historyTruncated: raw.history_truncated === true,
  };
}

export function parseMeetingListResponse(raw: unknown): MeetingListResult {
  assertObj(raw, "records.list");
  if (!Array.isArray(raw.records)) invalidReceipt("records.list.records");
  const total = raw.total;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    invalidReceipt("records.list.total");
  }
  const nextCursor =
    raw.next_cursor === null || raw.next_cursor === undefined
      ? null
      : isId(raw.next_cursor)
        ? raw.next_cursor
        : invalidReceipt("records.list.next_cursor");
  return {
    records: raw.records.map(parseMeetingRecord),
    total,
    truncated: raw.truncated === true,
    nextCursor,
  };
}

export function parseMeetingShowResponse(raw: unknown): MeetingRecord {
  assertObj(raw, "records.show");
  assertObj(raw.record, "records.show.record");
  return parseMeetingRecord(raw.record);
}

export function formatHeldAt(heldAt: string | null, locale: "en" | "zh-HK"): string {
  if (!heldAt) return locale === "zh-HK" ? "未設定日期" : "Date not set";
  const parsed = new Date(heldAt);
  if (Number.isNaN(parsed.getTime())) return heldAt;
  try {
    return new Intl.DateTimeFormat(locale === "zh-HK" ? "zh-HK" : "en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
  } catch {
    return heldAt;
  }
}

export function formatDuration(seconds: number | null, locale: "en" | "zh-HK"): string | null {
  if (seconds === null || seconds <= 0) return null;
  const mins = Math.max(1, Math.round(seconds / 60));
  return locale === "zh-HK" ? `${mins} 分鐘` : `${mins} min`;
}

export function formatUnixSeconds(atSeconds: number, locale: "en" | "zh-HK"): string {
  const parsed = new Date(atSeconds * 1000);
  if (Number.isNaN(parsed.getTime())) return String(atSeconds);
  try {
    return new Intl.DateTimeFormat(locale === "zh-HK" ? "zh-HK" : "en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
  } catch {
    return parsed.toISOString();
  }
}

export function toDatetimeLocalValue(heldAt: string | null): string {
  if (!heldAt) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(heldAt)) return heldAt.slice(0, 16);
  const parsed = new Date(heldAt);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}
