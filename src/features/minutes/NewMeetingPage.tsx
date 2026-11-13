import {
  MAX_AUDIO_UPLOAD_BYTES,
  type ScreenAudioLanguage,
  type ScreenAudioSessionPhase,
  type ScreenAudioSessionSnapshot,
} from "@cadence/app-kit";
import { ApiError, Button, ErrorNotice, Field, Notice, Select } from "@cadence/screen-ui";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { channel, useAudioSession, useCanAudioCapture } from "../../bridge/channel";
import type { DisplayScope } from "../../bridge/scope";
import {
  measureArgsBytes,
  SCREEN_SERVICE_ARGS_BYTES,
  serviceCall,
} from "../../bridge/services";
import { useMinutesText } from "./i18n";
import {
  createInitialTrackerState,
  formatClock,
  formatHeldAtStartClock,
  formatWallClockAtOffset,
  reconcileStreamingTranscript,
  UPLOAD_SEGMENT_STRIDE_SECONDS,
  type TranscriptTrackerState,
} from "./liveTranscript";
import {
  createMeetingId,
  normalizeParticipants,
  parseMeetingShowResponse,
  parseTranscriptLines,
  resolveTitleSubmission,
} from "./model";
import type { MeetingProfile, MeetingRecord } from "./types";

type CaptureMode = "record" | "upload" | "paste";
type LanguageChoice = "auto" | "zh" | "en";

const VOICE_BAR_COUNT = 28;
const WIRE_METER_WARN_BYTES = Math.floor(SCREEN_SERVICE_ARGS_BYTES * 0.85);

function isBusyAudioPhase(phase: ScreenAudioSessionPhase | undefined): boolean {
  return (
    phase === "starting" ||
    phase === "recording" ||
    phase === "paused" ||
    phase === "stopping" ||
    phase === "transcribing"
  );
}

function MicIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function VoiceLevelMeter({
  level,
  peak,
  active,
  label,
}: {
  level: number;
  peak: number;
  active: boolean;
  label: string;
}) {
  const litCount = active ? Math.round((Math.min(100, Math.max(0, level)) / 100) * VOICE_BAR_COUNT) : 0;
  const peakIndex =
    active && peak > 0
      ? Math.min(VOICE_BAR_COUNT - 1, Math.max(0, Math.round((peak / 100) * VOICE_BAR_COUNT) - 1))
      : -1;

  return (
    <div
      className="mm-voice-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={active ? level : 0}
      data-active={active ? "true" : undefined}
    >
      {Array.from({ length: VOICE_BAR_COUNT }, (_, idx) => {
        const lit = idx < litCount;
        const isPeak = idx === peakIndex && peakIndex >= litCount;
        const zone = idx >= 24 ? "hot" : idx >= 19 ? "warm" : "ok";
        const baseHeight = 26 + Math.round((idx / (VOICE_BAR_COUNT - 1)) * 74);
        return (
          <span
            key={idx}
            className="mm-voice-bar"
            data-lit={lit ? "true" : undefined}
            data-peak={isPeak ? "true" : undefined}
            data-zone={zone}
            style={{ height: `${baseHeight}%` }}
          />
        );
      })}
    </div>
  );
}

