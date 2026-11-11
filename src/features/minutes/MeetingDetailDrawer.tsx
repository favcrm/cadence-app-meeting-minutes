import {
  ApiError,
  Button,
  Detail,
  EmptyState,
  ErrorNotice,
  Field,
  IconCheck,
  Loading,
  Notice,
} from "@cadence/screen-ui";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSurface } from "../../bridge/channel";
import type { DisplayScope } from "../../bridge/scope";
import { serviceCall } from "../../bridge/services";
import FrameDrawer, { HostedDrawerSurface } from "./FrameDrawer";
import { useMinutesText } from "./i18n";
import { MeetingComposeForm } from "./MeetingComposeDrawer";
import {
  formatDuration,
  formatHeldAt,
  formatUnixSeconds,
  parseMeetingShowResponse,
  parseTranscriptLines,
} from "./model";
import type { MeetingRecord, MeetingStatus } from "./types";

export function TitleOriginBadge({ source }: { source: "user" | "generated" }) {
  const { t } = useMinutesText();
  return (
    <span className="mm-badge" data-origin={source}>
      {source === "user" ? t("badgeUserTitle") : t("badgeGeneratedTitle")}
    </span>
  );
}

export function MeetingStatusChip({ status }: { status: MeetingStatus }) {
  const { t } = useMinutesText();
  const label =
    status === "reviewed"
      ? t("statusReviewed")
      : status === "archived"
        ? t("statusArchived")
        : t("statusDraft");
  return (
    <span className="mm-status-chip" data-status={status}>
      {label}
    </span>
  );
}

