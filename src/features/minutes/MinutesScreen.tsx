import {
  Button,
  DataTable,
  EmptyState,
  ErrorNotice,
  IconSearch,
  Loading,
  NavigationProvider,
  Notice,
  Select,
  type DataTableColumn,
} from "@cadence/screen-ui";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { admitted, type MinutesSection } from "../../bridge/channel";
import { FrameNavigationAdapter, patchRoute } from "../../bridge/route";
import { useScope, useScopeError } from "../../bridge/scope";
import { onWrite, serviceCall } from "../../bridge/services";
import FollowupsSection from "./FollowupsSection";
import { MinutesLocaleProvider, useMinutesText } from "./i18n";
import ListPager from "./ListPager";
import { MeetingStatusChip, TitleOriginBadge } from "./MeetingBadges";
import MeetingDetailPage from "./MeetingDetailPage";
import {
  formatDuration,
  formatHeldAt,
  parseMeetingListResponse,
} from "./model";
import NewMeetingPage from "./NewMeetingPage";
import type { MeetingRecord, MeetingStatus } from "./types";

const PAGE_LIMIT = 25;

function MinutesScreenInner() {
  const snapshot = useScope();
  const scopeErr = useScopeError();
  const { locale, t } = useMinutesText();

  const [records, setRecords] = useState<MeetingRecord[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [loading, setLoading] = useState<boolean>(true);
  const [listError, setListError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState<string>("");
  const [committedQuery, setCommittedQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | MeetingStatus>("all");

  const currentCursor = cursorStack.at(-1) ?? null;

  const canCreate = snapshot ? admitted("records.create", snapshot.actions) : false;
  const canUpdate = snapshot ? admitted("records.update", snapshot.actions) : false;
  const canPatchRoute = snapshot ? admitted("screen.route.patch", snapshot.actions) : false;

  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const [localCreating, setLocalCreating] = useState<boolean>(false);

  const loadMeetings = useCallback(
    async (cursor: string | null, query: string) => {
      if (!snapshot) return;
      setLoading(true);
      setListError(null);
      try {
        const trimmed = query.trim();
        const raw = await serviceCall(snapshot.scope, "records.list", {
          limit: PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
          ...(trimmed ? { query: trimmed } : {}),
        });
        const parsed = parseMeetingListResponse(raw);
        setRecords(parsed.records);
        setTotal(parsed.total);
        setNextCursor(parsed.nextCursor);
      } catch (err) {
        setListError(err instanceof Error ? err.message : "Failed to read meetings");
      } finally {
        setLoading(false);
      }
    },
    [snapshot],
  );

  useEffect(() => {
    if (!snapshot) return;
    if (currentCursor === null && committedQuery === "") {
      const obs = snapshot.observations.find(
        (o) => o.operation === "records.list" && !o.args.query && !o.args.cursor,
      );
      if (obs) {
        try {
          const parsed = parseMeetingListResponse(obs.data);
          setRecords(parsed.records);
          setTotal(parsed.total);
          setNextCursor(parsed.nextCursor);
          setLoading(false);
          setListError(null);
          return;
        } catch {
          // Fall through to live records.list call
        }
      }
    }
    void loadMeetings(currentCursor, committedQuery);
  }, [committedQuery, currentCursor, loadMeetings, snapshot]);

  useEffect(() => {
    return onWrite(() => {
      if (snapshot) {
        void loadMeetings(currentCursor, committedQuery);
      }
    });
  }, [committedQuery, currentCursor, loadMeetings, snapshot]);

  if (!snapshot) {
    if (scopeErr) return <ErrorNotice>{scopeErr}</ErrorNotice>;
    return <Loading>{t("loadingMeetings")}</Loading>;
  }

  const route = snapshot.route;
  const activeSection = route.section;
  const activeRecordId = activeSection === "new" ? null : (route.record_id ?? localSelectedId);
  const isNewMeetingRoute =
    !activeRecordId && (activeSection === "new" || route.view === "new" || localCreating);

  const navigateSection = (section: MinutesSection) => {
    setLocalSelectedId(null);
    setLocalCreating(section === "new");
    if (canPatchRoute) {
      void patchRoute({
        section,
        view: "list",
        record_id: null,
        segment_id: null,
      }).catch(() => undefined);
    }
  };

  const openMeeting = (meetingId: string, sectionOverride?: "all" | "followups") => {
    setLocalCreating(false);
    const targetSection =
      sectionOverride ?? (activeSection === "followups" ? "followups" : "all");
    if (canPatchRoute) {
      void patchRoute({
        section: targetSection,
        view: "list",
        record_id: meetingId,
        segment_id: null,
      }).catch(() => {
        setLocalSelectedId(meetingId);
      });
    } else {
      setLocalSelectedId(meetingId);
    }
  };

  const openCompose = () => {
    if (!canCreate) return;
    setLocalSelectedId(null);
    if (canPatchRoute) {
      void patchRoute({
        section: "new",
        view: "list",
        record_id: null,
        segment_id: null,
      }).catch(() => {
        setLocalCreating(true);
      });
    } else {
      setLocalCreating(true);
    }
  };

  const returnSection: "all" | "followups" =
    activeSection === "followups" ? "followups" : "all";

  if (activeRecordId) {
    return (
      <main className="app-outlet mm-outlet" data-locale={locale}>
        <MeetingDetailPage
          scope={snapshot.scope}
          recordId={activeRecordId}
          initialRecord={records.find((r) => r.id === activeRecordId) ?? null}
          returnSection={returnSection}
          canUpdate={canUpdate}
          onBack={() => navigateSection(returnSection)}
          onRecordUpdated={(updated) => {
            setRecords((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
          }}
        />
      </main>
    );
  }

  if (isNewMeetingRoute) {
    return (
      <main className="app-outlet mm-outlet" data-locale={locale}>
        {canCreate ? (
          <NewMeetingPage
            scope={snapshot.scope}
            onBack={() => navigateSection("all")}
            onCreated={(created) => {
              setRecords((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
              setTotal((prev) => prev + 1);
              setLocalCreating(false);
              openMeeting(created.id, "all");
            }}
          />
        ) : (
          <section className="mm-page" aria-label={t("newPageTitle")}>
            <div className="mm-page-topbar">
              <button
                type="button"
                className="mm-back-link"
                onClick={() => navigateSection("all")}
              >
                <span aria-hidden="true">←</span>
                <span>{t("backToAllMeetings")}</span>
              </button>
            </div>
            <Notice state="read-only">{t("readOnlyNotice")}</Notice>
          </section>
        )}
      </main>
    );
  }

  const visibleRecords =
    statusFilter === "all"
      ? records
      : records.filter((row) => row.profile.status === statusFilter);

  const openFollowupsTotal = records.reduce(
    (sum, r) => sum + r.profile.followups.filter((f) => f.status === "open").length,
    0,
  );

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setCursorStack([null]);
    setCommittedQuery(searchInput.trim().slice(0, 120));
  };

  const resetAllFilters = () => {
    setSearchInput("");
    setCommittedQuery("");
    setStatusFilter("all");
    setCursorStack([null]);
  };

  const statusOptions = [
    { value: "all", label: t("statusAll") },
    { value: "draft", label: t("statusDraft") },
    { value: "reviewed", label: t("statusReviewed") },
    { value: "archived", label: t("statusArchived") },
  ];

  const columns: DataTableColumn<MeetingRecord>[] = [
    {
      key: "meeting",
      header: t("colMeeting"),
      cell: (row) => (
        <div className="mm-cell-primary">
          <button
            type="button"
            className="lnk mm-row-link"
            onClick={() => openMeeting(row.id, "all")}
          >
            {row.profile.title}
          </button>
          <div className="mm-cell-sub">
            {row.profile.participants.length > 0
              ? row.profile.participants.join(", ")
              : t("noParticipants")}
          </div>
          <div className="mm-mobile-meta">
            <span className="mm-cell-sub num">{formatHeldAt(row.profile.held_at, locale)}</span>
            <TitleOriginBadge source={row.profile.title_source} />
          </div>
          {row.profile.tags.length > 0 ? (
            <div className="mm-row-tags">
              {row.profile.tags.map((tag) => (
                <span key={tag} className="mm-tag-chip">
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "when",
      header: t("colWhen"),
      cell: (row) => {
        const dur = formatDuration(row.profile.duration_seconds, locale);
        return (
          <div className="mm-when-cell num">
            <div>{formatHeldAt(row.profile.held_at, locale)}</div>
            {dur ? <div className="mm-cell-sub">{dur}</div> : null}
          </div>
        );
      },
    },
    {
      key: "naming",
      header: t("colNaming"),
      cell: (row) => <TitleOriginBadge source={row.profile.title_source} />,
    },
    {
      key: "status",
      header: t("colStatus"),
      cell: (row) => {
        const openCount = row.profile.followups.filter((f) => f.status === "open").length;
        const doneCount = row.profile.followups.filter((f) => f.status === "done").length;
        return (
          <div className="mm-status-cell">
            <MeetingStatusChip status={row.profile.status} />
            <span className="mm-cell-sub num">
              {openCount > 0
                ? t("openFollowupsCount", { count: openCount })
                : doneCount > 0
                  ? t("allFollowupsDone", { count: doneCount })
                  : t("noFollowups")}
            </span>
          </div>
        );
      },
    },
  ];

  const hasFilters = committedQuery.length > 0 || statusFilter !== "all";

  return (
    <main className="app-outlet mm-outlet" data-locale={locale}>
      <header className="mm-header">
        <div className="mm-header-titles">
          <h1 className="mm-title">{t("appTitle")}</h1>
          <p className="mm-subtitle">{t("appSubtitle")}</p>
        </div>
        {canCreate ? (
          <Button variant="primary" onClick={openCompose}>
            {t("newMinutes")}
          </Button>
        ) : null}
      </header>

      {!canCreate && !canUpdate ? (
        <Notice state="read-only">{t("readOnlyNotice")}</Notice>
      ) : null}

      <nav className="app-outlet-tabs" aria-label={t("appTitle")}>
        <button
          type="button"
          className="app-outlet-tab"
          data-on={activeSection === "all" ? "" : undefined}
          aria-current={activeSection === "all" ? "page" : undefined}
          onClick={() => navigateSection("all")}
        >
          {t("sectionAll")}
        </button>
        {canCreate ? (
          <button
            type="button"
            className="app-outlet-tab"
            onClick={openCompose}
          >
            {t("sectionNew")}
          </button>
        ) : null}
        <button
          type="button"
          className="app-outlet-tab mm-tab-with-count"
          data-on={activeSection === "followups" ? "" : undefined}
          aria-current={activeSection === "followups" ? "page" : undefined}
          onClick={() => navigateSection("followups")}
        >
          <span>{t("sectionFollowups")}</span>
          {openFollowupsTotal > 0 ? (
            <span className="mm-count-pill num">{openFollowupsTotal}</span>
          ) : null}
        </button>
      </nav>

      {activeSection === "followups" ? (
        loading && records.length === 0 ? (
          <Loading>{t("loadingMeetings")}</Loading>
        ) : listError ? (
          <ErrorNotice
            onRetry={() => void loadMeetings(currentCursor, committedQuery)}
            retryLabel={t("retry")}
          >
            {listError}
          </ErrorNotice>
        ) : (
          <FollowupsSection
            scope={snapshot.scope}
            meetings={records}
            canUpdate={canUpdate}
            onSelectMeeting={(id) => openMeeting(id, "followups")}
            onMeetingUpdated={(updated) => {
              setRecords((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
            }}
          />
        )
      ) : (
        <section className="mm-list-section" aria-label={t("sectionAll")}>
          <div className="crm-toolbar mm-toolbar">
            <form className="mm-search-form" onSubmit={submitSearch}>
              <div className="mm-search-input-wrap">
                <IconSearch size={14} className="mm-search-icon" />
                <input
                  type="search"
                  className="field mm-search-input"
                  maxLength={120}
                  aria-label={t("searchLabel")}
                  placeholder={t("searchPlaceholder")}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </div>
              <Button type="submit" variant="secondary">
                {t("searchSubmit")}
              </Button>
              {committedQuery ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSearchInput("");
                    setCommittedQuery("");
                    setCursorStack([null]);
                  }}
                >
                  {t("clearSearch")}
                </Button>
              ) : null}
            </form>

            <Select
              value={statusFilter}
              options={statusOptions}
              onChange={(val) => setStatusFilter(val as "all" | MeetingStatus)}
              aria-label={t("statusFilterLabel")}
            />
          </div>

          {loading && records.length === 0 ? (
            <Loading>{t("loadingMeetings")}</Loading>
          ) : listError ? (
            <ErrorNotice
              onRetry={() => void loadMeetings(currentCursor, committedQuery)}
              retryLabel={t("retry")}
            >
              {listError}
            </ErrorNotice>
          ) : visibleRecords.length === 0 ? (
            hasFilters ? (
              <div className="mm-empty-stack">
                <EmptyState title={t("emptyFilteredTitle")} name="meetings-filtered">
                  {t("emptyFilteredBody")}
                </EmptyState>
                <div className="mm-empty-cta">
                  <Button variant="secondary" onClick={resetAllFilters}>
                    {t("resetFilters")}
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyState title={t("emptyTitle")} name="meetings">
                {t("emptyBody")}
              </EmptyState>
            )
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={visibleRecords}
                rowKey={(row) => row.id}
                label={t("tableLabel")}
                wrapClassName="mm-table-wrap"
                tableClassName="mm-table mm-meetings-table"
                rowProps={(row) => ({
                  "data-record-id": row.id,
                })}
              />
              <ListPager
                count={visibleRecords.length}
                total={statusFilter === "all" ? total : visibleRecords.length}
                hasPrev={cursorStack.length > 1}
                hasNext={nextCursor !== null}
                loading={loading}
                onPrev={() =>
                  setCursorStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
                }
                onNext={() => {
                  if (nextCursor) setCursorStack((prev) => [...prev, nextCursor]);
                }}
              />
            </>
          )}
        </section>
      )}
    </main>
  );
}

export default function MinutesScreen() {
  const snapshot = useScope();
  const locale = snapshot?.presentationLocale ?? "en";
  return (
    <NavigationProvider adapter={FrameNavigationAdapter}>
      <MinutesLocaleProvider locale={locale}>
        <MinutesScreenInner />
      </MinutesLocaleProvider>
    </NavigationProvider>
  );
}
