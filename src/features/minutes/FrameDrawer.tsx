import { Button, DrawerShell, type DrawerShellProps } from "@cadence/screen-ui";
import { useEffect, useRef, type ReactNode } from "react";
import { useMinutesText } from "./i18n";

const FOCUSABLE =
  'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]';

/**
 * Primary-mount drawer wrapper over `@cadence/screen-ui` DrawerShell (`geometry={{ left: 0 }}`).
 * Locks background scroll and traps Tab focus within the drawer.
 */
export default function FrameDrawer(props: Omit<DrawerShellProps, "geometry" | "scrim">) {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const trap = (event: KeyboardEvent) => {
      const panel = layer.current?.querySelector<HTMLElement>(".crm-drawer-shell");
      if (event.key !== "Tab" || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = nodes[0];
      const last = nodes.at(-1);
      const active = document.activeElement;
      const atStart =
        active === first ||
        active === panel.querySelector(".crm-drawer-title") ||
        !panel.contains(active);
      if (event.shiftKey && atStart) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, []);

  return (
    <div className="mm-frame-drawer" ref={layer}>
      <DrawerShell {...props} geometry={{ left: 0 }} />
    </div>
  );
}

/**
 * Single-chrome surface used when the host mounts this frame directly as a
 * `surfaceRole === "drawer"` panel (`screen-surfaces.v1`), avoiding a nested
 * scrim or second fixed overlay.
 */
export function HostedDrawerSurface({
  title,
  subtitle,
  pills,
  tabs,
  activeTab,
  onTab,
  footer,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  pills?: ReactNode;
  tabs?: { id: string; label: string }[];
  activeTab?: string;
  onTab?: (id: string) => void;
  footer?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
}) {
  const { t } = useMinutesText();
  return (
    <section className="mm-hosted-drawer" aria-label={title}>
      <header className="mm-hosted-drawer-head">
        <div className="mm-hosted-drawer-titles">
          <h1 className="crm-drawer-title">{title}</h1>
          {subtitle ? <div className="crm-drawer-sub">{subtitle}</div> : null}
          {pills ? <div className="crm-drawer-pills">{pills}</div> : null}
        </div>
        {onClose ? (
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("closeAction")}
          </Button>
        ) : null}
      </header>
      {tabs && tabs.length > 0 && onTab ? (
        <div className="crm-drawer-tabs mm-hosted-drawer-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="crm-drawer-tab"
              aria-selected={activeTab === tab.id}
              onClick={() => onTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mm-hosted-drawer-body">{children}</div>
      {footer ? <footer className="mm-hosted-drawer-foot">{footer}</footer> : null}
    </section>
  );
}
