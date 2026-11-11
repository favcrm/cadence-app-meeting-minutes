import { ApiError, Button, ErrorNotice, Field, Notice, Select } from "@cadence/screen-ui";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { channel, useSurface } from "../../bridge/channel";
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
    const { tags } = normalizeTags(tagsRaw);
    const parsedMins = Number(durationMinutes.trim());
    const durationSeconds =
      durationMinutes.trim() && Number.isFinite(parsedMins) && parsedMins > 0
        ? Math.round(parsedMins * 60)
        : null;
    const heldAt = heldAtInput.trim() ? heldAtInput.trim().slice(0, 40) : null;
    const cleanDecisions: DecisionItem[] = decisions
      .filter((d) => d.text.trim().length > 0)
      .map((d) => ({
        id: d.id,
        text: d.text.trim().slice(0, 1000),
        quote: d.quote.trim() ? d.quote.trim().slice(0, 1000) : null,
        timestamp: d.timestamp.trim() ? d.timestamp.trim().slice(0, 32) : null,
      }));
    const cleanFollowups: FollowupItem[] = followups
      .filter((f) => f.task.trim().length > 0)
      .map((f) => ({
        id: f.id,
        task: f.task.trim().slice(0, 1000),
        owner: f.owner.trim() ? f.owner.trim().slice(0, 120) : null,
        due: f.due.trim() ? f.due.trim().slice(0, 40) : null,
        status: f.status,
      }));

    const profile: MeetingProfile = {
      schema: 1,
      title,
      title_source: titleSource,
      held_at: heldAt,
      duration_seconds: durationSeconds,
      status,
      participants,
      participants_text: participantsText,
      tags,
      summary: summary.trim().slice(0, 8000),
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
    decisions,
    durationMinutes,
    followups,
    heldAtInput,
    participantsRaw,
    record,
    status,
    summary,
    tagsRaw,
    transcript,
    typedTitle,
  ]);

  const overWireCap = candidateArgs.bytes > SCREEN_SERVICE_ARGS_BYTES;

  const statusOptions = useMemo(
    () => [
      { value: "draft", label: t("statusDraft") },
      { value: "reviewed", label: t("statusReviewed") },
      { value: "archived", label: t("statusArchived") },
    ],
    [t],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setSubmitError(null);
    setTagsError(null);

    const { invalidTags } = normalizeTags(tagsRaw);
    if (invalidTags.length > 0) {
      setTagsError(t("fieldTagsError", { tags: invalidTags.join(", ") }));
      return;
    }

    const hasContent = Boolean(
      typedTitle.trim() ||
        transcript.trim() ||
        summary.trim() ||
        candidateArgs.profile.decisions.length > 0 ||
        candidateArgs.profile.followups.length > 0,
    );
    if (!hasContent && !isEdit) {
      setSubmitError(t("formEmptyContentError"));
      return;
    }

    if (overWireCap) {
      setSubmitError(
        t("wireBudgetExceeded", {
          used: candidateArgs.bytes,
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
              isEdit && !userTitleLocked ? record.profile.title : t("fieldTitlePlaceholder")
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

      <Field
        label={t("fieldTranscriptLabel")}
        hint={t("fieldTranscriptHint")}
        error={
          overWireCap
            ? t("wireBudgetExceeded", { used: candidateArgs.bytes })
            : undefined
        }
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

      <div className="mm-wire-meter num" data-over={overWireCap ? "true" : undefined}>
        {t("wireBudgetUsage", { used: candidateArgs.bytes, max: SCREEN_SERVICE_ARGS_BYTES })}
      </div>

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
        title: t("newMinutes"),
        body: formNode,
        saveLabel: t("createMinutes"),
        pending,
        onCancel: onClose,
      }}
      onClose={onClose}
    />
  );
}
