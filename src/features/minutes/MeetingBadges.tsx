import { useMinutesText } from "./i18n";
import type { MeetingStatus } from "./types";

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
