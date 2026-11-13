import type { ScreenAudioMode } from "@cadence/app-kit";
import { ApiError, Button, ErrorNotice, Field, Notice, Select } from "@cadence/screen-ui";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { channel, useCanAudioCapture, useSurface } from "../../bridge/channel";
import type { DisplayScope } from "../../bridge/scope";
import {
  measureArgsBytes,
  SCREEN_SERVICE_ARGS_BYTES,
  serviceCall,
} from "../../bridge/services";
import FrameDrawer, { HostedDrawerSurface } from "./FrameDrawer";
import { useMinutesText } from "./i18n";
import {
  createMeetingId,
  createSubItemId,
  normalizeParticipants,
  normalizeTags,
  parseMeetingShowResponse,
  resolveTitleSubmission,
  toDatetimeLocalValue,
} from "./model";
import type {
  DecisionItem,
  FollowupItem,
  MeetingProfile,
  MeetingRecord,
  MeetingStatus,
} from "./types";

interface DraftDecision {
  id: string;
  text: string;
  quote: string;
  timestamp: string;
}

interface DraftFollowup {
  id: string;
  task: string;
  owner: string;
  due: string;
  status: "open" | "done";
}

export interface MeetingComposeFormProps {
  formId: string;
  scope: DisplayScope;
  record?: MeetingRecord | null;
  onSaved: (saved: MeetingRecord) => void;
  onPendingChange?: (pending: boolean) => void;
}

const WIRE_METER_WARN_BYTES = Math.floor(SCREEN_SERVICE_ARGS_BYTES * 0.85);