export default function MeetingDetailDrawer({
  scope,
  recordId,
  initialRecord,
  canUpdate,
  onClose,
  onRecordUpdated,
}: {
  scope: DisplayScope;
  recordId: string;
  initialRecord: MeetingRecord | null;
  canUpdate: boolean;
  onClose: () => void;
  onRecordUpdated: (updated: MeetingRecord) => void;
}) {
  const { locale, t } = useMinutesText();
  const surface = useSurface();

  const [record, setRecord] = useState<MeetingRecord | null>(initialRecord);
  const [loading, setLoading] = useState<boolean>(!initialRecord);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("minutes");
  const [editing, setEditing] = useState<boolean>(false);
  const [editPending, setEditPending] = useState<boolean>(false);

  // Inline rename state
  const [renaming, setRenaming] = useState<boolean>(false);
  const [renameDraft, setRenameDraft] = useState<string>("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState<boolean>(false);

  // Follow-up toggle state
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Transcript filter
  const [transcriptFilter, setTranscriptFilter] = useState<string>("");

  const fetchFullRecord = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const raw = await serviceCall(scope, "records.show", { record_id: recordId });
      const loaded = parseMeetingShowResponse(raw);
      setRecord(loaded);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load meeting minutes");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setEditing(false);
    setRenaming(false);
    setActionError(null);
    setTranscriptFilter("");
    void fetchFullRecord();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, scope.installId, scope.digest]);

  const startRename = () => {
    if (!record || !canUpdate) return;
    setRenameDraft(record.profile.title);
    setRenameError(null);
    setRenaming(true);
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!record || renamePending) return;
    const nextTitle = renameDraft.replace(/\s+/g, " ").trim();
    if (!nextTitle) {
      setRenameError(t("renameEmptyError"));
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    try {
      const raw = await serviceCall(scope, "records.update", {
        record_id: record.id,
        expected_revision: record.revision,
        profile: {
          ...record.profile,
          title: nextTitle.slice(0, 200),
          title_source: "user",
        },
        consent_provenance: { method: "inline_rename" },
      });
      const updated = parseMeetingShowResponse(raw);
      setRecord(updated);
      setRenaming(false);
      onRecordUpdated(updated);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setRenameError(t("staleConflictError"));
      } else {
        setRenameError(error instanceof Error ? error.message : "Rename refused");
      }
    } finally {
      setRenamePending(false);
    }
  };

  const toggleFollowup = async (followupId: string) => {
    if (!record || !canUpdate || togglingId) return;
    setTogglingId(followupId);
    setActionError(null);
    const nextFollowups = record.profile.followups.map((item) =>
      item.id === followupId
        ? { ...item, status: (item.status === "done" ? "open" : "done") as "open" | "done" }
        : item,
    );
    try {
      const raw = await serviceCall(scope, "records.update", {
        record_id: record.id,
        expected_revision: record.revision,
        profile: {
          ...record.profile,
          followups: nextFollowups,
        },
        consent_provenance: { method: "followup_toggle" },
      });
      const updated = parseMeetingShowResponse(raw);
      setRecord(updated);
      onRecordUpdated(updated);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setActionError(t("staleConflictError"));
      } else {
        setActionError(error instanceof Error ? error.message : "Update refused");
      }
    } finally {
      setTogglingId(null);
    }
  };

  const parsedLines = useMemo(
    () => (record ? parseTranscriptLines(record.profile.transcript) : []),
    [record],
  );

  const filteredLines = useMemo(() => {
    const q = transcriptFilter.trim().toLowerCase();
    if (!q) return parsedLines;
    return parsedLines.filter(
      (line) =>
        line.text.toLowerCase().includes(q) ||
        (line.speaker && line.speaker.toLowerCase().includes(q)) ||
        (line.timestamp && line.timestamp.toLowerCase().includes(q)),
    );
  }, [parsedLines, transcriptFilter]);

  const provenanceLabel = (provenance: Record<string, unknown> | null): string | null => {
    const method = provenance?.method;
    if (method === "screen_form") return t("provenanceScreenForm");
    if (method === "inline_rename") return t("provenanceInlineRename");
    if (method === "followup_toggle") return t("provenanceFollowupToggle");
    if (method === "assistant_consolidation") return t("provenanceAssistant");
    return typeof method === "string" ? method : null;
  };

  const subtitleNode = record ? (
    <span>
      {formatHeldAt(record.profile.held_at, locale)}
      {formatDuration(record.profile.duration_seconds, locale)
        ? ` · ${formatDuration(record.profile.duration_seconds, locale)}`
        : ""}
    </span>
  ) : undefined;

  const pillsNode = record ? (
    <>
      <TitleOriginBadge source={record.profile.title_source} />
      <MeetingStatusChip status={record.profile.status} />
      {record.profile.tags.map((tag) => (
        <span key={tag} className="mm-tag-chip">
          #{tag}
        </span>
      ))}
    </>
  ) : undefined;

  const minutesPanel = record ? (
    <div className="mm-detail-stack">
      {actionError ? <ErrorNotice>{actionError}</ErrorNotice> : null}

      {renaming ? (
        <form className="card mm-rename-box" onSubmit={(e) => void submitRename(e)} noValidate>
          <Field
            label={t("renameLabel")}
            hint={t("renameHint")}
            error={renameError ?? undefined}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                className="field"
                maxLength={200}
                value={renameDraft}
                autoFocus
                onChange={(e) => {
                  setRenameDraft(e.target.value);
                  if (renameError) setRenameError(null);
                }}
              />
            )}
          </Field>
          <div className="mm-rename-actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={renamePending}
              onClick={() => setRenaming(false)}
            >
              {t("renameCancel")}
            </Button>
            <Button size="sm" variant="primary" type="submit" loading={renamePending}>
              {t("renameSave")}
            </Button>
          </div>
        </form>
      ) : null}

      <section className="mm-detail-section">
        <h3 className="mm-section-kicker">{t("summaryHeading")}</h3>
        {record.profile.summary.trim() ? (
          <p className="mm-summary-copy">{record.profile.summary}</p>
        ) : (
          <p className="mm-muted-copy">{t("summaryEmpty")}</p>
        )}
      </section>

      <section className="mm-detail-section">
        <h3 className="mm-section-kicker">{t("decisionsHeading")}</h3>
        {record.profile.decisions.length > 0 ? (
          <ul className="mm-item-list">
            {record.profile.decisions.map((decision) => (
              <li key={decision.id} className="card mm-decision-card">
                <div className="mm-decision-head">
                  {decision.timestamp ? (
                    <span className="mm-ts-pill num">{decision.timestamp}</span>
                  ) : null}
                  <span className="mm-decision-text">{decision.text}</span>
                </div>
                {decision.quote ? (
                  <blockquote className="mm-decision-quote">“{decision.quote}”</blockquote>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mm-muted-copy">{t("decisionsEmpty")}</p>
        )}
      </section>

      <section className="mm-detail-section">
        <h3 className="mm-section-kicker">{t("followupsHeading")}</h3>
        {record.profile.followups.length > 0 ? (
          <ul className="mm-item-list">
            {record.profile.followups.map((item) => {
              const done = item.status === "done";
              return (
                <li key={item.id} className="card mm-followup-card" data-done={done ? "true" : undefined}>
                  <div className="mm-followup-main">
                    <div className="mm-followup-task">
                      {done ? <IconCheck size={14} className="text-ok" /> : null}
                      <span>{item.task}</span>
                    </div>
                    <div className="mm-followup-meta">
                      <span className="mm-meta-pill" data-unset={!item.owner ? "true" : undefined}>
                        {item.owner ?? t("ownerUnassigned")}
                      </span>
                      <span className="mm-meta-pill num" data-unset={!item.due ? "true" : undefined}>
                        {item.due ?? t("dueUnset")}
                      </span>
                    </div>
                  </div>
                  {canUpdate ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={togglingId === item.id}
                      disabled={togglingId !== null && togglingId !== item.id}
                      onClick={() => void toggleFollowup(item.id)}
                    >
                      {done ? t("reopenTask") : t("markDone")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mm-muted-copy">{t("followupsEmpty")}</p>
        )}
      </section>

      <section className="mm-detail-section">
        <Detail
          items={[
            {
              key: "participants",
              term: t("detailParticipants"),
              value:
                record.profile.participants.length > 0
                  ? record.profile.participants.join(", ")
                  : t("noParticipants"),
            },
            {
              key: "title-origin",
              term: t("detailTitleOrigin"),
              value:
                record.profile.title_source === "user"
                  ? t("badgeUserTitle")
                  : t("badgeGeneratedTitle"),
            },
            {
              key: "revision",
              term: t("detailRevision"),
              value: <span className="num">r{record.revision}</span>,
            },
            {
              key: "record-id",
              term: t("detailRecordId"),
              value: <span className="num">{record.id}</span>,
            },
          ]}
        />
      </section>
    </div>
  ) : null;

  const transcriptPanel = record ? (
    <div className="mm-detail-stack">
      {record.profile.transcript.trim() ? (
        <>
          <Field label={t("transcriptSearchLabel")}>
            {(control) => (
              <input
                {...control}
                type="search"
                className="field"
                value={transcriptFilter}
                placeholder={t("transcriptSearchPlaceholder")}
                onChange={(e) => setTranscriptFilter(e.target.value)}
              />
            )}
          </Field>
          {filteredLines.length > 0 ? (
            <ol className="mm-transcript-list">
              {filteredLines.map((line, index) => (
                <li key={index} className="mm-transcript-line">
                  {line.timestamp ? (
                    <span className="mm-ts-pill num">{line.timestamp}</span>
                  ) : null}
                  <div className="mm-transcript-utterance">
                    {line.speaker ? (
                      <strong className="mm-transcript-speaker">{line.speaker}</strong>
                    ) : null}
                    <span className="mm-transcript-text">{line.text}</span>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title={t("transcriptNoMatch")} name="transcript-filter" />
          )}
        </>
      ) : (
        <EmptyState title={t("transcriptEmpty")} name="transcript-empty" />
      )}
    </div>
  ) : null;

  const historyPanel = record ? (
    <div className="mm-detail-stack">
      {record.historyTruncated ? (
        <Notice state="history-truncated">{t("historyTruncatedNotice")}</Notice>
      ) : null}
      {record.history.length > 0 ? (
        <ol className="mm-history-list">
          {record.history.map((entry) => {
            const prov = provenanceLabel(entry.provenance);
            return (
              <li key={entry.revision} className="card mm-history-card">
                <div className="mm-history-head">
                  <span className="mm-ts-pill num">r{entry.revision}</span>
                  <span className="mm-history-actor">{entry.actor}</span>
                  <span className="mm-history-time num">
                    {formatUnixSeconds(entry.at, locale)}
                  </span>
                </div>
                <div className="mm-history-meta">
                  <span>{entry.operation === "create" ? "create" : "update"}</span>
                  {prov ? <span> · {prov}</span> : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mm-muted-copy">{t("historyEmpty")}</p>
      )}
    </div>
  ) : null;

  const stateNode =
    loading && !record ? (
      <Loading>{t("loadingRecord")}</Loading>
    ) : loadError && !record ? (
      <ErrorNotice onRetry={() => void fetchFullRecord()} retryLabel={t("retry")}>
        {loadError}
      </ErrorNotice>
    ) : undefined;

  const editFormId = "mm-edit-form";
  const editBodyNode =
    editing && record ? (
      <MeetingComposeForm
        formId={editFormId}
        scope={scope}
        record={record}
        onPendingChange={setEditPending}
        onSaved={(updated) => {
          setRecord(updated);
          setEditing(false);
          onRecordUpdated(updated);
        }}
      />
    ) : null;

  const drawerTitle = record?.profile.title ?? t("untitledMeeting");

  if (surface.role === "drawer") {
    return (
      <HostedDrawerSurface
        title={drawerTitle}
        subtitle={subtitleNode}
        pills={pillsNode}
        tabs={
          record && !editing
            ? [
                { id: "minutes", label: t("tabMinutes") },
                { id: "transcript", label: t("tabTranscript") },
                { id: "history", label: t("tabHistory") },
              ]
            : undefined
        }
        activeTab={activeTab}
        onTab={setActiveTab}
        onClose={onClose}
        footer={
          record ? (
            editing ? (
              <div className="mm-drawer-foot-row">
                <Button
                  variant="secondary"
                  disabled={editPending}
                  onClick={() => setEditing(false)}
                >
                  {t("cancelEdit")}
                </Button>
                <Button
                  variant="primary"
                  loading={editPending}
                  onClick={() => {
                    const form = document.getElementById(editFormId);
                    if (form instanceof HTMLFormElement) {
                      form.dispatchEvent(
                        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
                      );
                    }
                  }}
                >
                  {t("saveMinutes")}
                </Button>
              </div>
            ) : canUpdate ? (
              <div className="mm-drawer-foot-row">
                <Button variant="secondary" onClick={startRename}>
                  {t("renameAction")}
                </Button>
                <Button variant="primary" onClick={() => setEditing(true)}>
                  {t("editAction")}
                </Button>
              </div>
            ) : (
              <span className="crm-drawer-note">{t("readOnlyNotice")}</span>
            )
          ) : null
        }
      >
        {stateNode ??
          (editing
            ? editBodyNode
            : activeTab === "transcript"
              ? transcriptPanel
              : activeTab === "history"
                ? historyPanel
                : minutesPanel)}
      </HostedDrawerSurface>
    );
  }

  return (
    <FrameDrawer
      kind={t("drawerKindMeeting")}
      label={drawerTitle}
      title={drawerTitle}
      subtitle={subtitleNode}
      pills={pillsNode}
      state={stateNode}
      tab={activeTab}
      onTab={setActiveTab}
      tabs={[
        { id: "minutes", label: t("tabMinutes"), panel: minutesPanel },
        { id: "transcript", label: t("tabTranscript"), panel: transcriptPanel },
        { id: "history", label: t("tabHistory"), panel: historyPanel },
      ]}
      edit={
        editing && record
          ? {
              formId: editFormId,
              title: t("editAction"),
              body: editBodyNode,
              saveLabel: t("saveMinutes"),
              pending: editPending,
              onCancel: () => setEditing(false),
            }
          : null
      }
      secondary={
        canUpdate && record && !renaming ? (
          <Button variant="secondary" onClick={startRename}>
            {t("renameAction")}
          </Button>
        ) : undefined
      }
      primary={
        canUpdate && record ? (
          <Button variant="primary" onClick={() => setEditing(true)}>
            {t("editAction")}
          </Button>
        ) : undefined
      }
      note={!canUpdate ? t("readOnlyNotice") : undefined}
      onClose={onClose}
    />
  );
}
