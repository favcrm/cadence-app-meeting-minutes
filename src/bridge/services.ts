import { ApiError } from "@cadence/screen-ui";
import { channel } from "./channel";
import type { DisplayScope } from "./scope";

type Bag = Record<string, unknown>;

/** Hosted screen service call args byte ceiling (`screen-services.ts`). */
export const SCREEN_SERVICE_ARGS_BYTES = 16 * 1024;

export interface CallArgs {
  "records.list": { query?: string; limit?: number; cursor?: string };
  "records.show": { record_id: string };
  "records.create": { record_id: string; profile: unknown; consent_provenance?: unknown };
  "records.update": {
    record_id: string;
    expected_revision: number;
    profile: unknown;
    consent_provenance?: unknown;
  };
  "screen.route.patch": {
    section?: "all" | "new" | "followups";
    view?: "list" | "new";
    record_id?: string | null;
    segment_id?: string | null;
    replace?: boolean;
  };
}

// Closed field allowlist checked at runtime before serialization and parsed statically by screen_inputs.mjs.
export const CALL_FIELDS: Record<keyof CallArgs, readonly string[]> = {
  "records.list": ["query", "limit", "cursor"],
  "records.show": ["record_id"],
  "records.create": ["record_id", "profile", "consent_provenance"],
  "records.update": ["record_id", "expected_revision", "profile", "consent_provenance"],
  "screen.route.patch": ["section", "view", "record_id", "segment_id", "replace"],
};
export const OPERATIONS = [...Object.keys(CALL_FIELDS)];

export function measureArgsBytes(args: Bag): number {
  const cleaned = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  return new TextEncoder().encode(JSON.stringify(cleaned)).length;
}

export function cleanArgs(verb: string, args: Bag): Bag {
  const fields = CALL_FIELDS[verb as keyof CallArgs] as readonly string[] | undefined;
  if (!fields || !args || typeof args !== "object" || Array.isArray(args)) {
    throw new ApiError("Unlisted Meeting minutes operation", 400);
  }
  for (const key of Object.keys(args)) {
    if (!fields.includes(key)) {
      throw new ApiError(`Refused Meeting minutes field: ${key}`, 400);
    }
  }
  const value = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  if (new TextEncoder().encode(JSON.stringify(value)).length > SCREEN_SERVICE_ARGS_BYTES) {
    throw new ApiError("Meeting minutes request exceeds its 16 KiB wire budget", 413);
  }
  return value;
}

export const onWrite = (f: () => void) => channel.onWrite(f);

export async function serviceCall<T = unknown, K extends keyof CallArgs = keyof CallArgs>(
  scope: DisplayScope,
  verb: K,
  args: CallArgs[K],
): Promise<T> {
  return channel.call<T, K>(scope, verb, args);
}
