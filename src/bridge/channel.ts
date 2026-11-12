import { ApiError } from "@cadence/screen-ui";
import {
  createScreenReceiver,
  ScreenClosedError,
  ScreenRefusalError,
  ScreenTimeoutError,
  type ScreenBoot,
  type ScreenReceiver,
  type ScreenReceiverOptions,
  type ScreenSurfaceRole,
} from "@cadence/app-kit";
import { useSyncExternalStore } from "react";
import { acceptPush, clearScope, getScope } from "./scope";
import { OPERATIONS, SCREEN_SERVICE_ARGS_BYTES } from "./services";

export type MinutesLeaveState = {
  publish: (unsaved: boolean) => void;
  release: () => void;
};

export interface SurfaceSnapshot {
  role: ScreenSurfaceRole;
  surface: string | undefined;
  modal: boolean;
}

const MAX_PUSH_BYTES = 131072;
const MAX_DATA_BYTES = 1048576;
const SECRET_KEYS = ["confirmation_nonce", "confirmation_token", "confirm_token", "action_token"];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function exact(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((k) => keys.includes(k));
}

const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

const invalid = () =>
  new ApiError("The Meeting minutes bridge refused an invalid or retired response", 502);

function guardData(value: unknown): unknown {
  if (utf8Bytes(value) > MAX_DATA_BYTES) throw invalid();
  if (isPlainObject(value) && SECRET_KEYS.some((k) => k in value)) throw invalid();
  return value;
}

export interface StartChannelOptions {
  boot?: ScreenBoot;
  document?: ScreenReceiverOptions["document"];
  parent?: ScreenReceiverOptions["parent"];
  window?: ScreenReceiverOptions["window"];
  MessageChannel?: ScreenReceiverOptions["MessageChannel"];
  onPushOverride?: (push: Record<string, unknown>) => void;
}

export class Channel {
  private receiver: ScreenReceiver | null = null;
  private retired = false;
  private leaveOwner: symbol | null = null;
  private inFlight = 0;
  private cause: ApiError | null = null;
  private surfaceSnapshot: SurfaceSnapshot = {
    role: "primary",
    surface: undefined,
    modal: false,
  };
  private surfaceListeners = new Set<() => void>();

  start(opts: StartChannelOptions = {}): void {
    if (this.receiver || this.retired) return;
    let bootInput: unknown = opts.boot;
    if (!bootInput) {
      const doc = opts.document ?? document;
      const node = doc?.getElementById("cadence-screen-boot") ?? null;
      if (!node?.textContent || node.textContent.length > 2048) throw invalid();
      bootInput = JSON.parse(node.textContent);
    }
    if (
      !isPlainObject(bootInput) ||
      !exact(bootInput, ["tag", "bridge_nonce", "generation", "parent_origin"]) ||
      bootInput.tag !== "minutes" ||
      typeof bootInput.bridge_nonce !== "string" ||
      !/^[a-f0-9]{64}$/.test(bootInput.bridge_nonce) ||
      !Number.isSafeInteger(bootInput.generation) ||
      (bootInput.generation as number) < 0 ||
      typeof bootInput.parent_origin !== "string"
    ) {
      throw invalid();
    }
    const origin = new URL(bootInput.parent_origin);
    if (origin.origin !== bootInput.parent_origin || !["http:", "https:"].includes(origin.protocol)) {
      throw invalid();
    }
    if (!opts.parent && typeof window !== "undefined" && window.parent === window) {
      throw invalid();
    }

    const receiver = createScreenReceiver({
      boot: bootInput as unknown as ScreenBoot,
      accepts: ["screen.v2", "screen-records.v1", "screen-surfaces.v1", "crm-locale.v1"],
      timeoutMs: 65000,
      maxArgsBytes: SCREEN_SERVICE_ARGS_BYTES,
      ...(opts.document ? { document: opts.document } : {}),
      ...(opts.parent ? { parent: opts.parent } : {}),
      ...(opts.window ? { window: opts.window } : {}),
      ...(opts.MessageChannel ? { MessageChannel: opts.MessageChannel } : {}),
      onSurface: (role, surface, modal) => {
        this.surfaceSnapshot = { role, surface, modal };
        this.surfaceListeners.forEach((listener) => listener());
      },
      onPush: (push) => {
        if (utf8Bytes(push) > MAX_PUSH_BYTES) throw invalid();
        if (opts.onPushOverride) {
          opts.onPushOverride(push);
        } else {
          acceptPush(push);
        }
      },
      onError: (reason) => {
        this.retire(new ApiError(reason, 502));
      },
    });
    if (!receiver.boot || receiver.boot.tag !== "minutes") {
      receiver.teardown();
      throw invalid();
    }
    this.receiver = receiver;
  }

