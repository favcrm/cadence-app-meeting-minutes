import { ApiError } from "@cadence/screen-ui";
import { useSyncExternalStore } from "react";
import { admitted, exact } from "./channel";
import { CALL_FIELDS, OPERATIONS } from "./services";

export type MinutesLocale = "en" | "zh-HK";
export interface DisplayScope {
  installId: string;
  digest: string;
}
export interface Route {
  section: "all" | "followups";
  view: "list" | "new";
  record_id: string | null;
  segment_id: string | null;
}
export interface ReadObservation {
  operation: string;
  args: Record<string, unknown>;
  data: unknown;
}
export interface ScopeSnapshot {
  presentationLocale: MinutesLocale;
  scope: DisplayScope;
  digest: string;
  contextId: string;
  actions: string[];
  route: Route;
  observations: ReadObservation[];
}

let snapshot: ScopeSnapshot | null = null;
let error: string | null = null;
const listeners = new Set<() => void>();
const retireListeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export const subscribeScope = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
export const getScope = () => snapshot;
export function useScope() {
  return useSyncExternalStore(subscribeScope, getScope);
}
export function scopeError() {
  return error;
}
export function useScopeError(): string | null {
  return useSyncExternalStore(subscribeScope, scopeError);
}
export function onScopeRetired(f: () => void) {
  retireListeners.add(f);
  return () => {
    retireListeners.delete(f);
  };
}
export function clearScope(reason: string): void {
  snapshot = null;
  error = reason;
  retireListeners.forEach((f) => f());
  notify();
}
export function resetScopeForTests(): void {
  snapshot = null;
  error = null;
  notify();
}

const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const contextToken = (v: unknown): boolean =>
  v === undefined || v === "" || (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/.test(v));
const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);

function invalid(): never {
  throw new ApiError("Invalid Meeting minutes scope projection", 502);
}

export function parseRoute(v: unknown): Route {
  if (v === undefined || v === null) {
    return { section: "all", view: "list", record_id: null, segment_id: null };
  }
  if (
    !obj(v) ||
    !exact(v, ["section", "view", "record_id", "segment_id"]) ||
    !["all", "followups"].includes(v.section as string) ||
    !["list", "new"].includes(v.view as string) ||
    (v.record_id !== null && !id(v.record_id)) ||
    (v.segment_id !== null && !id(v.segment_id))
  ) {
    invalid();
  }
  return v as unknown as Route;
}

const PUSH_KEYS = [
  "v",
  "op",
  "install_id",
  "context_id",
  "digest",
  "tag",
  "installation",
  "contexts",
  "runs",
  "outbox",
  "publish_intents",
  "sources",
  "defaults",
  "readiness",
  "actions",
  "now",
  "resume",
  "route",
  "read_observations",
  "presentation_locale",
] as const;

/**
 * Host-local presentation verbs (`CAD-1777` / `SOC-55`) advertised alongside
 * records operations when `screen-surfaces.v1` is negotiated.
 */
export const HOST_SURFACE_ACTIONS = [
  "screen.drawer.open",
  "screen.drawer.close",
  "screen.drawer.context",
] as const;

const ADMITTED_PUSH_ACTIONS: readonly string[] = [...OPERATIONS, ...HOST_SURFACE_ACTIONS];

export function acceptPush(p: Record<string, unknown>): void {
  if (
    !exact(p, PUSH_KEYS) ||
    p.tag !== "minutes" ||
    !id(p.install_id) ||
    !contextToken(p.context_id) ||
    !digest(p.digest) ||
    !Array.isArray(p.actions) ||
    !p.actions.every((a) => typeof a === "string" && ADMITTED_PUSH_ACTIONS.includes(a)) ||
    new Set(p.actions).size !== p.actions.length
  ) {
    invalid();
  }
  if (
    "presentation_locale" in p &&
    p.presentation_locale !== undefined &&
    p.presentation_locale !== "en" &&
    p.presentation_locale !== "zh-TW" &&
    p.presentation_locale !== "zh-HK"
  ) {
    invalid();
  }
  if (
    !obj(p.installation) ||
    !exact(p.installation, ["install_id", "name", "title", "version", "digest", "summary"]) ||
    p.installation.install_id !== p.install_id ||
    p.installation.digest !== p.digest ||
    p.installation.name !== "meeting-minutes" ||
    !["title", "version", "summary"].every(
      (k) => typeof (p.installation as Record<string, unknown>)[k] === "string",
    ) ||
    ("contexts" in p &&
      p.contexts !== undefined &&
      (!Array.isArray(p.contexts) ||
        !p.contexts.every(
          (c) => obj(c) && exact(c, ["id", "label"]) && id(c.id) && typeof c.label === "string",
        )))
  ) {
    invalid();
  }
  if (snapshot && (snapshot.scope.installId !== p.install_id || snapshot.digest !== p.digest)) {
    invalid();
  }
  const actions = p.actions as string[];
  const observations: ReadObservation[] = [];
  if (p.read_observations !== undefined) {
    if (!Array.isArray(p.read_observations) || p.read_observations.length > 16) invalid();
    for (const row of p.read_observations) {
      if (
        !obj(row) ||
        !exact(row, ["operation", "args", "data"]) ||
        typeof row.operation !== "string" ||
        !["records.list", "records.show"].includes(row.operation) ||
        !admitted(row.operation, actions) ||
        !obj(row.args) ||
        !exact(row.args, CALL_FIELDS[row.operation as keyof typeof CALL_FIELDS]) ||
        new TextEncoder().encode(JSON.stringify(row)).length > 65536
      ) {
        invalid();
      }
      observations.push(row as unknown as ReadObservation);
    }
  }
  const presentationLocale: MinutesLocale =
    p.presentation_locale === "zh-TW" || p.presentation_locale === "zh-HK" ? "zh-HK" : "en";
  snapshot = {
    presentationLocale,
    scope: { installId: p.install_id as string, digest: p.digest as string },
    digest: p.digest as string,
    contextId: typeof p.context_id === "string" ? p.context_id : "",
    actions,
    route: parseRoute(p.route),
    observations,
  };
  error = null;
  notify();
}

export function assertCurrentScope(scope: DisplayScope): void {
  if (
    !snapshot ||
    scope.installId !== snapshot.scope.installId ||
    scope.digest !== snapshot.scope.digest
  ) {
    throw new ApiError("Meeting minutes scope is absent or retired", 403);
  }
}

export function requireOperation(verb: string): void {
  if (!snapshot || !admitted(verb, snapshot.actions)) {
    throw new ApiError("This workspace doesn't offer that action.", 403);
  }
}