function formatAudioClock(totalSeconds: number): string {
  const clamped = Math.max(1, Math.round(totalSeconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function MicIcon() {
  return (
    <svg
      width="14"
      height="14"
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
      width="14"
      height="14"
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

export function MeetingComposeForm({
  formId,
  scope,
  record = null,
  onSaved,
  onPendingChange,
}: MeetingComposeFormProps) {
  const { t } = useMinutesText();
  const isEdit = !!record;
  const userTitleLocked = record?.profile.title_source === "user";

  const [createdAtIso] = useState<string>(() => new Date().toISOString());
  const [typedTitle, setTypedTitle] = useState<string>(() =>
    record ? (record.profile.title_source === "user" ? record.profile.title : "") : "",
  );
  const [participantsRaw, setParticipantsRaw] = useState<string>(() =>
    record ? record.profile.participants.join(", ") : "",
  );
  const [heldAtInput, setHeldAtInput] = useState<string>(() =>
    record ? toDatetimeLocalValue(record.profile.held_at) : "",
  );
  const [durationMinutes, setDurationMinutes] = useState<string>(() =>
    record?.profile.duration_seconds
      ? String(Math.max(1, Math.round(record.profile.duration_seconds / 60)))
      : "",
  );
  const [status, setStatus] = useState<MeetingStatus>(() => record?.profile.status ?? "draft");
  const [tagsRaw, setTagsRaw] = useState<string>(() =>
    record ? record.profile.tags.join(", ") : "",
  );
  const [transcript, setTranscript] = useState<string>(() => record?.profile.transcript ?? "");
  const [summary, setSummary] = useState<string>(() => record?.profile.summary ?? "");
  const [decisions, setDecisions] = useState<DraftDecision[]>(() =>
    record
      ? record.profile.decisions.map((d) => ({
          id: d.id,
          text: d.text,
          quote: d.quote ?? "",
          timestamp: d.timestamp ?? "",
        }))
      : [],
  );
  const [followups, setFollowups] = useState<DraftFollowup[]>(() =>
    record
      ? record.profile.followups.map((f) => ({
          id: f.id,
          task: f.task,
          owner: f.owner ?? "",
          due: f.due ?? "",
          status: f.status,
        }))
      : [],
  );

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canAudioCapture = useCanAudioCapture();
  const [audioBusyMode, setAudioBusyMode] = useState<ScreenAudioMode | null>(null);
  const [capturedDurationSeconds, setCapturedDurationSeconds] = useState<number | null>(null);
  const [capturedHeldAt, setCapturedHeldAt] = useState<string | null>(null);
  const [lastCaptureSource, setLastCaptureSource] = useState<"recording" | "upload" | null>(null);

  const dirty = useMemo(() => {
    if (!record) {
      return Boolean(
        typedTitle.trim() ||
          participantsRaw.trim() ||
          transcript.trim() ||
          summary.trim() ||
          decisions.length > 0 ||
          followups.length > 0,
      );
    }
    return true;
  }, [decisions.length, followups.length, participantsRaw, record, summary, transcript, typedTitle]);

  useEffect(() => {
    const leave = channel.ownMinutesLeaveState();
    leave?.publish(dirty);
    return () => {
      leave?.release();
    };
  }, [dirty]);

  const setBusy = (next: boolean) => {
    setPending(next);
    onPendingChange?.(next);
  };

  const candidateArgs = useMemo(() => {
    const { title, titleSource } = resolveTitleSubmission({
      typedTitle,
      transcript,
      existingTitle: record?.profile.title,
      existingTitleSource: record?.profile.title_source,
    });
    const { participants, participantsText } = normalizeParticipants(participantsRaw);
    const { tags } = isEdit ? normalizeTags(tagsRaw) : { tags: [] as string[] };
    const parsedMins = Number(durationMinutes.trim());
    const durationSeconds = isEdit
      ? durationMinutes.trim() && Number.isFinite(parsedMins) && parsedMins > 0
        ? Math.round(parsedMins * 60)
        : null
      : capturedDurationSeconds;
    const heldAt = isEdit
      ? heldAtInput.trim()
        ? heldAtInput.trim().slice(0, 40)
        : null
      : (capturedHeldAt ?? createdAtIso).slice(0, 40);
    const cleanDecisions: DecisionItem[] = isEdit
      ? decisions
          .filter((d) => d.text.trim().length > 0)
          .map((d) => ({
            id: d.id,
            text: d.text.trim().slice(0, 1000),
            quote: d.quote.trim() ? d.quote.trim().slice(0, 1000) : null,
            timestamp: d.timestamp.trim() ? d.timestamp.trim().slice(0, 32) : null,
          }))
      : [];
    const cleanFollowups: FollowupItem[] = isEdit
      ? followups
          .filter((f) => f.task.trim().length > 0)
          .map((f) => ({
            id: f.id,
            task: f.task.trim().slice(0, 1000),
            owner: f.owner.trim() ? f.owner.trim().slice(0, 120) : null,
            due: f.due.trim() ? f.due.trim().slice(0, 40) : null,
            status: f.status,
          }))
      : [];

    const profile: MeetingProfile = {
      schema: 1,
      title,
      title_source: titleSource,
      held_at: heldAt,
      duration_seconds: durationSeconds,
      status: isEdit ? status : "draft",
      participants,
      participants_text: participantsText,
      tags,
      summary: isEdit ? summary.trim().slice(0, 8000) : "",
      decisions: cleanDecisions,
      followups: cleanFollowups,
      transcript: transcript.slice(0, 96000),
      synthetic: record?.profile.synthetic ?? false,
    };

    const baseArgs: Record<string, unknown> = record
      ? {
          record_id: record.id,
          expected_revision: record.revision,
          profile,
          consent_provenance: { method: "screen_form" },
        }
      : {
          record_id: "mtg-preview-00000000",
          profile,
          consent_provenance: { method: "screen_form" },
        };

    return {
      profile,
      bytes: measureArgsBytes(baseArgs),
    };
  }, [
    capturedDurationSeconds,
    capturedHeldAt,
    createdAtIso,
    decisions,
    durationMinutes,
    followups,
    heldAtInput,
    isEdit,
    participantsRaw,
    record,
    status,
    summary,
    tagsRaw,
    transcript,
    typedTitle,
  ]);

  const overWireCap = candidateArgs.bytes > SCREEN_SERVICE_ARGS_BYTES;
  const showWireMeter = candidateArgs.bytes >= WIRE_METER_WARN_BYTES;

  const statusOptions = useMemo(
    () => [
      { value: "draft", label: t("statusDraft") },
      { value: "reviewed", label: t("statusReviewed") },
      { value: "archived", label: t("statusArchived") },
    ],
    [t],
  );

  const handleAudioCapture = async (mode: ScreenAudioMode) => {
    if (pending || audioBusyMode !== null) return;
    setSubmitError(null);
    setAudioBusyMode(mode);
    try {
      const res = await channel.audioCapture(scope, { mode });
      setTranscript((prev) =>
        prev.trim().length > 0 ? `${prev.trimEnd()}\n\n${res.transcript}` : res.transcript,
      );
      setCapturedDurationSeconds((prev) => (prev ?? 0) + res.duration_seconds);
      setCapturedHeldAt((prev) => prev ?? res.held_at.slice(0, 40));
      setLastCaptureSource(res.source);
      if (isEdit) {
        setDurationMinutes((prev) =>
          prev.trim() ? prev : String(Math.max(1, Math.round(res.duration_seconds / 60))),
        );
        setHeldAtInput((prev) => (prev.trim() ? prev : toDatetimeLocalValue(res.held_at)));
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "cancelled") {
        return;
      }
      setSubmitError(error instanceof Error ? error.message : "Audio capture failed");
    } finally {
      setAudioBusyMode(null);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || audioBusyMode !== null) return;
    setSubmitError(null);
    setTagsError(null);

    if (isEdit) {
      const { invalidTags } = normalizeTags(tagsRaw);
      if (invalidTags.length > 0) {
        setTagsError(t("fieldTagsError", { tags: invalidTags.join(", ") }));
        return;
      }
    } else if (!transcript.trim() && !typedTitle.trim()) {
      setSubmitError(t("createEmptyError"));
      return;
    }

    if (overWireCap) {
      setSubmitError(
        t("wireBudgetExceeded", {
          used: candidateArgs.bytes,
          max: SCREEN_SERVICE_ARGS_BYTES,
        }),
      );
      return;
    }

    setBusy(true);
    try {
      const response = record
        ? await serviceCall(scope, "records.update", {
            record_id: record.id,
            expected_revision: record.revision,
            profile: candidateArgs.profile,
            consent_provenance: { method: "screen_form" },
          })
        : await serviceCall(scope, "records.create", {
            record_id: createMeetingId(),
            profile: candidateArgs.profile,
            consent_provenance: { method: "screen_form" },
          });
      const saved = parseMeetingShowResponse(response);
      onSaved(saved);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setSubmitError(t("staleConflictError"));
      } else {
        setSubmitError(error instanceof Error ? error.message : "Save refused");
      }
    } finally {
      setBusy(false);
    }
  };

  const wireErrorText = overWireCap
    ? t("wireBudgetExceeded", {
        used: candidateArgs.bytes,
        max: SCREEN_SERVICE_ARGS_BYTES,
      })
    : undefined;

  const audioBar = canAudioCapture ? (
    <div className="mm-audio-bar" data-audio-bar="true">
      <div className="mm-audio-actions">
        <Button
          id="mm-btn-record-audio"
          variant={!isEdit && !transcript.trim() ? "primary" : "secondary"}
          icon={<MicIcon />}
          loading={audioBusyMode === "record"}
          disabled={pending || audioBusyMode !== null}
          onClick={() => {
            void handleAudioCapture("record");
          }}
        >
          {audioBusyMode === "record" ? t("audioCapturingRecord") : t("recordAudioAction")}
        </Button>
        <Button
          id="mm-btn-upload-audio"
          variant="secondary"
          icon={<UploadIcon />}
          loading={audioBusyMode === "upload"}
          disabled={pending || audioBusyMode !== null}
          onClick={() => {
            void handleAudioCapture("upload");
          }}
        >
          {audioBusyMode === "upload" ? t("audioCapturingUpload") : t("uploadAudioAction")}
        </Button>
      </div>
      <div className="mm-audio-meta-row">
        <p className="mm-audio-hint">{t("audioQuickHint")}</p>
        {capturedDurationSeconds !== null && lastCaptureSource !== null ? (
          <span className="mm-audio-captured-pill num" data-capture-source={lastCaptureSource}>
            {t(
              lastCaptureSource === "recording"
                ? "audioCapturedBadgeRecording"
                : "audioCapturedBadgeUpload",
              { duration: formatAudioClock(capturedDurationSeconds) },
            )}
          </span>
        ) : null}
      </div>
    </div>
  ) : null;

  if (!isEdit) {
    const createHeadingPreview =
      typedTitle.trim() ||
      (transcript.trim() ? candidateArgs.profile.title : t("optionalSettingsAutoTitle"));
    const participantCount = candidateArgs.profile.participants.length;
    const participantsSummary =
      participantCount > 0
        ? t("optionalSettingsParticipantsCount", { count: participantCount })
        : t("optionalSettingsNoParticipants");

    return (
      <form
        id={formId}
        className="mm-compose-form"
        onSubmit={(e) => void handleSubmit(e)}
        noValidate
      >
        {submitError ? <ErrorNotice>{submitError}</ErrorNotice> : null}

        {audioBar}

        <Field
          label={t("fieldTranscriptLabel")}
          hint={t("createTranscriptHint")}
          error={wireErrorText}
        >
          {(control) => (
            <textarea
              {...control}
              rows={10}
              autoFocus={!canAudioCapture}
              className="field mm-mono-textarea mm-create-textarea"
              value={transcript}
              placeholder={t("fieldTranscriptPlaceholder")}
              onChange={(e) => setTranscript(e.target.value)}
            />
          )}
        </Field>

        {showWireMeter ? (
          <div className="mm-wire-meter num" data-over={overWireCap ? "true" : undefined}>
            {t("wireBudgetUsage", { used: candidateArgs.bytes, max: SCREEN_SERVICE_ARGS_BYTES })}
          </div>
        ) : null}

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
        </details>
      </form>
    );
  }

  return (
    <form id={formId} className="mm-compose-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
      {submitError ? <ErrorNotice>{submitError}</ErrorNotice> : null}

      <Field
        label={t("fieldTitleLabel")}
        hint={userTitleLocked ? t("fieldTitleHintUserLocked") : t("fieldTitleHintCreate")}
      >
        {(control) => (
          <input
            {...control}
            type="text"
            className="field"
            maxLength={200}
            value={typedTitle}
            placeholder={
              !userTitleLocked ? record.profile.title : t("fieldTitlePlaceholder")
            }
            onChange={(e) => setTypedTitle(e.target.value)}
          />
        )}
      </Field>

      <div className="mm-form-grid-2">
        <Field label={t("fieldWhenLabel")}>
          {(control) => (
            <input
              {...control}
              type="datetime-local"
              className="field"
              value={heldAtInput}
              onChange={(e) => setHeldAtInput(e.target.value)}
            />
          )}
        </Field>

        <Field label={t("fieldDurationLabel")}>
          {(control) => (
            <input
              {...control}
              type="number"
              min={1}
              max={1440}
              className="field num"
              value={durationMinutes}
              placeholder={t("fieldDurationPlaceholder")}
              onChange={(e) => setDurationMinutes(e.target.value)}
            />
          )}
        </Field>
      </div>

      <div className="mm-form-grid-2">
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

        <Field label={t("fieldStatusLabel")}>
          {(control) => (
            <Select
              id={control.id}
              value={status}
              options={statusOptions}
              onChange={(val) => setStatus(val as MeetingStatus)}
              full
            />
          )}
        </Field>
      </div>

      <Field label={t("fieldTagsLabel")} hint={t("fieldTagsHint")} error={tagsError ?? undefined}>
        {(control) => (
          <input
            {...control}
            type="text"
            className="field"
            value={tagsRaw}
            placeholder={t("fieldTagsPlaceholder")}
            onChange={(e) => {
              setTagsRaw(e.target.value);
              if (tagsError) setTagsError(null);
            }}
          />
        )}
      </Field>

      {audioBar}

      <Field
        label={t("fieldTranscriptLabel")}
        hint={t("fieldTranscriptHint")}
        error={wireErrorText}
      >
        {(control) => (
          <textarea
            {...control}
            rows={6}
            className="field mm-mono-textarea"
            value={transcript}
            placeholder={t("fieldTranscriptPlaceholder")}
            onChange={(e) => setTranscript(e.target.value)}
          />
        )}
      </Field>

      {showWireMeter ? (
        <div className="mm-wire-meter num" data-over={overWireCap ? "true" : undefined}>
          {t("wireBudgetUsage", { used: candidateArgs.bytes, max: SCREEN_SERVICE_ARGS_BYTES })}
        </div>
      ) : null}

      <Notice className="mm-assistant-callout" state="assistant-hint">
        <strong>{t("assistantCalloutTitle")}:</strong> {t("assistantCalloutBody")}
      </Notice>

      <Field label={t("fieldSummaryLabel")}>
        {(control) => (
          <textarea
            {...control}
            rows={3}
            className="field"
            value={summary}
            placeholder={t("fieldSummaryPlaceholder")}
            onChange={(e) => setSummary(e.target.value)}
          />
        )}
      </Field>

      <section className="mm-subeditor" aria-label={t("decisionsEditorHeading")}>
        <div className="mm-subeditor-head">
          <h3 className="mm-section-kicker">{t("decisionsEditorHeading")}</h3>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setDecisions((prev) => [
                ...prev,
                {
                  id: createSubItemId("dec", prev.length),
                  text: "",
                  quote: "",
                  timestamp: "",
                },
              ])
            }
          >
            {t("addDecision")}
          </Button>
        </div>
        {decisions.map((item, idx) => (
          <div key={item.id} className="card mm-subeditor-card">
            <div className="mm-subeditor-row-top">
              <Field label={`${t("decisionTextLabel")} #${idx + 1}`}>
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    className="field"
                    value={item.text}
                    placeholder={t("decisionTextPlaceholder")}
                    onChange={(e) =>
                      setDecisions((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, text: e.target.value } : row)),
                      )
                    }
                  />
                )}
              </Field>
            </div>
            <div className="mm-form-grid-2">
              <Field label={t("decisionTimestampLabel")}>
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    className="field num"
                    value={item.timestamp}
                    placeholder={t("decisionTimestampPlaceholder")}
                    onChange={(e) =>
                      setDecisions((prev) =>
                        prev.map((row, i) =>
                          i === idx ? { ...row, timestamp: e.target.value } : row,
                        ),
                      )
                    }
                  />
                )}
              </Field>
              <Field label={t("decisionQuoteLabel")}>
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    className="field"
                    value={item.quote}
                    placeholder={t("decisionQuotePlaceholder")}
                    onChange={(e) =>
                      setDecisions((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, quote: e.target.value } : row)),
                      )
                    }
                  />
                )}
              </Field>
            </div>
            <div className="mm-subeditor-actions">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDecisions((prev) => prev.filter((_, i) => i !== idx))}
              >
                {t("removeItem")}
              </Button>
            </div>
          </div>
        ))}
      </section>

      <section className="mm-subeditor" aria-label={t("followupsEditorHeading")}>
        <div className="mm-subeditor-head">
          <div>
            <h3 className="mm-section-kicker">{t("followupsEditorHeading")}</h3>
            <p className="mm-subeditor-hint">{t("followupHonestyHint")}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setFollowups((prev) => [
                ...prev,
                {
                  id: createSubItemId("fup", prev.length),
                  task: "",
                  owner: "",
                  due: "",
                  status: "open",
                },
              ])
            }
          >
            {t("addFollowup")}
          </Button>
        </div>
        {followups.map((item, idx) => (
          <div key={item.id} className="card mm-subeditor-card">
            <Field label={`${t("followupTaskLabel")} #${idx + 1}`}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  className="field"
                  value={item.task}
                  placeholder={t("followupTaskPlaceholder")}
                  onChange={(e) =>
                    setFollowups((prev) =>
                      prev.map((row, i) => (i === idx ? { ...row, task: e.target.value } : row)),
                    )
                  }
                />
              )}
            </Field>
            <div className="mm-form-grid-2">
              <Field label={t("followupOwnerLabel")}>
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    className="field"
                    value={item.owner}
                    placeholder={t("followupOwnerPlaceholder")}
                    onChange={(e) =>
                      setFollowups((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, owner: e.target.value } : row)),
                      )
                    }
                  />
                )}
              </Field>
              <Field label={t("followupDueLabel")}>
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    className="field"
                    value={item.due}
                    placeholder={t("followupDuePlaceholder")}
                    onChange={(e) =>
                      setFollowups((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, due: e.target.value } : row)),
                      )
                    }
                  />
                )}
              </Field>
            </div>
            <div className="mm-subeditor-actions">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFollowups((prev) => prev.filter((_, i) => i !== idx))}
              >
                {t("removeItem")}
              </Button>
            </div>
          </div>
        ))}
      </section>
    </form>
  );
}

