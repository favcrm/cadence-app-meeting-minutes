import {
  ApiError,
  Button,
  DataTable,
  EmptyState,
  ErrorNotice,
  IconCheck,
  Select,
  type DataTableColumn,
} from "@cadence/screen-ui";
import { useMemo, useState } from "react";
import type { DisplayScope } from "../../bridge/scope";
import { serviceCall } from "../../bridge/services";
import { useMinutesText } from "./i18n";
import { formatHeldAt, parseMeetingShowResponse } from "./model";
import type { FollowupItem, MeetingRecord } from "./types";

interface AggregatedFollowup {
  key: string;
  meeting: MeetingRecord;
  item: FollowupItem;
}

export default function FollowupsSection({
  scope,
  meetings,
  canUpdate,
  onSelectMeeting,
  onMeetingUpdated,
}: {
  scope: DisplayScope;
  meetings: MeetingRecord[];
  canUpdate: boolean;
  onSelectMeeting: (meetingId: string) => void;
  onMeetingUpdated: (updated: MeetingRecord) => void;
}) {
  const { locale, t } = useMinutesText();
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allItems = useMemo<AggregatedFollowup[]>(() => {
    const list: AggregatedFollowup[] = [];
    for (const meeting of meetings) {
      for (const item of meeting.profile.followups) {
        list.push({
          key: `${meeting.id}:${item.id}`,
          meeting,
          item,
        });
      }
    }
    return list;
  }, [meetings]);

  const filtered = useMemo(() => {
    if (filter === "all") return allItems;
    return allItems.filter((row) => row.item.status === filter);
  }, [allItems, filter]);

  const filterOptions = useMemo(
    () => [
      { value: "open", label: t("followupFilterOpen") },
      { value: "done", label: t("followupFilterDone") },
      { value: "all", label: t("followupFilterAll") },
    ],
    [t],
  );

  const handleToggle = async (row: AggregatedFollowup) => {
    if (!canUpdate || busyKey) return;
    setBusyKey(row.key);
    setError(null);
    const nextFollowups = row.meeting.profile.followups.map((f) =>
      f.id === row.item.id
        ? { ...f, status: (f.status === "done" ? "open" : "done") as "open" | "done" }
        : f,
    );
    try {
      const raw = await serviceCall(scope, "records.update", {
        record_id: row.meeting.id,
        expected_revision: row.meeting.revision,
        profile: {
          ...row.meeting.profile,
          followups: nextFollowups,
        },
        consent_provenance: { method: "followup_toggle" },
      });
      onMeetingUpdated(parseMeetingShowResponse(raw));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(t("staleConflictError"));
      } else {
        setError(err instanceof Error ? err.message : "Update refused");
      }
    } finally {
      setBusyKey(null);
    }
  };

  const columns = useMemo<DataTableColumn<AggregatedFollowup>[]>(
    () => [
      {
        key: "task",
        header: t("colTask"),
        cell: (row) => (
          <div className="mm-cell-primary">
            <span className="mm-followup-row-title" data-done={row.item.status === "done" ? "true" : undefined}>
              {row.item.status === "done" ? <IconCheck size={14} className="text-ok" /> : null}
              <span>{row.item.task}</span>
            </span>
            <div className="mm-mobile-meta">
              <button
                type="button"
                className="lnk mm-row-link mm-mobile-source-link"
                onClick={() => onSelectMeeting(row.meeting.id)}
              >
                {row.meeting.profile.title}
              </button>
              <span className="mm-meta-pill" data-unset={!row.item.owner ? "true" : undefined}>
                {row.item.owner ?? t("ownerUnassigned")}
              </span>
              {row.item.due ? <span className="mm-meta-pill num">{row.item.due}</span> : null}
            </div>
          </div>
        ),
      },
      {
        key: "owner",
        header: t("colOwner"),
        cell: (row) => (
          <span className="mm-meta-pill" data-unset={!row.item.owner ? "true" : undefined}>
            {row.item.owner ?? t("ownerUnassigned")}
          </span>
        ),
      },
      {
        key: "due",
        header: t("colDue"),
        cell: (row) => (
          <span className="mm-meta-pill num" data-unset={!row.item.due ? "true" : undefined}>
            {row.item.due ?? t("dueUnset")}
          </span>
        ),
      },
      {
        key: "source",
        header: t("colSourceMeeting"),
        cell: (row) => (
          <div className="mm-source-cell">
            <button
              type="button"
              className="lnk mm-row-link"
              onClick={() => onSelectMeeting(row.meeting.id)}
            >
              {row.meeting.profile.title}
            </button>
            <span className="mm-cell-sub num">
              {formatHeldAt(row.meeting.profile.held_at, locale)}
            </span>
          </div>
        ),
      },
      ...(canUpdate
        ? [
            {
              key: "actions",
              header: "",
              cellClassName: "mm-actions-col",
              cell: (row: AggregatedFollowup) => (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busyKey === row.key}
                  disabled={busyKey !== null && busyKey !== row.key}
                  onClick={() => void handleToggle(row)}
                >
                  {row.item.status === "done" ? t("reopenTask") : t("markDone")}
                </Button>
              ),
            },
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyKey, canUpdate, locale, t],
  );

  return (
    <div className="mm-followups-view">
      <div className="crm-toolbar">
        <Select
          value={filter}
          options={filterOptions}
          onChange={(v) => setFilter(v as "open" | "done" | "all")}
          aria-label={t("followupFilterLabel")}
        />
      </div>

      {error ? <ErrorNotice>{error}</ErrorNotice> : null}

      {allItems.length === 0 ? (
        <EmptyState title={t("followupsEmptyAllTitle")} name="followups-empty">
          {t("followupsEmptyAllBody")}
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState title={t("followupsEmptyOpenTitle")} name="followups-filter-empty">
          {t("followupsEmptyOpenBody")}
        </EmptyState>
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(row) => row.key}
          label={t("followupsTableLabel")}
          wrapClassName="mm-table-wrap"
          tableClassName="mm-table mm-followups-table"
        />
      )}
    </div>
  );
}