export default function NewMeetingPage({
  scope,
  onBack,
  onCreated,
}: {
  scope: DisplayScope;
  onBack: () => void;
  onCreated: (created: MeetingRecord) => void;
}) {
  const { locale, t } = useMinutesText();
  const canAudioCapture = useCanAudioCapture();
  const audioSession = useAudioSession();

  const [mode, setMode] = useState<CaptureMode>(() => (canAudioCapture ? "record" : "paste"));
  const [userPickedMode, setUserPickedMode] = useState<boolean>(false);
  const [language, setLanguage] = useState<LanguageChoice>("auto");
  const wireLanguage: ScreenAudioLanguage = language === "auto" ? "" : language;

  const [createdAtIso] = useState<string>(() => new Date().toISOString());
  const [typedTitle, setTypedTitle] = useState<string>("");
  const [participantsRaw, setParticipantsRaw] = useState<string>("");
  const [transcript, setTranscript] = useState<string>("");
  const [transcriptEditedManually, setTranscriptEditedManually] = useState<boolean>(false);
  const [editingRawTranscript, setEditingRawTranscript] = useState<boolean>(false);
  const [capturedDurationSeconds, setCapturedDurationSeconds] = useState<number | null>(null);
  const [capturedHeldAt, setCapturedHeldAt] = useState<string | null>(null);
  const [lastCaptureSource, setLastCaptureSource] = useState<"recording" | "upload" | null>(null);

  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [commandPending, setCommandPending] = useState<boolean>(false);
  const [savePending, setSavePending] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const liveScrollRef = useRef<HTMLDivElement>(null);
  const trackerRef = useRef<TranscriptTrackerState>(createInitialTrackerState());
  const [stickToBottom, setStickToBottom] = useState<boolean>(true);

  const applyAudioSnapshot = (
    snap: ScreenAudioSessionSnapshot,
    options?: { allowOverwriteManual?: boolean },
  ): string => {
    const nextTracker = reconcileStreamingTranscript(trackerRef.current, snap);
    trackerRef.current = nextTracker;
    if (snap.held_at) {
      setCapturedHeldAt(snap.held_at.slice(0, 40));
    }
    if (snap.elapsed_seconds > 0) {
      setCapturedDurationSeconds(snap.elapsed_seconds);
    }
    setLastCaptureSource(snap.mode === "upload" ? "upload" : "recording");
    if (options?.allowOverwriteManual || !transcriptEditedManually) {
      setTranscript(nextTracker.formattedTranscript);
    }
    return nextTracker.formattedTranscript;
  };

  // Switch automatically to Live recording when audio_capture capability arrives before user interacts
  useEffect(() => {
    if (canAudioCapture && !userPickedMode && !transcript.trim() && mode === "paste") {
      setMode("record");
    } else if (
      !canAudioCapture &&
      (mode === "record" || mode === "upload") &&
      !isBusyAudioPhase(audioSession?.phase)
    ) {
      setMode("paste");
    }
  }, [audioSession?.phase, canAudioCapture, mode, transcript, userPickedMode]);

  // Synchronize streaming session transcript & segment timestamps into page state unless manually edited
  useEffect(() => {
    if (!audioSession || audioSession.phase === "idle") {
      trackerRef.current = createInitialTrackerState();
      return;
    }
    applyAudioSnapshot(audioSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSession, transcriptEditedManually]);

  // Auto-scroll live transcript box when new segments stream in
  useEffect(() => {
    if (!stickToBottom || !liveScrollRef.current) return;
    liveScrollRef.current.scrollTop = liveScrollRef.current.scrollHeight;
  }, [transcript, audioSession?.phase, audioSession?.segments_in_flight, stickToBottom]);

  // Clean up any finished/active inline session when leaving NewMeetingPage
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    return () => {
      const current = channel.getAudioSession();
      if (current && current.phase !== "idle") {
        void channel.audioSession(scopeRef.current, { action: "cancel" }).catch(() => undefined);
      }
    };
  }, []);

  const sessionPhase = audioSession?.phase ?? "idle";
  const audioBusy = isBusyAudioPhase(sessionPhase);

  const dirty = Boolean(
    audioBusy ||
      typedTitle.trim() ||
      participantsRaw.trim() ||
      transcript.trim(),
  );

  useEffect(() => {
    const leave = channel.ownMinutesLeaveState();
    leave?.publish(dirty);
    return () => {
      leave?.release();
    };
  }, [dirty]);

  const buildCandidateArgs = (override?: {
    transcriptText?: string;
    durationSeconds?: number | null;
    heldAt?: string | null;
  }) => {
    const finalTranscript = (override?.transcriptText ?? transcript).slice(0, 96000);
    const { title, titleSource } = resolveTitleSubmission({
      typedTitle,
      transcript: finalTranscript,
    });
    const { participants, participantsText } = normalizeParticipants(participantsRaw);
    const durationSeconds =
      override?.durationSeconds !== undefined ? override.durationSeconds : capturedDurationSeconds;
    const heldAt = ((override?.heldAt ?? capturedHeldAt) || createdAtIso).slice(0, 40);

    const profile: MeetingProfile = {
      schema: 1,
      title,
      title_source: titleSource,
      held_at: heldAt,
      duration_seconds: durationSeconds && durationSeconds > 0 ? durationSeconds : null,
      status: "draft",
      participants,
      participants_text: participantsText,
      tags: [],
      summary: "",
      decisions: [],
      followups: [],
      transcript: finalTranscript,
      synthetic: false,
    };

    const bytes = measureArgsBytes({
      record_id: "mtg-preview-00000000",
      profile,
      consent_provenance: { method: "screen_form" },
    });

    return { profile, bytes };
  };

  const candidateArgs = useMemo(
    () => buildCandidateArgs(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capturedDurationSeconds, capturedHeldAt, createdAtIso, participantsRaw, transcript, typedTitle],
  );

  const overWireCap = candidateArgs.bytes > SCREEN_SERVICE_ARGS_BYTES;
  const showWireMeter = candidateArgs.bytes >= WIRE_METER_WARN_BYTES;

  const persistMeeting = async (override?: {
    transcriptText?: string;
    durationSeconds?: number | null;
    heldAt?: string | null;
  }) => {
    const next = buildCandidateArgs(override);
    if (!next.profile.transcript.trim() && !typedTitle.trim()) {
      setSubmitError(t("createEmptyError"));
      return;
    }
    if (next.bytes > SCREEN_SERVICE_ARGS_BYTES) {
      setSubmitError(
        t("wireBudgetExceeded", {
          used: next.bytes,
          max: SCREEN_SERVICE_ARGS_BYTES,
        }),
      );
      return;
    }

    setSavePending(true);
    setSubmitError(null);
    try {
      const response = await serviceCall(scope, "records.create", {
        record_id: createMeetingId(),
        profile: next.profile,
        consent_provenance: { method: "screen_form" },
      });
      const created = parseMeetingShowResponse(response);
      onCreated(created);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Save refused");
    } finally {
      setSavePending(false);
    }
  };

  const handleStartRecording = async () => {
    if (commandPending || savePending) return;
    setSubmitError(null);
    setTranscriptEditedManually(false);
    setEditingRawTranscript(false);
    setStickToBottom(true);
    trackerRef.current = createInitialTrackerState();
    setCommandPending(true);
    try {
      const snap = await channel.audioSession(scope, { action: "start", language: wireLanguage });
      applyAudioSnapshot(snap, { allowOverwriteManual: true });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to start recording");
    } finally {
      setCommandPending(false);
    }
  };

  const handlePauseOrResume = async () => {
    if (commandPending || savePending) return;
    setSubmitError(null);
    setCommandPending(true);
    try {
      await channel.audioSession(scope, {
        action: sessionPhase === "paused" ? "resume" : "pause",
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to update recording state");
    } finally {
      setCommandPending(false);
    }
  };

  const handleStopAndReview = async () => {
    if (commandPending || savePending) return;
    setSubmitError(null);
    setCommandPending(true);
    try {
      const snap = await channel.audioSession(scope, { action: "stop" });
      applyAudioSnapshot(snap);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to stop recording");
    } finally {
      setCommandPending(false);
    }
  };

  const handleEndAndSave = async () => {
    if (commandPending || savePending) return;
    setSubmitError(null);
    setCommandPending(true);
    try {
      const snap = await channel.audioSession(scope, { action: "stop" });
      const stamped = applyAudioSnapshot(snap);
      const effectiveTranscript = transcriptEditedManually ? transcript : stamped;

      // If any segment failed or there is no transcript/title yet, stay on review state so nothing is lost
      if (snap.segments_failed > 0 || (!effectiveTranscript.trim() && !typedTitle.trim())) {
        if (!effectiveTranscript.trim() && !typedTitle.trim() && !snap.error) {
          setSubmitError(t("createEmptyError"));
        }
        return;
      }

      await persistMeeting({
        transcriptText: effectiveTranscript,
        durationSeconds: snap.elapsed_seconds > 0 ? snap.elapsed_seconds : null,
        heldAt: snap.held_at || createdAtIso,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to finish and save meeting");
    } finally {
      setCommandPending(false);
    }
  };

  const handleRetryFailedSegments = async () => {
    if (commandPending || savePending) return;
    setSubmitError(null);
    setTranscriptEditedManually(false);
    setCommandPending(true);
    try {
      const snap = await channel.audioSession(scope, { action: "retry" });
      applyAudioSnapshot(snap, { allowOverwriteManual: true });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Retry failed");
    } finally {
      setCommandPending(false);
    }
  };

  const handleDiscardSession = async () => {
    if (commandPending || savePending) return;
    setSubmitError(null);
    setCommandPending(true);
    try {
      await channel.audioSession(scope, { action: "cancel" });
      trackerRef.current = createInitialTrackerState();
      setTranscript("");
      setTranscriptEditedManually(false);
      setEditingRawTranscript(false);
      setCapturedDurationSeconds(null);
      setCapturedHeldAt(null);
      setLastCaptureSource(null);
      setSelectedFileName(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to reset session");
    } finally {
      setCommandPending(false);
    }
  };

  const handleUploadFile = async (file: File) => {
    if (commandPending || savePending) return;
    setSubmitError(null);
    if (file.size <= 0) {
      setSubmitError(t("uploadFileEmpty"));
      return;
    }
    if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
      setSubmitError(t("uploadFileTooLarge"));
      return;
    }
    setSelectedFileName(file.name);
    setTranscriptEditedManually(false);
    setEditingRawTranscript(false);
    setStickToBottom(true);
    trackerRef.current = createInitialTrackerState();
    setCommandPending(true);
    try {
      const bytes = await file.arrayBuffer();
      const snap = await channel.audioSession(scope, {
        action: "upload",
        bytes,
        mimeType: file.type || "audio/wav",
        fileName: file.name.slice(0, 256),
        ...(Number.isSafeInteger(file.lastModified) && file.lastModified >= 0
          ? { lastModified: file.lastModified }
          : {}),
        language: wireLanguage,
      });
      applyAudioSnapshot(snap, { allowOverwriteManual: true });
    } catch (error) {
      if (error instanceof ApiError) {
        setSubmitError(error.message);
      } else {
        setSubmitError(error instanceof Error ? error.message : "Audio upload failed");
      }
    } finally {
      setCommandPending(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleUploadFile(file);
  };

  const onDropFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (audioBusy || commandPending || savePending) return;
    const file = event.dataTransfer.files?.[0];
    if (file) void handleUploadFile(file);
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (audioBusy || commandPending || savePending) return;
    void persistMeeting();
  };

  const switchMode = (next: CaptureMode) => {
    if (audioBusy || commandPending || savePending) return;
    if ((next === "record" || next === "upload") && !canAudioCapture) return;
    setUserPickedMode(true);
    setSubmitError(null);
    setMode(next);
  };

  const languageOptions = useMemo(
    () => [
      { value: "auto", label: t("langAuto") },
      { value: "zh", label: t("langZh") },
      { value: "en", label: t("langEn") },
    ],
    [t],
  );

  const phaseBadgeLabel =
    sessionPhase === "starting"
      ? t("phaseStarting")
      : sessionPhase === "recording"
        ? t("phaseRecording")
        : sessionPhase === "paused"
          ? t("phasePaused")
          : sessionPhase === "stopping"
            ? t("phaseStopping")
            : sessionPhase === "transcribing"
              ? t("phaseTranscribing")
              : sessionPhase === "ready"
                ? t("phaseReady")
                : sessionPhase === "error"
                  ? t("phaseError")
                  : t("phaseIdle");

  const createHeadingPreview =
    typedTitle.trim() ||
    (transcript.trim() ? candidateArgs.profile.title : t("optionalSettingsAutoTitle"));
  const participantCount = candidateArgs.profile.participants.length;
  const participantsSummary =
    participantCount > 0
      ? t("optionalSettingsParticipantsCount", { count: participantCount })
      : t("optionalSettingsNoParticipants");

  const wireErrorText = overWireCap
    ? t("wireBudgetExceeded", {
        used: candidateArgs.bytes,
        max: SCREEN_SERVICE_ARGS_BYTES,
      })
    : undefined;

  const parsedLiveLines = useMemo(() => parseTranscriptLines(transcript), [transcript]);
  const activeOriginIso = audioSession?.held_at || capturedHeldAt || null;
  const startClockLabel = useMemo(
    () => formatHeldAtStartClock(activeOriginIso, locale),
    [activeOriginIso, locale],
  );
  const showRawTranscriptEditor =
    !audioBusy && (editingRawTranscript || Boolean(wireErrorText));

  const activeLiveOffsetSeconds =
    mode === "upload" || audioSession?.mode === "upload"
      ? audioSession && audioSession.elapsed_seconds > 0
        ? Math.min(
            audioSession.elapsed_seconds,
            (audioSession.segments_done ?? 0) * UPLOAD_SEGMENT_STRIDE_SECONDS,
          )
        : (audioSession?.segments_done ?? 0) * UPLOAD_SEGMENT_STRIDE_SECONDS
      : (audioSession?.elapsed_seconds ?? 0);
  const activeLiveClock = formatClock(activeLiveOffsetSeconds);
  const activeLiveWallClock = formatWallClockAtOffset(activeOriginIso, activeLiveClock, locale);
  const activeLiveStatusCopy =
    sessionPhase === "paused"
      ? t("liveTranscriptPaused")
      : sessionPhase === "transcribing" ||
          sessionPhase === "stopping" ||
          (audioSession?.segments_in_flight ?? 0) > 0
        ? t("liveTranscriptTranscribingSegment")
        : t("liveTranscriptWaiting");

  const liveTranscriptPanel = (
    <section className="card mm-live-transcript-card" aria-label={t("liveTranscriptHeading")}>
      <div className="mm-live-transcript-head">
        <div className="mm-live-transcript-title-group">
          <h2 className="mm-section-kicker">{t("liveTranscriptHeading")}</h2>
          {parsedLiveLines.length > 0 ? (
            <span className="mm-count-pill num">{parsedLiveLines.length}</span>
          ) : null}
          {startClockLabel ? (
            <span className="mm-live-clock-origin num">
              {t("liveTranscriptStartedAt", { time: startClockLabel })}
            </span>
          ) : null}
        </div>

        <div className="mm-live-transcript-actions">
          {audioBusy && !stickToBottom ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setStickToBottom(true);
                if (liveScrollRef.current) {
                  liveScrollRef.current.scrollTop = liveScrollRef.current.scrollHeight;
                }
              }}
            >
              {t("liveTranscriptJumpLatest")}
            </Button>
          ) : null}

          {!audioBusy && transcript.trim() ? (
            <Button
              id="mm-btn-toggle-transcript-edit"
              size="sm"
              variant="secondary"
              onClick={() => setEditingRawTranscript((prev) => !prev)}
            >
              {showRawTranscriptEditor
                ? t("liveTranscriptTimelineView")
                : t("liveTranscriptEditRaw")}
            </Button>
          ) : null}
        </div>
      </div>

      {showRawTranscriptEditor ? (
        <>
          <Field
            label={t("fieldTranscriptLabel")}
            hint={t("createTranscriptHint")}
            error={wireErrorText}
          >
            {(control) => (
              <textarea
                {...control}
                rows={10}
                className="field mm-mono-textarea mm-create-textarea"
                value={transcript}
                placeholder={t("fieldTranscriptPlaceholder")}
                onChange={(e) => {
                  setTranscriptEditedManually(true);
                  setTranscript(e.target.value);
                }}
              />
            )}
          </Field>

          {showWireMeter ? (
            <div className="mm-wire-meter num" data-over={overWireCap ? "true" : undefined}>
              {t("wireBudgetUsage", {
                used: candidateArgs.bytes,
                max: SCREEN_SERVICE_ARGS_BYTES,
              })}
            </div>
          ) : null}
        </>
      ) : (
        <div
          ref={liveScrollRef}
          className="mm-live-transcript-scroll"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 28;
            setStickToBottom(atBottom);
          }}
        >
          <ol className="mm-live-transcript-list">
            {parsedLiveLines.map((line, idx) => {
              const tsLabel = line.timestamp ?? "00:00";
              const wallClock = formatWallClockAtOffset(activeOriginIso, tsLabel, locale);
              return (
                <li key={idx} className="mm-live-transcript-row">
                  <span
                    className="mm-ts-pill mm-live-ts-pill num"
                    title={wallClock ? `${tsLabel} · ${wallClock}` : tsLabel}
                  >
                    {tsLabel}
                  </span>
                  <div className="mm-transcript-utterance">
                    {line.speaker ? (
                      <strong className="mm-transcript-speaker">{line.speaker}</strong>
                    ) : null}
                    <span className="mm-live-transcript-text">{line.text}</span>
                  </div>
                  {wallClock ? <span className="mm-ts-wall num">{wallClock}</span> : null}
                </li>
              );
            })}

            {audioBusy ? (
              <li
                className="mm-live-transcript-row mm-live-transcript-row-active"
                data-phase={sessionPhase}
              >
                <span className="mm-ts-pill mm-live-ts-pill mm-ts-pill-live num">
                  {activeLiveClock}
                </span>
                <div className="mm-live-active-copy">
                  <span
                    className="mm-live-pulse-dot"
                    data-paused={sessionPhase === "paused" ? "true" : undefined}
                    aria-hidden="true"
                  />
                  <span className="mm-muted-copy">{activeLiveStatusCopy}</span>
                </div>
                {activeLiveWallClock ? (
                  <span className="mm-ts-wall num">{activeLiveWallClock}</span>
                ) : null}
              </li>
            ) : null}
          </ol>
        </div>
      )}
    </section>
  );

  const optionalSettingsDrawerless = (
    <details className="mm-optional-settings">
      <summary className="mm-optional-summary">
        <span className="mm-optional-chevron" aria-hidden="true">
          ▸
        </span>
        <span className="mm-optional-summary-line">
          <strong className="mm-optional-summary-title">{createHeadingPreview}</strong>
          <span className="mm-optional-summary-meta">
            {" · "}
            {participantsSummary}
            {" — "}
            {t("optionalSettingsSuffix")}
          </span>
        </span>
      </summary>

      <div className="mm-optional-body">
        <div className="mm-form-grid-2">
          <Field label={t("fieldTitleLabel")} hint={t("fieldTitleHintCreate")}>
            {(control) => (
              <input
                {...control}
                type="text"
                className="field"
                maxLength={200}
                value={typedTitle}
                placeholder={t("fieldTitlePlaceholder")}
                onChange={(e) => setTypedTitle(e.target.value)}
              />
            )}
          </Field>

          <Field label={t("fieldParticipantsLabel")} hint={t("fieldParticipantsHint")}>
            {(control) => (
              <input
                {...control}
                type="text"
                className="field"
                value={participantsRaw}
                placeholder={t("fieldParticipantsPlaceholder")}
                onChange={(e) => setParticipantsRaw(e.target.value)}
              />
            )}
          </Field>
        </div>
      </div>
    </details>
  );

  const inlineContextFields = (
    <section className="card mm-inline-context-card" aria-label={t("inlineDetailsHeading")}>
      <h2 className="mm-section-kicker">{t("inlineDetailsHeading")}</h2>
      <div className="mm-form-grid-2">
        <Field label={t("fieldTitleLabel")} hint={t("fieldTitleHintCreate")}>
          {(control) => (
            <input
              {...control}
              type="text"
              className="field"
              maxLength={200}
              value={typedTitle}
              placeholder={t("fieldTitlePlaceholder")}
              onChange={(e) => setTypedTitle(e.target.value)}
            />
          )}
        </Field>

        <Field label={t("fieldParticipantsLabel")} hint={t("fieldParticipantsHint")}>
          {(control) => (
            <input
              {...control}
              type="text"
              className="field"
              value={participantsRaw}
              placeholder={t("fieldParticipantsPlaceholder")}
              onChange={(e) => setParticipantsRaw(e.target.value)}
            />
          )}
        </Field>
      </div>
    </section>
  );

  const sessionErrorText = audioSession?.error?.text ?? null;

  return (
    <section className="mm-page mm-new-page" aria-label={t("newPageTitle")}>
      <div className="mm-page-topbar">
        <button
          type="button"
          className="mm-back-link"
          disabled={commandPending || savePending}
          onClick={onBack}
        >
          <span aria-hidden="true">←</span>
          <span>{t("backToAllMeetings")}</span>
        </button>
      </div>

      <header className="mm-header">
        <div className="mm-header-titles">
          <h1 className="mm-title">{t("newPageTitle")}</h1>
          <p className="mm-subtitle">{t("newPageSubtitle")}</p>
        </div>
      </header>

      <div className="mm-new-grid">
        <div className="mm-new-main">
          <div className="mm-mode-tabs" role="tablist" aria-label={t("newPageTitle")}>
            <button
              id="mm-tab-mode-record"
              type="button"
              role="tab"
              className="mm-mode-tab"
              aria-selected={mode === "record"}
              data-active={mode === "record" ? "true" : undefined}
              disabled={!canAudioCapture || audioBusy || commandPending || savePending}
              onClick={() => switchMode("record")}
            >
              <MicIcon />
              <span>{t("modeLiveRecord")}</span>
            </button>
            <button
              id="mm-tab-mode-upload"
              type="button"
              role="tab"
              className="mm-mode-tab"
              aria-selected={mode === "upload"}
              data-active={mode === "upload" ? "true" : undefined}
              disabled={!canAudioCapture || audioBusy || commandPending || savePending}
              onClick={() => switchMode("upload")}
            >
              <UploadIcon />
              <span>{t("modeUploadAudio")}</span>
            </button>
            <button
              id="mm-tab-mode-paste"
              type="button"
              role="tab"
              className="mm-mode-tab"
              aria-selected={mode === "paste"}
              data-active={mode === "paste" ? "true" : undefined}
              disabled={audioBusy || commandPending || savePending}
              onClick={() => switchMode("paste")}
            >
              <span>{t("modePasteTranscript")}</span>
            </button>
          </div>

          {!canAudioCapture ? (
            <Notice state="audio-disabled">{t("audioDisabledNotice")}</Notice>
          ) : null}

          {submitError ? <ErrorNotice>{submitError}</ErrorNotice> : null}
          {sessionErrorText && sessionErrorText !== submitError ? (
            <ErrorNotice>{sessionErrorText}</ErrorNotice>
          ) : null}

          {mode === "record" && canAudioCapture ? (
            <form
              id="mm-create-form"
              className="mm-capture-stack"
              onSubmit={handleFormSubmit}
              noValidate
            >
              <div
                className="card mm-recorder-card"
                data-phase={sessionPhase}
                data-live={sessionPhase === "recording" ? "true" : undefined}
              >
                <div className="mm-recorder-head">
                  <div className="mm-recorder-status-group">
                    <span className="mm-live-pill" data-phase={sessionPhase}>
                      <span className="mm-live-dot" aria-hidden="true" />
                      <span>{phaseBadgeLabel}</span>
                    </span>
                    {capturedDurationSeconds !== null &&
                    !audioBusy &&
                    lastCaptureSource === "recording" ? (
                      <span className="mm-audio-captured-pill num">
                        {t("audioCapturedBadgeRecording", {
                          duration: formatClock(capturedDurationSeconds),
                        })}
                      </span>
                    ) : null}
                  </div>

                  <div className="mm-recorder-clock num" aria-live="off">
                    {formatClock(audioSession?.elapsed_seconds ?? capturedDurationSeconds ?? 0)}
                  </div>
                </div>

                <VoiceLevelMeter
                  level={audioSession?.level ?? 0}
                  peak={audioSession?.peak ?? 0}
                  active={sessionPhase === "recording"}
                  label={t("voiceMeterLabel")}
                />

                {sessionPhase === "idle" && !transcript.trim() ? (
                  <div className="mm-recorder-idle-row">
                    <div className="mm-lang-select-wrap">
                      <Select
                        value={language}
                        options={languageOptions}
                        onChange={(val) => setLanguage(val as LanguageChoice)}
                        aria-label={t("langLabel")}
                      />
                    </div>
                    <Button
                      id="mm-btn-start-recording"
                      variant="primary"
                      icon={<MicIcon />}
                      loading={commandPending}
                      disabled={savePending}
                      onClick={() => void handleStartRecording()}
                    >
                      {t("startRecordingCta")}
                    </Button>
                  </div>
                ) : audioBusy ? (
                  <>
                    <div className="mm-metrics-strip num">
                      <div className="mm-metric-cell">
                        <span className="mm-metric-label">{t("metricSegmentsDone")}</span>
                        <strong className="mm-metric-value">{audioSession?.segments_done ?? 0}</strong>
                      </div>
                      <div className="mm-metric-cell">
                        <span className="mm-metric-label">{t("metricInFlight")}</span>
                        <strong className="mm-metric-value">
                          {audioSession?.segments_in_flight ?? 0}
                        </strong>
                      </div>
                      <div className="mm-metric-cell">
                        <span className="mm-metric-label">{t("metricSilent")}</span>
                        <strong className="mm-metric-value">
                          {audioSession?.no_speech_segments ?? 0}
                        </strong>
                      </div>
                      <div className="mm-metric-cell">
                        <span className="mm-metric-label">{t("metricCharacters")}</span>
                        <strong className="mm-metric-value">{transcript.length}</strong>
                      </div>
                      <div
                        className="mm-metric-cell"
                        data-failed={(audioSession?.segments_failed ?? 0) > 0 ? "true" : undefined}
                      >
                        <span className="mm-metric-label">{t("metricFailed")}</span>
                        <strong className="mm-metric-value">
                          {audioSession?.segments_failed ?? 0}
                        </strong>
                      </div>
                    </div>

                    <div className="mm-recorder-controls">
                      {sessionPhase === "recording" || sessionPhase === "paused" ? (
                        <Button
                          id="mm-btn-pause-resume"
                          variant="secondary"
                          disabled={commandPending || savePending}
                          onClick={() => void handlePauseOrResume()}
                        >
                          {sessionPhase === "paused" ? t("resumeRecording") : t("pauseRecording")}
                        </Button>
                      ) : null}

                      {sessionPhase === "starting" ||
                      sessionPhase === "recording" ||
                      sessionPhase === "paused" ? (
                        <>
                          <Button
                            id="mm-btn-stop-review"
                            variant="secondary"
                            loading={commandPending && !savePending}
                            disabled={commandPending || savePending}
                            onClick={() => void handleStopAndReview()}
                          >
                            {t("stopAndReviewCta")}
                          </Button>
                          <Button
                            id="mm-btn-end-and-save"
                            variant="primary"
                            loading={commandPending || savePending}
                            onClick={() => void handleEndAndSave()}
                          >
                            {t("endAndSaveCta")}
                          </Button>
                        </>
                      ) : null}

                      <Button
                        variant="ghost"
                        disabled={commandPending || savePending}
                        onClick={() => void handleDiscardSession()}
                      >
                        {t("discardSessionAction")}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="mm-recorder-controls">
                    {(audioSession?.segments_failed ?? 0) > 0 ? (
                      <Button
                        id="mm-btn-retry-segments"
                        variant="secondary"
                        loading={commandPending}
                        disabled={savePending}
                        onClick={() => void handleRetryFailedSegments()}
                      >
                        {t("retryFailedSegmentsAction")}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      disabled={commandPending || savePending}
                      onClick={() => void handleDiscardSession()}
                    >
                      {t("newRecordingResetAction")}
                    </Button>
                    <Button
                      id="mm-btn-save-minutes"
                      variant="primary"
                      type="submit"
                      loading={savePending}
                      disabled={commandPending}
                    >
                      {t("createMinutes")}
                    </Button>
                  </div>
                )}
              </div>

              {sessionPhase === "idle" && !transcript.trim() ? (
                optionalSettingsDrawerless
              ) : (
                <>
                  {liveTranscriptPanel}
                  {inlineContextFields}
                </>
              )}
            </form>
          ) : mode === "upload" && canAudioCapture ? (
            <form
              id="mm-create-form"
              className="mm-capture-stack"
              onSubmit={handleFormSubmit}
              noValidate
            >
              <div
                className="card mm-upload-dropzone"
                data-drag={dragActive ? "true" : undefined}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!audioBusy && !commandPending) setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={onDropFile}
              >
                <input
                  ref={fileInputRef}
                  id="mm-audio-file-input"
                  type="file"
                  accept=".m4a,.mp3,.wav,.ogg,.opus,.webm,.aac,.flac,.3gp,.amr,audio/*"
                  hidden
                  onChange={onFileInputChange}
                />

                <div className="mm-upload-head">
                  <div className="mm-upload-icon-circle">
                    <UploadIcon />
                  </div>
                  <div className="mm-upload-copy">
                    <strong className="mm-upload-title">{t("uploadDropTitle")}</strong>
                    <p className="mm-upload-formats">{t("uploadDropFormats")}</p>
                  </div>
                  {selectedFileName ? (
                    <span className="mm-meta-pill mm-upload-file-pill">
                      {t("uploadSelectedFile", { name: selectedFileName })}
                    </span>
                  ) : null}
                </div>

                <div className="mm-upload-controls">
                  <div className="mm-lang-select-wrap">
                    <Select
                      value={language}
                      options={languageOptions}
                      onChange={(val) => setLanguage(val as LanguageChoice)}
                      aria-label={t("langLabel")}
                    />
                  </div>
                  <Button
                    id="mm-btn-choose-audio-file"
                    variant="primary"
                    icon={<UploadIcon />}
                    loading={audioBusy || commandPending}
                    disabled={audioBusy || commandPending || savePending}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t("uploadChooseFile")}
                  </Button>
                </div>

                {audioSession && audioSession.mode === "upload" && audioSession.segments_total > 0 ? (
                  <div className="mm-upload-progress-wrap">
                    <div className="mm-upload-progress-meta num">
                      <span>
                        {t("uploadProgressLabel", {
                          done: audioSession.segments_done,
                          total: audioSession.segments_total,
                        })}
                      </span>
                      {capturedDurationSeconds !== null ? (
                        <span className="mm-audio-captured-pill">
                          {t("audioCapturedBadgeUpload", {
                            duration: formatClock(capturedDurationSeconds),
                          })}
                        </span>
                      ) : null}
                    </div>
                    <div className="mm-progress-track">
                      <div
                        className="mm-progress-fill"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.round(
                              (audioSession.segments_done /
                                Math.max(1, audioSession.segments_total)) *
                                100,
                            ),
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              {audioBusy || transcript.trim() || (audioSession && audioSession.mode === "upload") ? (
                <>
                  {liveTranscriptPanel}
                  {optionalSettingsDrawerless}

                  <div className="mm-editor-footer">
                    {(audioSession?.segments_failed ?? 0) > 0 && !audioBusy ? (
                      <Button
                        id="mm-btn-retry-segments"
                        variant="secondary"
                        loading={commandPending}
                        disabled={savePending}
                        onClick={() => void handleRetryFailedSegments()}
                      >
                        {t("retryFailedSegmentsAction")}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      disabled={audioBusy || commandPending || savePending}
                      onClick={() => void handleDiscardSession()}
                    >
                      {t("discardSessionAction")}
                    </Button>
                    <Button
                      id="mm-btn-save-minutes"
                      variant="primary"
                      type="submit"
                      loading={savePending}
                      disabled={audioBusy || commandPending || !transcript.trim()}
                    >
                      {t("createMinutes")}
                    </Button>
                  </div>
                </>
              ) : (
                optionalSettingsDrawerless
              )}
            </form>
          ) : (
            <form
              id="mm-create-form"
              className="mm-capture-stack"
              onSubmit={handleFormSubmit}
              noValidate
            >
              <Field
                label={t("fieldTranscriptLabel")}
                hint={t("createTranscriptHint")}
                error={wireErrorText}
              >
                {(control) => (
                  <textarea
                    {...control}
                    rows={12}
                    autoFocus={!canAudioCapture}
                    className="field mm-mono-textarea mm-create-textarea"
                    value={transcript}
                    placeholder={t("fieldTranscriptPlaceholder")}
                    onChange={(e) => {
                      setTranscriptEditedManually(true);
                      setTranscript(e.target.value);
                    }}
                  />
                )}
              </Field>

              {showWireMeter ? (
                <div className="mm-wire-meter num" data-over={overWireCap ? "true" : undefined}>
                  {t("wireBudgetUsage", {
                    used: candidateArgs.bytes,
                    max: SCREEN_SERVICE_ARGS_BYTES,
                  })}
                </div>
              ) : null}

              {optionalSettingsDrawerless}

              <div className="mm-editor-footer">
                <Button variant="secondary" disabled={savePending} onClick={onBack}>
                  {t("cancelEdit")}
                </Button>
                <Button
                  id="mm-btn-save-minutes"
                  variant="primary"
                  type="submit"
                  loading={savePending}
                >
                  {t("createMinutes")}
                </Button>
              </div>
            </form>
          )}
        </div>

        <aside className="card mm-workflow-rail" aria-label={t("workflowRailTitle")}>
          <h2 className="mm-section-kicker">{t("workflowRailTitle")}</h2>
          <ol className="mm-workflow-steps">
            <li className="mm-workflow-step" data-active={sessionPhase === "idle" ? "true" : undefined}>
              <strong className="mm-workflow-step-title">{t("workflowStep1Title")}</strong>
              <p className="mm-workflow-step-body">{t("workflowStep1Body")}</p>
            </li>
            <li className="mm-workflow-step" data-active={audioBusy ? "true" : undefined}>
              <strong className="mm-workflow-step-title">{t("workflowStep2Title")}</strong>
              <p className="mm-workflow-step-body">{t("workflowStep2Body")}</p>
            </li>
            <li
              className="mm-workflow-step"
              data-active={!audioBusy && Boolean(transcript.trim()) ? "true" : undefined}
            >
              <strong className="mm-workflow-step-title">{t("workflowStep3Title")}</strong>
              <p className="mm-workflow-step-body">{t("workflowStep3Body")}</p>
            </li>
          </ol>
        </aside>
      </div>
    </section>
  );
}