  subscribeSurface = (listener: () => void): (() => void) => {
    this.surfaceListeners.add(listener);
    return () => {
      this.surfaceListeners.delete(listener);
    };
  };

  getSurface = (): SurfaceSnapshot => this.surfaceSnapshot;

  surfaceRole(): ScreenSurfaceRole {
    return this.receiver?.surfaceRole() ?? this.surfaceSnapshot.role;
  }

  surfaceName(): string | undefined {
    return this.receiver?.surface() ?? this.surfaceSnapshot.surface;
  }

  openDrawer(surface: string, options?: { size?: "narrow" | "wide" }): Promise<unknown> {
    if (!this.receiver || this.retired) {
      return Promise.reject(new ApiError("Meeting minutes bridge is unavailable", 503));
    }
    return this.receiver.openDrawer(surface, options).catch((error) => {
      throw this.mapError(error);
    });
  }

  closeDrawer(): Promise<unknown> {
    if (!this.receiver || this.retired) {
      return Promise.reject(new ApiError("Meeting minutes bridge is unavailable", 503));
    }
    return this.receiver.closeDrawer().catch((error) => {
      throw this.mapError(error);
    });
  }

  ownMinutesLeaveState(): MinutesLeaveState | null {
    const receiver = this.receiver;
    const scope = getScope();
    if (!receiver?.accepted() || this.retired || !scope) return null;
    const owner = Symbol();
    this.leaveOwner = owner;
    const live = () => {
      const current = getScope();
      return (
        !this.retired &&
        this.receiver === receiver &&
        this.leaveOwner === owner &&
        !!current &&
        current.scope.installId === scope.scope.installId &&
        current.digest === scope.digest
      );
    };
    const publish = (unsaved: boolean) => {
      if (typeof unsaved !== "boolean" || !live()) return;
      receiver.state(JSON.stringify({ contract: "crm-leave.v1", unsaved }));
    };
    return {
      publish,
      release: () => {
        if (live()) {
          publish(false);
          this.leaveOwner = null;
        }
      },
    };
  }

  request(verb: string, args: Record<string, unknown>): Promise<unknown> {
    const receiver = this.receiver;
    if (!receiver || this.retired) {
      return Promise.reject(new ApiError("Meeting minutes bridge is unavailable", 503));
    }
    if (this.inFlight >= 8) {
      return Promise.reject(
        new ApiError("Meeting minutes bridge is busy; wait for the current request", 429),
      );
    }
    this.inFlight += 1;
    const settle = () => {
      this.inFlight -= 1;
    };
    return receiver.call(verb, args).then(
      (value) => {
        settle();
        try {
          return guardData(value);
        } catch (error) {
          const mapped = this.mapError(error);
          this.retire(mapped);
          throw mapped;
        }
      },
      (error) => {
        settle();
        const mapped = this.mapError(error);
        if ([401, 403, 504, 502].includes(mapped.status)) this.retire(mapped);
        return Promise.reject(mapped);
      },
    );
  }

  private mapError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (error instanceof ScreenRefusalError) {
      return new ApiError(error.text || error.code, error.status, { code: error.code });
    }
    if (error instanceof ScreenTimeoutError) {
      return new ApiError(
        "Meeting minutes request did not answer. Inspect fresh status before retrying.",
        504,
      );
    }
    if (error instanceof ScreenClosedError) {
      return this.cause ?? new ApiError("Meeting minutes bridge is unavailable", 503);
    }
    return invalid();
  }

  retire(error: ApiError): void {
    if (this.retired) return;
    this.retired = true;
    this.leaveOwner = null;
    this.cause = error;
    this.receiver?.teardown();
    this.receiver = null;
    clearScope(error.message);
  }

  resetForTests(): void {
    this.receiver?.teardown();
    this.receiver = null;
    this.retired = false;
    this.leaveOwner = null;
    this.inFlight = 0;
    this.cause = null;
    this.surfaceSnapshot = { role: "primary", surface: undefined, modal: false };
    this.surfaceListeners.forEach((listener) => listener());
  }
}

export const createChannel = (): Channel => new Channel();
export const channel = createChannel();

export function useSurface(): SurfaceSnapshot {
  return useSyncExternalStore(channel.subscribeSurface, channel.getSurface);
}

export function admitted(verb: string, actions: readonly string[]): boolean {
  return OPERATIONS.includes(verb) && actions.includes(verb);
}