export default function MeetingComposeDrawer({
  scope,
  onClose,
  onCreated,
}: {
  scope: DisplayScope;
  onClose: () => void;
  onCreated: (created: MeetingRecord) => void;
}) {
  const { t } = useMinutesText();
  const surface = useSurface();
  const [pending, setPending] = useState(false);
  const formId = "mm-create-form";

  const formNode = (
    <MeetingComposeForm
      formId={formId}
      scope={scope}
      onSaved={onCreated}
      onPendingChange={setPending}
    />
  );

  if (surface.role === "drawer") {
    return (
      <HostedDrawerSurface
        title={t("newMinutes")}
        onClose={onClose}
        footer={
          <div className="mm-drawer-foot-row">
            <Button variant="secondary" onClick={onClose} disabled={pending}>
              {t("cancelEdit")}
            </Button>
            <Button variant="primary" type="submit" loading={pending} onClick={() => {
              const form = document.getElementById(formId);
              if (form instanceof HTMLFormElement) {
                form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
              }
            }}>
              {t("createMinutes")}
            </Button>
          </div>
        }
      >
        {formNode}
      </HostedDrawerSurface>
    );
  }

  return (
    <FrameDrawer
      kind={t("drawerKindCompose")}
      label={t("newMinutes")}
      title={t("newMinutes")}
      tabs={[]}
      edit={{
        formId,
        title: "",
        body: formNode,
        saveLabel: t("createMinutes"),
        pending,
        onCancel: onClose,
      }}
      onClose={onClose}
    />
  );
}
