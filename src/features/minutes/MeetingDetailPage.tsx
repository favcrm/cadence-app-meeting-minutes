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
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DisplayScope } from "../../bridge/scope";
import { serviceCall } from "../../bridge/services";
import { useMinutesText } from "./i18n";
import {
  formatClock,
  formatHeldAtStartClock,
  formatWallClockAtOffset,
  parseClockToSeconds,
} from "./liveTranscript";
import { MeetingStatusChip, TitleOriginBadge } from "./MeetingBadges";
import MeetingEditForm from "./MeetingEditForm";
import {
  formatDuration,
  formatHeldAt,
  formatUnixSeconds,
  parseMeetingShowResponse,
  parseTranscriptLines,
} from "./model";
import type { DecisionItem, FollowupItem, MeetingRecord } from "./types";

type DetailTab = "summary" | "decisions" | "transcript" | "history";

const OVERVIEW_ACTION_PREVIEW_LIMIT = 6;
const OVERVIEW_TRANSCRIPT_PREVIEW_LIMIT = 5;

function normalizeTsKey(ts: string | null | undefined): string | null {
  const sec = parseClockToSeconds(ts);
  if (sec === null) return ts ? ts.trim().replace(/^\[|\]$/g, "") : null;
  return formatClock(sec);
}

function renderHighlightedText(text: string, rawQuery: string): ReactNode {
  const q = rawQuery.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length <= 1) return text;
  const lower = q.toLowerCase();
  return parts.map((part, idx) =>
    part.toLowerCase() === lower ? (
      <mark key={idx} className="mm-search-mark">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export default function MeetingDetailPage({
  scope,
  recordId,
  initialRecord,
  returnSection,
  canUpdate,
  onBack,
  onRecordUpdated,
}: {
  scope: DisplayScope;
  recordId: string;
  initialRecord: MeetingRecord | null;
  returnSection: "all" | "followups";
  canUpdate: boolean;
  onBack: () => void;
  onRecordUpdated: (updated: MeetingRecord) => void;
}) {
  const { locale, t } = useMinutesText();

  const [record, setRecord] = useState<MeetingRecord | null>(initialRecord);
  const [loading, setLoading] = useState<boolean>(!initialRecord);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("summary");
  const [editing, setEditing] = useState<boolean>(false);
  const [editPending, setEditPending] = useState<boolean>(false);

  const [renaming, setRenaming] = useState<boolean>(false);
  const [renameDraft, setRenameDraft] = useState<string>("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState<boolean>(false);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transcriptFilter, setTranscriptFilter] = useState<string>("");
  const [highlightedTs, setHighlightedTs] = useState<string | null>(null);
  const [copiedTranscript, setCopiedTranscript] = useState<boolean>(false);
  const copyTimerRef = useRef<number | null>(null);
  const transcriptListRef = useRef<HTMLOListElement | null>(null);

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
    setHighlightedTs(null);
    setCopiedTranscript(false);
    setActiveTab("summary");
    void fetchFullRecord();
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, scope.installId, scope.digest]);

  useEffect(() => {
    if (activeTab !== "transcript" || !highlightedTs || !transcriptListRef.current) return;
    const rows = Array.from(
      transcriptListRef.current.querySelectorAll<HTMLLIElement>("li[data-ts-key]"),
    );
    const hit = rows.find((el) => el.dataset.tsKey === highlightedTs);
    if (hit && typeof hit.scrollIntoView === "function") {
      const reduceMotion =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      hit.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    }
  }, [activeTab, highlightedTs]);

  const jumpToTranscriptTimestamp = (rawTs: string) => {
    const key = normalizeTsKey(rawTs);
    setTranscriptFilter("");
    setHighlightedTs(key);
    setActiveTab("transcript");
  };

  const handleCopyTranscript = async () => {
    if (!record?.profile.transcript.trim()) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(record.profile.transcript);
      }
      setCopiedTranscript(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedTranscript(false);
        copyTimerRef.current = null;
      }, 2000);
    } catch {
      // Ignore clipboard permission failure gracefully in restricted iframes.
    }
  };

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
      setTogglingId(false ? null : null);
    }
  };

  const parsedLines = useMemo(
    () =>
      record
        ? parseTranscriptLines(record.profile.transcript).map((line, index) => ({
            ...line,
            index,
            tsKey: normalizeTsKey(line.timestamp),
          }))
        : [],
    [record],
  );

  const citedDecisionsByTs = useMemo(() => {
    const map = new Map<string, DecisionItem[]>();
    if (!record) return map;
    for (const dec of record.profile.decisions) {
      const key = normalizeTsKey(dec.timestamp);
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(dec);
      map.set(key, list);
    }
    return map;
  }, [record]);

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

  const startClockLabel = useMemo(
    () => formatHeldAtStartClock(record?.profile.held_at, locale),
    [record?.profile.held_at, locale],
  );

  const transcriptSpanLabel = useMemo(() => {
    if (!record) return null;
    if (record.profile.duration_seconds && record.profile.duration_seconds > 0) {
      return `00:00 – ${formatClock(record.profile.duration_seconds)}`;
    }
    const stamped = parsedLines
      .map((l) => parseClockToSeconds(l.timestamp))
      .filter((n): n is number => n !== null);
    if (stamped.length >= 2) {
      return `${formatClock(Math.min(...stamped))} – ${formatClock(Math.max(...stamped))}`;
    }
    return null;
  }, [parsedLines, record]);

  const provenanceLabel = (provenance: Record<string, unknown> | null): string | null => {
    const method = provenance?.method;
    if (method === "screen_form") return t("provenanceScreenForm");
    if (method === "inline_rename") return t("provenanceInlineRename");
    if (method === "followup_toggle") return t("provenanceFollowupToggle");
    if (method === "assistant_consolidation") return t("provenanceAssistant");
    return typeof method === "string" ? method : null;
  };

  const backLabel =
    returnSection === "followups" ? t("backToFollowups") : t("backToAllMeetings");
  const editFormId = "mm-edit-form";

  const totalFollowupsCount = record ? record.profile.followups.length : 0;
  const openFollowupsCount = record
    ? record.profile.followups.filter((f) => f.status === "open").length
    : 0;
  const doneFollowupsCount = totalFollowupsCount - openFollowupsCount;
  const decisionsCount = record ? record.profile.decisions.length : 0;
  const decisionsAndFollowupsCount = decisionsCount + totalFollowupsCount;
  const completionPct =
    totalFollowupsCount > 0 ? Math.round((doneFollowupsCount / totalFollowupsCount) * 100) : 0;

  const renderDecisionList = (items: DecisionItem[]) => (
    <ul className="mm-item-list">
      {items.map((decision) => (
        <li key={decision.id} className="card mm-decision-card mm-decision-card-accent">
          <div className="mm-decision-head">
            {decision.timestamp ? (
              <button
                type="button"
                className="mm-ts-pill mm-live-ts-pill mm-ts-pill-jump num"
                title={t("transcriptJumpTooltip", { time: decision.timestamp })}
                onClick={() => jumpToTranscriptTimestamp(decision.timestamp!)}
              >
                {decision.timestamp}
              </button>
            ) : null}
            <span className="mm-decision-text">{decision.text}</span>
          </div>
          {decision.quote ? (
            <blockquote className="mm-decision-quote">“{decision.quote}”</blockquote>
          ) : null}
        </li>
      ))}
    </ul>
  );

  const renderFollowupsTable = (items: FollowupItem[]) => (
    <div className="stable-wrap mm-result-actions-wrap">
      <table className="stable mm-table mm-result-actions-table">
        <thead>
          <tr>
            <th scope="col">{t("colTask")}</th>
            <th scope="col">{t("colOwner")}</th>
            <th scope="col">{t("colDue")}</th>
            <th scope="col">{t("resultColStatus")}</th>
            {canUpdate ? (
              <th scope="col" className="mm-cell-action">
                {t("resultColAction")}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const done = item.status === "done";
            return (
              <tr key={item.id} data-done={done ? "true" : undefined}>
                <td className="mm-cell-task">
                  <div className="mm-followup-row-title" data-done={done ? "true" : undefined}>
                    {done ? <IconCheck size={14} className="text-ok" /> : null}
                    <span>{item.task}</span>
                  </div>
                </td>
                <td>
                  <span className="mm-meta-pill" data-unset={!item.owner ? "true" : undefined}>
                    {item.owner ?? t("ownerUnassigned")}
                  </span>
                </td>
                <td>
                  <span className="mm-meta-pill num" data-unset={!item.due ? "true" : undefined}>
                    {item.due ?? t("dueUnset")}
                  </span>
                </td>
                <td>
                  <span className="mm-followup-state-pill" data-done={done ? "true" : undefined}>
                    {done ? t("resultStatusDone") : t("resultStatusOpen")}
                  </span>
                </td>
                {canUpdate ? (
                  <td className="mm-cell-action">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={togglingId === item.id}
                      disabled={togglingId !== null && togglingId !== item.id}
                      onClick={() => void toggleFollowup(item.id)}
                    >
                      {done ? t("reopenTask") : t("markDone")}
                    </Button>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <section
      className="mm-page mm-detail-page"
      aria-label={record?.profile.title ?? t("untitledMeeting")}
    >
      <div className="mm-page-topbar">
        <button
          type="button"
          className="mm-back-link"
          disabled={editPending}
          onClick={onBack}
        >
          <span aria-hidden="true">←</span>
          <span>{backLabel}</span>
        </button>
      </div>

      {loading && !record ? (
        <Loading>{t("loadingRecord")}</Loading>
      ) : loadError && !record ? (
        <ErrorNotice onRetry={() => void fetchFullRecord()} retryLabel={t("retry")}>
          {loadError}
        </ErrorNotice>
      ) : record ? (
        <>
          <header className="mm-detail-hero">
            <div className="mm-detail-hero-main">
              <div className="mm-detail-pills">
                <TitleOriginBadge source={record.profile.title_source} />
                <MeetingStatusChip status={record.profile.status} />
                {record.profile.tags.map((tag) => (
                  <span key={tag} className="mm-tag-chip">
                    #{tag}
                  </span>
                ))}
              </div>
              <h1 className="mm-title mm-detail-title">{record.profile.title}</h1>
              <p className="mm-subtitle num">
                {formatHeldAt(record.profile.held_at, locale)}
                {formatDuration(record.profile.duration_seconds, locale)
                  ? ` · ${formatDuration(record.profile.duration_seconds, locale)}`
                  : ""}
                {record.profile.participants.length > 0
                  ? ` · ${record.profile.participants.join(", ")}`
                  : ""}
              </p>
            </div>

            {canUpdate ? (
              <div className="mm-detail-hero-actions">
                {editing ? (
                  <>
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
                  </>
                ) : (
                  <>
                    {!renaming ? (
                      <Button variant="secondary" onClick={startRename}>
                        {t("renameAction")}
                      </Button>
                    ) : null}
                    <Button variant="primary" onClick={() => setEditing(true)}>
                      {t("editAction")}
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <Notice state="read-only">{t("readOnlyNotice")}</Notice>
            )}
          </header>

          {renaming && !editing ? (
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

          {actionError ? <ErrorNotice>{actionError}</ErrorNotice> : null}

          {editing ? (
            <MeetingEditForm
              formId={editFormId}
              scope={scope}
              record={record}
              onPendingChange={setEditPending}
              onCancel={() => setEditing(false)}
              onSaved={(updated) => {
                setRecord(updated);
                setEditing(false);
                onRecordUpdated(updated);
              }}
            />
          ) : (
            <>
              <nav className="app-outlet-tabs" role="tablist" aria-label={record.profile.title}>
                <button
                  type="button"
                  role="tab"
                  className="app-outlet-tab"
                  aria-selected={activeTab === "summary"}
                  data-on={activeTab === "summary" ? "" : undefined}
                  onClick={() => setActiveTab("summary")}
                >
                  {t("tabSummary")}
                </button>
                <button
                  type="button"
                  role="tab"
                  className="app-outlet-tab mm-tab-with-count"
                  aria-selected={activeTab === "decisions"}
                  data-on={activeTab === "decisions" ? "" : undefined}
                  onClick={() => setActiveTab("decisions")}
                >
                  <span>{t("tabDecisionsFollowups")}</span>
                  {decisionsAndFollowupsCount > 0 ? (
                    <span className="mm-count-pill num">
                      {openFollowupsCount > 0 ? openFollowupsCount : decisionsAndFollowupsCount}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  className="app-outlet-tab mm-tab-with-count"
                  aria-selected={activeTab === "transcript"}
                  data-on={activeTab === "transcript" ? "" : undefined}
                  onClick={() => setActiveTab("transcript")}
                >
                  <span>{t("tabTranscript")}</span>
                  {parsedLines.length > 0 ? (
                    <span className="mm-count-pill num">{parsedLines.length}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  className="app-outlet-tab"
                  aria-selected={activeTab === "history"}
                  data-on={activeTab === "history" ? "" : undefined}
                  onClick={() => setActiveTab("history")}
                >
                  {t("tabHistory")}
                </button>
              </nav>

              {activeTab === "summary" ? (
                <div className="mm-detail-grid">
                  <div className="mm-detail-main">
                    <dl className="mm-result-kpi-grid num">
                      <div className="mm-result-kpi-cell">
                        <dd className="mm-result-kpi-value">{decisionsCount}</dd>
                        <dt className="mm-result-kpi-label">{t("resultKpiDecisions")}</dt>
                      </div>
                      <div
                        className="mm-result-kpi-cell"
                        data-accent={openFollowupsCount > 0 ? "warn" : undefined}
                      >
                        <dd className="mm-result-kpi-value">{openFollowupsCount}</dd>
                        <dt className="mm-result-kpi-label">{t("resultKpiOpenFollowups")}</dt>
                      </div>
                      <div
                        className="mm-result-kpi-cell"
                        data-accent={doneFollowupsCount > 0 ? "ok" : undefined}
                      >
                        <dd className="mm-result-kpi-value">{doneFollowupsCount}</dd>
                        <dt className="mm-result-kpi-label">{t("resultKpiCompleted")}</dt>
                      </div>
                      <div className="mm-result-kpi-cell">
                        <dd className="mm-result-kpi-value">{parsedLines.length}</dd>
                        <dt className="mm-result-kpi-label">{t("resultKpiTranscriptSegments")}</dt>
                      </div>
                    </dl>

                    <section className="card mm-detail-card">
                      <h2 className="mm-section-kicker">{t("summaryHeading")}</h2>
                      {record.profile.summary.trim() ? (
                        <p className="mm-summary-copy">{record.profile.summary}</p>
                      ) : (
                        <p className="mm-muted-copy">{t("summaryEmpty")}</p>
                      )}
                    </section>

                    {!record.profile.summary.trim() && record.profile.transcript.trim() ? (
                      <Notice className="mm-assistant-callout" state="assistant-hint">
                        <strong>{t("assistantCalloutTitle")}:</strong> {t("assistantCalloutBody")}
                      </Notice>
                    ) : null}

                    {decisionsAndFollowupsCount > 0 ? (
                      <section className="card mm-detail-card mm-digest-card">
                        <div className="mm-live-transcript-head">
                          <div className="mm-live-transcript-title-group">
                            <h2 className="mm-section-kicker">{t("resultDigestHeading")}</h2>
                            <span className="mm-count-pill num">{decisionsAndFollowupsCount}</span>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setActiveTab("decisions")}
                          >
                            {t("resultOpenFullList")} →
                          </Button>
                        </div>

                        {decisionsCount > 0 ? (
                          <div className="mm-digest-block">
                            <h3 className="mm-digest-subhead">
                              {t("decisionsHeading")} · <span className="num">{decisionsCount}</span>
                            </h3>
                            {renderDecisionList(record.profile.decisions)}
                          </div>
                        ) : null}

                        {totalFollowupsCount > 0 ? (
                          <div className="mm-digest-block">
                            <h3 className="mm-digest-subhead">
                              {t("followupsHeading")} ·{" "}
                              <span className="num">{totalFollowupsCount}</span>
                            </h3>
                            {renderFollowupsTable(
                              record.profile.followups.slice(0, OVERVIEW_ACTION_PREVIEW_LIMIT),
                            )}
                          </div>
                        ) : null}
                      </section>
                    ) : null}

                    {!record.profile.summary.trim() && parsedLines.length > 0 ? (
                      <section className="card mm-live-transcript-card mm-transcript-preview-card">
                        <div className="mm-live-transcript-head">
                          <div className="mm-live-transcript-title-group">
                            <h2 className="mm-section-kicker">
                              {t("resultTranscriptPreviewHeading")}
                            </h2>
                            <span className="mm-count-pill num">{parsedLines.length}</span>
                            {startClockLabel ? (
                              <span className="mm-live-clock-origin num">
                                {t("liveTranscriptStartedAt", { time: startClockLabel })}
                              </span>
                            ) : null}
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setActiveTab("transcript")}
                          >
                            {t("resultViewFullTranscript", { count: parsedLines.length })} →
                          </Button>
                        </div>

                        <ol className="mm-live-transcript-list">
                          {parsedLines
                            .slice(0, OVERVIEW_TRANSCRIPT_PREVIEW_LIMIT)
                            .map((line) => {
                              const wallClock = formatWallClockAtOffset(
                                record.profile.held_at,
                                line.timestamp,
                                locale,
                              );
                              return (
                                <li key={line.index} className="mm-live-transcript-row">
                                  {line.timestamp ? (
                                    <span
                                      className="mm-ts-pill mm-live-ts-pill num"
                                      title={
                                        wallClock
                                          ? `${line.timestamp} · ${wallClock}`
                                          : line.timestamp
                                      }
                                    >
                                      {line.timestamp}
                                    </span>
                                  ) : (
                                    <span className="mm-ts-pill mm-live-ts-pill mm-ts-pill-index num">
                                      #{String(line.index + 1).padStart(2, "0")}
                                    </span>
                                  )}
                                  <div className="mm-transcript-utterance">
                                    {line.speaker ? (
                                      <strong className="mm-transcript-speaker">
                                        {line.speaker}
                                      </strong>
                                    ) : null}
                                    <span className="mm-live-transcript-text">{line.text}</span>
                                  </div>
                                  {wallClock ? (
                                    <span className="mm-ts-wall num">{wallClock}</span>
                                  ) : null}
                                </li>
                              );
                            })}
                        </ol>
                      </section>
                    ) : null}
                  </div>

                  <aside className="mm-detail-rail">
                    <section className="card mm-detail-card mm-rail-status-card">
                      <div className="mm-live-transcript-head">
                        <h2 className="mm-section-kicker">{t("resultRailStatusHeading")}</h2>
                        <MeetingStatusChip status={record.profile.status} />
                      </div>

                      {totalFollowupsCount > 0 ? (
                        <div className="mm-rail-progress-block">
                          <strong className="mm-rail-status-headline num">
                            {openFollowupsCount === 0
                              ? t("resultRailAllDone", { total: totalFollowupsCount })
                              : t("resultRailOpenProgress", {
                                  open: openFollowupsCount,
                                  done: doneFollowupsCount,
                                  total: totalFollowupsCount,
                                })}
                          </strong>
                          <div className="mm-progress-track">
                            <div
                              className="mm-progress-fill"
                              style={{ width: `${completionPct}%` }}
                            />
                          </div>
                        </div>
                      ) : (
                        <strong className="mm-rail-status-headline">
                          {record.profile.summary.trim()
                            ? t("resultRailReadyConsolidated")
                            : t("resultRailDraftPending")}
                        </strong>
                      )}

                      <p className="mm-rail-provenance num">
                        r{record.revision}
                        {record.history[0] && provenanceLabel(record.history[0].provenance)
                          ? ` · ${provenanceLabel(record.history[0].provenance)}`
                          : ""}
                      </p>
                    </section>

                    <section className="card mm-detail-card mm-detail-meta">
                      <h2 className="mm-section-kicker">{t("resultRailDetailsHeading")}</h2>

                      <div className="mm-rail-participants-block">
                        <span className="mm-rail-field-label">{t("detailParticipants")}</span>
                        {record.profile.participants.length > 0 ? (
                          <div className="mm-participant-chips">
                            {record.profile.participants.map((person) => (
                              <span key={person} className="mm-participant-chip">
                                {person}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="mm-muted-copy">{t("noParticipants")}</span>
                        )}
                      </div>

                      <Detail
                        items={[
                          {
                            key: "held-at",
                            term: t("detailHeldAt"),
                            value: (
                              <span className="num">
                                {formatHeldAt(record.profile.held_at, locale)}
                              </span>
                            ),
                          },
                          ...(formatDuration(record.profile.duration_seconds, locale)
                            ? [
                                {
                                  key: "duration",
                                  term: t("detailDuration"),
                                  value: (
                                    <span className="num">
                                      {formatDuration(record.profile.duration_seconds, locale)}
                                    </span>
                                  ),
                                },
                              ]
                            : []),
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
                  </aside>
                </div>
              ) : activeTab === "decisions" ? (
                <div className="mm-detail-stack">
                  <section className="card mm-detail-card">
                    <div className="mm-live-transcript-title-group">
                      <h2 className="mm-section-kicker">{t("decisionsHeading")}</h2>
                      {decisionsCount > 0 ? (
                        <span className="mm-count-pill num">{decisionsCount}</span>
                      ) : null}
                    </div>
                    {decisionsCount > 0 ? (
                      renderDecisionList(record.profile.decisions)
                    ) : (
                      <p className="mm-muted-copy">{t("decisionsEmpty")}</p>
                    )}
                  </section>

                  <section className="card mm-detail-card">
                    <div className="mm-live-transcript-title-group">
                      <h2 className="mm-section-kicker">{t("followupsHeading")}</h2>
                      {totalFollowupsCount > 0 ? (
                        <span className="mm-count-pill num">{totalFollowupsCount}</span>
                      ) : null}
                    </div>
                    {totalFollowupsCount > 0 ? (
                      renderFollowupsTable(record.profile.followups)
                    ) : (
                      <p className="mm-muted-copy">{t("followupsEmpty")}</p>
                    )}
                  </section>
                </div>
              ) : activeTab === "transcript" ? (
                <div className="mm-detail-stack">
                  {record.profile.transcript.trim() ? (
                    <section
                      className="card mm-live-transcript-card mm-transcript-panel-card"
                      aria-label={t("transcriptHeading")}
                    >
                      <div className="mm-live-transcript-head">
                        <div className="mm-live-transcript-title-group">
                          <h2 className="mm-section-kicker">{t("transcriptHeading")}</h2>
                          <span className="mm-count-pill num">{parsedLines.length}</span>
                          {startClockLabel ? (
                            <span className="mm-live-clock-origin num">
                              {t("liveTranscriptStartedAt", { time: startClockLabel })}
                            </span>
                          ) : null}
                          {transcriptSpanLabel ? (
                            <span className="mm-meta-pill num">{transcriptSpanLabel}</span>
                          ) : null}
                        </div>

                        <div className="mm-live-transcript-actions">
                          <Button
                            id="mm-btn-copy-transcript"
                            size="sm"
                            variant="secondary"
                            onClick={() => void handleCopyTranscript()}
                          >
                            {copiedTranscript
                              ? t("transcriptCopiedBadge")
                              : t("transcriptCopyAction")}
                          </Button>
                        </div>
                      </div>

                      <div className="mm-transcript-toolbar">
                        <div className="mm-transcript-search-wrap">
                          <input
                            type="search"
                            className="field mm-transcript-search-input"
                            aria-label={t("transcriptSearchLabel")}
                            value={transcriptFilter}
                            placeholder={t("transcriptSearchPlaceholder")}
                            onChange={(e) => {
                              setTranscriptFilter(e.target.value);
                              if (highlightedTs) setHighlightedTs(null);
                            }}
                          />
                        </div>
                        <div className="mm-transcript-toolbar-meta num">
                          <span>
                            {t("transcriptMatchCount", {
                              shown: filteredLines.length,
                              total: parsedLines.length,
                            })}
                          </span>
                          {transcriptFilter.trim() ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setTranscriptFilter("")}
                            >
                              {t("clearSearch")}
                            </Button>
                          ) : null}
                        </div>
                      </div>

                      {filteredLines.length > 0 ? (
                        <ol ref={transcriptListRef} className="mm-transcript-list">
                          {filteredLines.map((line) => {
                            const wallClock = formatWallClockAtOffset(
                              record.profile.held_at,
                              line.timestamp,
                              locale,
                            );
                            const citedDecisions = line.tsKey
                              ? (citedDecisionsByTs.get(line.tsKey) ?? [])
                              : [];
                            const isHighlighted =
                              Boolean(highlightedTs) && line.tsKey === highlightedTs;
                            return (
                              <li
                                key={line.index}
                                data-ts-key={line.tsKey ?? undefined}
                                data-highlighted={isHighlighted ? "true" : undefined}
                                data-cited={citedDecisions.length > 0 ? "true" : undefined}
                                className="mm-live-transcript-row mm-transcript-line"
                              >
                                {line.timestamp ? (
                                  <span
                                    className="mm-ts-pill mm-live-ts-pill num"
                                    title={
                                      wallClock
                                        ? `${line.timestamp} · ${wallClock}`
                                        : line.timestamp
                                    }
                                  >
                                    {line.timestamp}
                                  </span>
                                ) : (
                                  <span className="mm-ts-pill mm-live-ts-pill mm-ts-pill-index num">
                                    #{String(line.index + 1).padStart(2, "0")}
                                  </span>
                                )}
                                <div className="mm-transcript-utterance">
                                  {line.speaker ? (
                                    <strong className="mm-transcript-speaker">
                                      {renderHighlightedText(line.speaker, transcriptFilter)}
                                    </strong>
                                  ) : null}
                                  <span className="mm-live-transcript-text mm-transcript-text">
                                    {renderHighlightedText(line.text, transcriptFilter)}
                                  </span>
                                  {citedDecisions.map((dec) => (
                                    <span key={dec.id} className="mm-transcript-citation">
                                      {t("transcriptCitedDecision")}: {dec.text}
                                    </span>
                                  ))}
                                </div>
                                {wallClock ? (
                                  <span className="mm-ts-wall num">{wallClock}</span>
                                ) : null}
                              </li>
                            );
                          })}
                        </ol>
                      ) : (
                        <EmptyState title={t("transcriptNoMatch")} name="transcript-filter" />
                      )}
                    </section>
                  ) : (
                    <EmptyState title={t("transcriptEmpty")} name="transcript-empty" />
                  )}
                </div>
              ) : (
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
              )}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
