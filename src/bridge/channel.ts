import { ApiError } from "@cadence/screen-ui";
import {
  createScreenBridge,
  type ScreenAudioCapture,
  type ScreenAudioCaptureOptions,
  type ScreenBridge,
  type ScreenBridgeRuntimeOverrides,
  type ScreenSurfaceRole,
  type ScreenSurfaceSnapshot,
} from "@cadence/app-kit";
import { useSyncExternalStore } from "react";
import { CALL_FIELDS, OPERATIONS, SCREEN_SERVICE_ARGS_BYTES, type CallArgs } from "./services";
import type { DisplayScope } from "./scope";

export type MinutesSection = "all" | "followups";
export type MinutesView = "list" | "new";

export type MinutesLeaveState = {
  publish: (unsaved: boolean) => void;
  release: () => void;
};

export interface SurfaceSnapshot {
  role: ScreenSurfaceRole;
  surface: string | undefined;
  modal: boolean;
}

export type StartChannelOptions = ScreenBridgeRuntimeOverrides;

function createMinutesBridge(): ScreenBridge<MinutesSection, MinutesView, ApiError> {
  return createScreenBridge<MinutesSection, MinutesView, ApiError>({
    tag: "minutes",
    appName: "meeting-minutes",
    records: true,
    surfaces: true,
    locale: true,
    audio: true,
    calls: CALL_FIELDS,
    argBytes: SCREEN_SERVICE_ARGS_BYTES,
    writeVerbs: ["records.create", "records.update"],
    route: {
      sections: ["all", "followups"],
      defaultSection: "all",
      views: ["list", "new"],
    },
    observations: ["records.list", "records.show"],
    maxInFlight: 8,
    timeoutMs: 65000,
    createError: (message, status, options) => new ApiError(message, status, options),
  });
}

export class Channel {
  private instance: ScreenBridge<MinutesSection, MinutesView, ApiError> | null = null;
  private cachedRawSurface: ScreenSurfaceSnapshot | null = null;
  private cachedSurface: SurfaceSnapshot = {
    role: "primary",
    surface: undefined,
    modal: false,
  };

  get bridge(): ScreenBridge<MinutesSection, MinutesView, ApiError> {
    if (!this.instance) {
      this.instance = createMinutesBridge();
    }
    return this.instance;
  }

  start(opts: StartChannelOptions = {}): void {
    this.bridge.start(opts);
    const state = this.bridge.getState();
    if (state.status === "error" && state.error) {
      throw state.error;
    }
  }

  subscribe = (listener: () => void): (() => void) => this.bridge.subscribe(listener);

  subscribeSurface = (listener: () => void): (() => void) => this.bridge.subscribe(listener);

  getSurface = (): SurfaceSnapshot => {
    const raw = this.bridge.getState().surface;
    if (raw !== this.cachedRawSurface) {
      this.cachedRawSurface = raw;
      this.cachedSurface = {
        role: raw.role,
        surface: raw.name,
        modal: raw.modal,
      };
    }
    return this.cachedSurface;
  };

  surfaceRole(): ScreenSurfaceRole {
    return this.getSurface().role;
  }

  surfaceName(): string | undefined {
    return this.getSurface().surface;
  }

  openDrawer(
    surface: string,
    options?: { size?: "narrow" | "wide"; context?: unknown },
  ): Promise<unknown> {
    return this.bridge.openDrawer(surface, options);
  }

  closeDrawer(): Promise<unknown> {
    return this.bridge.closeDrawer();
  }

  drawerContext<T = unknown>(): Promise<T | null> {
    return this.bridge.drawerContext<T>();
  }

  ownMinutesLeaveState(): MinutesLeaveState | null {
    return this.bridge.ownLeaveState();
  }

  canAudioCapture = (): boolean => this.bridge.canAudioCapture();

  audioCapture(
    scope: DisplayScope,
    options?: ScreenAudioCaptureOptions,
  ): Promise<ScreenAudioCapture> {
    return this.bridge.audioCapture(scope, options);
  }

  call<T = unknown, K extends keyof CallArgs = keyof CallArgs>(
    scope: DisplayScope,
    verb: K,
    args: CallArgs[K],
  ): Promise<T> {
    return this.bridge.call<T>(scope, verb, args as Record<string, unknown>);
  }

  request(verb: string, args: Record<string, unknown>): Promise<unknown> {
    const snap = this.bridge.getSnapshot();
    if (!snap) {
      const err = this.bridge.getState().error;
      return Promise.reject(err ?? new ApiError("Meeting minutes bridge is unavailable", 503));
    }
    return this.bridge.call(snap.scope, verb, args);
  }

  onWrite = (listener: () => void): (() => void) => this.bridge.onWrite(listener);

  retire(error: ApiError | string): void {
    this.bridge.retire(error);
  }

  resetForTests(): void {
    this.bridge.reset();
    this.cachedRawSurface = null;
    this.cachedSurface = { role: "primary", surface: undefined, modal: false };
  }
}

export const createChannel = (): Channel => new Channel();
export const channel = createChannel();

export function useSurface(): SurfaceSnapshot {
  return useSyncExternalStore(channel.subscribeSurface, channel.getSurface);
}

export function useCanAudioCapture(): boolean {
  return useSyncExternalStore(channel.subscribe, channel.canAudioCapture);
}

export function admitted(verb: string, actions: readonly string[]): boolean {
  return OPERATIONS.includes(verb) && actions.includes(verb);
}
