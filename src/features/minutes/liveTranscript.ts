import type { ScreenAudioMode, ScreenAudioSessionSnapshot } from "@cadence/app-kit";
import type { MinutesLocale } from "../../bridge/scope";

export const RECORD_SEGMENT_STRIDE_SECONDS = 10;
export const UPLOAD_SEGMENT_STRIDE_SECONDS = 45;

const LEADING_TIMESTAMP_RE = /^\s*(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s+\S/;
const CLOCK_VALUE_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;

export interface TranscriptSlot {
  index: number;
  startSeconds: number;
  status: "spoken" | "silent" | "failed" | "retrying";
  rawText: string;
}

export interface TranscriptTrackerState {
  sessionId: string;
  mode: ScreenAudioMode;
  slots: TranscriptSlot[];
  prevTotal: number;
  prevDone: number;
  prevFailed: number;
  prevSilent: number;
  prevRawTranscript: string;
  formattedTranscript: string;
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function parseClockToSeconds(clock: string | null | undefined): number | null {
  if (!clock) return null;
  const trimmed = clock.trim().replace(/^\[|\]$/g, "");
  const match = CLOCK_VALUE_RE.exec(trimmed);
  if (!match) return null;
  const hrs = match[1] ? Number(match[1]) : 0;
  const mins = Number(match[2]);
  const secs = Number(match[3]);
  if (!Number.isFinite(hrs) || !Number.isFinite(mins) || !Number.isFinite(secs)) return null;
  if (mins >= 60 || secs >= 60) return null;
  return hrs * 3600 + mins * 60 + secs;
}

export function formatHeldAtStartClock(
  heldAtIso: string | null | undefined,
  locale: MinutesLocale,
): string | null {
  if (!heldAtIso) return null;
  const parsed = new Date(heldAtIso);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale === "zh-HK" ? "zh-HK" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
  } catch {
    return null;
  }
}

export function formatWallClockAtOffset(
  heldAtIso: string | null | undefined,
  timestampLabel: string | null | undefined,
  locale: MinutesLocale,
): string | null {
  if (!heldAtIso || !timestampLabel) return null;
  const baseMs = Date.parse(heldAtIso);
  if (Number.isNaN(baseMs)) return null;
  const offsetSec = parseClockToSeconds(timestampLabel);
  if (offsetSec === null) return null;
  const target = new Date(baseMs + offsetSec * 1000);
  try {
    return new Intl.DateTimeFormat(locale === "zh-HK" ? "zh-HK" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(target);
  } catch {
    return null;
  }
}

export function hasLeadingTimestamp(line: string): boolean {
  return LEADING_TIMESTAMP_RE.test(line);
}

export function stampSegmentText(rawText: string, offsetSeconds: number): string {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const badge = formatClock(offsetSeconds);
  return lines
    .map((line) => (hasLeadingTimestamp(line) ? line : `[${badge}] ${line}`))
    .join("\n");
}

export function computeSlotStartSeconds(
  slotIndex: number,
  mode: ScreenAudioMode,
  elapsedSeconds: number,
  segmentsTotal: number,
): number {
  if (slotIndex <= 0) return 0;
  const stride =
    mode === "upload" ? UPLOAD_SEGMENT_STRIDE_SECONDS : RECORD_SEGMENT_STRIDE_SECONDS;
  const nominal = slotIndex * stride;
  const safeElapsed = Math.max(0, Math.floor(elapsedSeconds || 0));
  if (safeElapsed > 0 && nominal > safeElapsed) {
    const denom = Math.max(slotIndex + 1, Math.floor(segmentsTotal || 0));
    const scaled = Math.floor((safeElapsed * slotIndex) / denom);
    return Math.min(nominal, Math.max(0, scaled));
  }
  return nominal;
}

export function createInitialTrackerState(
  sessionId = "",
  mode: ScreenAudioMode = "record",
): TranscriptTrackerState {
  return {
    sessionId,
    mode,
    slots: [],
    prevTotal: 0,
    prevDone: 0,
    prevFailed: 0,
    prevSilent: 0,
    prevRawTranscript: "",
    formattedTranscript: "",
  };
}

function extractAddedSpokenSlice(
  fullTranscript: string,
  prefixTexts: string[],
  suffixTexts: string[],
): string {
  let working = fullTranscript;
  const prefix = prefixTexts.join("\n");
  if (prefix.length > 0) {
    if (working === prefix) {
      working = "";
    } else if (working.startsWith(`${prefix}\n`)) {
      working = working.slice(prefix.length + 1);
    }
  }
  const suffix = suffixTexts.join("\n");
  if (suffix.length > 0) {
    if (working === suffix) {
      working = "";
    } else if (working.endsWith(`\n${suffix}`)) {
      working = working.slice(0, working.length - suffix.length - 1);
    }
  }
  return working.trim();
}

function fallbackStampLines(
  rawTranscript: string,
  mode: ScreenAudioMode,
  elapsedSeconds: number,
  segmentsTotal: number,
): string {
  const lines = rawTranscript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const totalSlots = Math.max(lines.length, segmentsTotal);
  return lines
    .map((line, idx) =>
      stampSegmentText(line, computeSlotStartSeconds(idx, mode, elapsedSeconds, totalSlots)),
    )
    .join("\n");
}

export function reconcileStreamingTranscript(
  prev: TranscriptTrackerState,
  snap: ScreenAudioSessionSnapshot,
): TranscriptTrackerState {
  if (!snap || !snap.session_id || snap.phase === "idle") {
    return createInitialTrackerState();
  }

  const base =
    prev.sessionId === snap.session_id && prev.mode === snap.mode
      ? prev
      : createInitialTrackerState(snap.session_id, snap.mode);

  const normalizedRaw = snap.transcript.trim();

  if (
    base.sessionId === snap.session_id &&
    base.prevTotal === snap.segments_total &&
    base.prevDone === snap.segments_done &&
    base.prevFailed === snap.segments_failed &&
    base.prevSilent === snap.no_speech_segments &&
    base.prevRawTranscript === normalizedRaw
  ) {
    return base;
  }

  const slots: TranscriptSlot[] = base.slots.map((slot) => ({ ...slot }));

  const countFailed = () => slots.filter((s) => s.status === "failed").length;

  // When `retry` flips failed segments back to queued/in-flight, mark them retrying in slot order.
  const existingFailed = countFailed();
  if (snap.segments_failed < existingFailed && snap.segments_done <= base.prevDone) {
    let toRequeue = existingFailed - snap.segments_failed;
    for (const slot of slots) {
      if (toRequeue <= 0) break;
      if (slot.status === "failed") {
        slot.status = "retrying";
        slot.rawText = "";
        toRequeue -= 1;
      }
    }
  }

  const deltaSilent = Math.max(0, snap.no_speech_segments - base.prevSilent);
  const deltaDone = Math.max(0, snap.segments_done - base.prevDone);
  const deltaSpoken = Math.max(0, deltaDone - deltaSilent);
  const deltaFailed = Math.max(0, snap.segments_failed - countFailed());

  const claimNextSlot = (): TranscriptSlot => {
    const retrying = slots.find((s) => s.status === "retrying");
    if (retrying) return retrying;
    const idx = slots.length;
    const created: TranscriptSlot = {
      index: idx,
      startSeconds: computeSlotStartSeconds(
        idx,
        snap.mode,
        snap.elapsed_seconds,
        snap.segments_total,
      ),
      status: "silent",
      rawText: "",
    };
    slots.push(created);
    return created;
  };

  for (let i = 0; i < deltaSilent; i += 1) {
    const slot = claimNextSlot();
    slot.status = "silent";
    slot.rawText = "";
  }

  if (deltaSpoken > 0) {
    const targetSlots: TranscriptSlot[] = [];
    for (let i = 0; i < deltaSpoken; i += 1) {
      const slot = claimNextSlot();
      slot.status = "spoken";
      slot.rawText = "";
      targetSlots.push(slot);
    }

    const firstIdx = targetSlots[0]!.index;
    const lastIdx = targetSlots[targetSlots.length - 1]!.index;
    const prefixTexts = slots
      .filter((s) => s.index < firstIdx && s.status === "spoken" && s.rawText.length > 0)
      .map((s) => s.rawText);
    const suffixTexts = slots
      .filter((s) => s.index > lastIdx && s.status === "spoken" && s.rawText.length > 0)
      .map((s) => s.rawText);

    const addedSlice = extractAddedSpokenSlice(normalizedRaw, prefixTexts, suffixTexts);
    if (targetSlots.length === 1) {
      targetSlots[0]!.rawText = addedSlice;
    } else {
      const pieces = addedSlice
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (let i = 0; i < targetSlots.length; i += 1) {
        if (i < targetSlots.length - 1) {
          targetSlots[i]!.rawText = pieces[i] ?? "";
        } else {
          targetSlots[i]!.rawText = pieces.slice(i).join("\n");
        }
      }
    }
  }

  for (let i = 0; i < deltaFailed; i += 1) {
    const slot = claimNextSlot();
    slot.status = "failed";
    slot.rawText = "";
  }

  let formattedTranscript = "";
  if (normalizedRaw.length > 0) {
    const spokenSlots = slots.filter((s) => s.status === "spoken" && s.rawText.length > 0);
    const reconstructedRaw = spokenSlots.map((s) => s.rawText).join("\n");
    if (reconstructedRaw === normalizedRaw) {
      formattedTranscript = spokenSlots
        .map((s) => stampSegmentText(s.rawText, s.startSeconds))
        .filter((s) => s.length > 0)
        .join("\n");
    } else {
      formattedTranscript = fallbackStampLines(
        normalizedRaw,
        snap.mode,
        snap.elapsed_seconds,
        snap.segments_total,
      );
    }
  }

  return {
    sessionId: snap.session_id,
    mode: snap.mode,
    slots,
    prevTotal: snap.segments_total,
    prevDone: snap.segments_done,
    prevFailed: snap.segments_failed,
    prevSilent: snap.no_speech_segments,
    prevRawTranscript: normalizedRaw,
    formattedTranscript,
  };
}
