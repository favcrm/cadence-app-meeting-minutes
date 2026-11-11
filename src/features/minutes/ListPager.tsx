import { Button } from "@cadence/screen-ui";
import { useMinutesText } from "./i18n";

export default function ListPager({
  count,
  total,
  hasPrev,
  hasNext,
  loading,
  onPrev,
  onNext,
}: {
  count: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useMinutesText();
  if (total <= 0) return null;
  return (
    <div className="mm-pager" role="navigation" aria-label="Pagination">
      <span className="mm-pager-summary num">{t("pagerRange", { count, total })}</span>
      {hasPrev || hasNext ? (
        <div className="mm-pager-controls">
          <Button size="sm" variant="secondary" disabled={!hasPrev || loading} onClick={onPrev}>
            {t("pagerPrev")}
          </Button>
          <Button size="sm" variant="secondary" disabled={!hasNext || loading} onClick={onNext}>
            {t("pagerNext")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
