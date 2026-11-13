import { ApiError } from "@cadence/screen-ui";
import {
  createScreenBridge,
  type ScreenAudioSessionCommand,
  type ScreenAudioSessionSnapshot,
  type ScreenBridge,
  type ScreenBridgeRuntimeOverrides,
} from "@cadence/app-kit";
import { useSyncExternalStore } from "react";
import { CALL_FIELDS, OPERATIONS, SCREEN_SERVICE_ARGS_BYTES, type CallArgs } from "./services";
import type { DisplayScope } from "./scope";

export type MinutesSection = "all" | "new" | "followups";
export type MinutesView = "list" | "new";

export type MinutesLeaveState = {
  publish: (unsaved: boolean) => void;
  release: () => void;
};

export type StartChannelOptions = ScreenBridgeRuntimeOverrides;

function createMinutesBridge(): ScreenBridge<MinutesSection, MinutesView, ApiError> {
  return createScreenBridge<MinutesSection, MinutesView, ApiError>({
    tag: "minutes",
    appName: "meeting-minutes",
    records: true,
    surfaces: false,
    locale: true,
    audio: "v2",
    calls: CALL_FIELDS,
    argBytes: SCREEN_SERVICE_ARGS_BYTES,
    writeVerbs: ["records.create", "records.update"],
    route: {
      sections: ["all", "new", "followups"],
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
  private latestAudioSession: ScreenAudioSessionSnapshot | null = null;
  private audioListeners = new Set<() => void>();
  private unsubBridgeAudio: (() => void) | null = null;

  get bridge(): ScreenBridge<MinutesSection, MinutesView, ApiError> {
    if (!this.instance) {
      const bridge = createMinutesBridge();
      this.instance = bridge;
      this.unsubBridgeAudio = bridge.onAudioSession((snapshot) => {
        this.latestAudioSession = snapshot;
        for (const listener of this.audioListeners) listener();
      });
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

  subscribeAudioSession = (listener: () => void): (() => void) => {
    void this.bridge;
    this.audioListeners.add(listener);
    return () => {
      this.audioListeners.delete(listener);
    };
  };

  getAudioSession = (): ScreenAudioSessionSnapshot | null => this.latestAudioSession;

  ownMinutesLeaveState(): MinutesLeaveState | null {
    return this.bridge.ownLeaveState();
  }

  canAudioCapture = (): boolean => this.bridge.canAudioCapture();

  async audioSession(
    scope: DisplayScope,
    command: ScreenAudioSessionCommand,
  ): Promise<ScreenAudioSessionSnapshot> {
    const snapshot = await this.bridge.audioSession(scope, command);
    this.latestAudioSession = snapshot;
    for (const listener of this.audioListeners) listener();
    return snapshot;
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
    this.unsubBridgeAudio?.();
    this.unsubBridgeAudio = null;
    this.bridge.reset();
    this.instance = null;
    this.latestAudioSession = null;
    for (const listener of this.audioListeners) listener();
  }
}

export const createChannel = (): Channel => new Channel();
export const channel = createChannel();

export function useCanAudioCapture(): boolean {
  return useSyncExternalStore(channel.subscribe, channel.canAudioCapture);
}

export function useAudioSession(): ScreenAudioSessionSnapshot | null {
  return useSyncExternalStore(channel.subscribeAudioSession, channel.getAudioSession);
}

export function admitted(verb: string, actions: readonly string[]): boolean {
  return OPERATIONS.includes(verb) && actions.includes(verb);
}
