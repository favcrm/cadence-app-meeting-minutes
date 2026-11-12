import { ApiError } from "@cadence/screen-ui";
import type { ScreenScopeSnapshot } from "@cadence/app-kit";
import { useSyncExternalStore } from "react";
import { admitted, channel, type MinutesSection, type MinutesView } from "./channel";

export type MinutesLocale = "en" | "zh-HK";

export interface DisplayScope {
  installId: string;
  digest: string;
  contextId?: string;
}

export interface Route {
  section: MinutesSection;
  view: MinutesView;
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

let cachedBridgeSnap: ScreenScopeSnapshot<MinutesSection, MinutesView> | null = null;
let cachedScopeSnap: ScopeSnapshot | null = null;

function mapSnapshot(
  raw: ScreenScopeSnapshot<MinutesSection, MinutesView> | null,
): ScopeSnapshot | null {
  if (!raw) {
    cachedBridgeSnap = null;
    cachedScopeSnap = null;
    return null;
  }
  if (raw === cachedBridgeSnap && cachedScopeSnap) {
    return cachedScopeSnap;
  }
  const route: Route = raw.route ?? {
    section: "all",
    view: "list",
    record_id: null,
    segment_id: null,
  };
  cachedBridgeSnap = raw;
  cachedScopeSnap = {
    presentationLocale: raw.presentationLocale === "zh-TW" ? "zh-HK" : "en",
    scope: {
      installId: raw.scope.installId,
      digest: raw.scope.digest,
      contextId: raw.scope.contextId,
    },
    digest: raw.digest,
    contextId: raw.scope.contextId,
    actions: [...raw.actions],
    route,
    observations: raw.observations.map((row) => ({
      operation: row.operation,
      args: row.args,
      data: row.data,
    })),
  };
  return cachedScopeSnap;
}

export const subscribeScope = (f: () => void) => channel.subscribe(f);
export const getScope = (): ScopeSnapshot | null => mapSnapshot(channel.bridge.getSnapshot());

export function useScope(): ScopeSnapshot | null {
  return useSyncExternalStore(subscribeScope, getScope);
}

export function scopeError(): string | null {
  return channel.bridge.getState().error?.message ?? null;
}

export function useScopeError(): string | null {
  return useSyncExternalStore(subscribeScope, scopeError);
}

export function clearScope(reason: string): void {
  channel.retire(new ApiError(reason, 502));
}

export function resetScopeForTests(): void {
  cachedBridgeSnap = null;
  cachedScopeSnap = null;
  channel.resetForTests();
}

export function assertCurrentScope(scope: DisplayScope): void {
  channel.bridge.assertScope(scope);
}

export function requireOperation(verb: string): void {
  const s = getScope();
  if (!s || !admitted(verb, s.actions)) {
    throw new ApiError("This workspace doesn't offer that action.", 403);
  }
}
