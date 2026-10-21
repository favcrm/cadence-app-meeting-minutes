/**
 * App-owned `app-screens/v2` receiver — the child side of the private
 * MessagePort bridge. Written against the wire shape the host documents
 * (cadence `ui/src/features/workspace-apps/screen/screenProtocol.ts` and the
 * Social Content reference receiver):
 *
 *   bootstrap JSON in `#cadence-screen-boot`:
 *     { tag, bridge_nonce, generation, parent_origin }
 *
 *   child -> host init (the ONLY window message; port2 transferred):
 *     parent.postMessage({ v:1, op:"init", tag, bridge_nonce, generation },
 *                        boot.parent_origin, [channel.port2])
 *
 *   host -> child PUSH:
 *     { v:2, op:"screen", install_id, digest, tag, context_id?,
 *       installation:{install_id,name,title,version,digest,summary},
 *       contexts?:[{id,label}], runs:[…], outbox:[…], now, resume? }
 *
 * The workspace is one scope (install + digest). `context_id` and `contexts`
 * are optional legacy fields: absent, `""` with `[]`, or a real id are all
 * accepted and ignored; a malformed non-empty id is refused.
 *
 *   child -> host (port1), only:
 *     { v:1, op:"ready" }  |  { v:1, op:"state", data: <=32 KiB }
 *
 * There is no pull RPC: every mutating operation lives in the host, never
 * here. Fields this receiver does not consume are ignored, never guessed at;
 * fields it does consume are validated, and a malformed projection leaves the
 * previous snapshot in place rather than rendering invented content.
 */

const MAX_STATE_BYTES = 32 * 1024;
const MAX_ROWS = 2000;
const MAX_TEXT = 65536;
const S_ID = 128;
const S_TITLE = 512;
const S_PHASE = 64;
const S_EXCERPT = 4096;
const S_RATIONALE = 8192;
const CONTEXT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{64}$/;
const BOOT_KEYS = ["tag", "bridge_nonce", "generation", "parent_origin"];

/** Diagnosis only: the last channel message this receiver saw. Never rendered. */
export const channelDebug = { count: 0, op: null, error: null, sample: null };

const str = (value, max) => typeof value === "string" && value.length <= max;
const epoch = (value) => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const row = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function byteLen(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length * 3;
  }
}

/** The bootstrap is a closed shape: an unexpected key refuses the mount. */
export function validBoot(raw) {
  if (!row(raw)) throw new Error("screen bootstrap is not an object");
  for (const key of Object.keys(raw)) {
    if (!BOOT_KEYS.includes(key)) throw new Error(`unexpected bootstrap key: ${key}`);
  }
  if (!str(raw.tag, 64) || !raw.tag) throw new Error("bootstrap tag missing");
  if (!str(raw.bridge_nonce, 64) || !NONCE.test(raw.bridge_nonce)) throw new Error("bootstrap bridge_nonce is not a 256-bit hex nonce");
  if (!Number.isInteger(raw.generation) || raw.generation < 0) throw new Error("bootstrap generation is not an integer");
  if (!str(raw.parent_origin, 256) || !/^https?:\/\//.test(raw.parent_origin)) throw new Error("bootstrap parent_origin is not an origin");
  return raw;
}

/** Read and validate the bootstrap element the frame document carries. */
export function readBoot(doc = document) {
  const el = doc.getElementById("cadence-screen-boot");
  if (!el) throw new Error("no #cadence-screen-boot in this frame");
  return validBoot(JSON.parse(el.textContent || ""));
}

/** One meeting, as the host states it. Anything the host omits stays absent. */
function meeting(value) {
  if (!row(value) || !str(value.id, S_ID) || !value.id) return null;
  const out = {
    id: value.id,
    state: str(value.state, S_PHASE) ? value.state : "",
    title: str(value.title, S_TITLE) ? value.title : "",
    snapshotDigest: str(value.snapshot_digest, S_ID) && DIGEST.test(value.snapshot_digest) ? value.snapshot_digest : null,
    workflowTitle: row(value.workflow) && str(value.workflow.title, S_TITLE) ? value.workflow.title : null,
  };
  if (epoch(value.created)) out.created = value.created;
  if (epoch(value.closed)) out.closed = value.closed;
  // screen.v2 progress and material — omitted, never fabricated.
  const phase = str(value.phase, S_PHASE) ? value.phase : null;
  if (phase) out.phase = phase;
  if (str(value.caption_excerpt, S_EXCERPT) && value.caption_excerpt) out.excerpt = value.caption_excerpt;
  if (str(value.artifact_id, S_ID) && value.artifact_id) out.artifactId = value.artifact_id;
  if (row(value.review)) {
    out.review = {
      decision: str(value.review.decision, S_PHASE) ? value.review.decision : "",
      rationale: str(value.review.rationale, S_RATIONALE) ? value.review.rationale : "",
    };
  }
  if (row(value.approved)) {
    out.approved = {
      by: str(value.approved.by_display, S_TITLE) ? value.approved.by_display : "",
      at: epoch(value.approved.at) && value.approved.at !== undefined ? value.approved.at : null,
    };
  }
  if (row(value.refusal)) {
    out.refusal = {
      code: str(value.refusal.code, S_PHASE) ? value.refusal.code : "",
      text: str(value.refusal.text, S_RATIONALE) ? value.refusal.text : "",
    };
  }
  return out;
}

/** Validate one host PUSH into the shape the UI renders. Throws on a
 *  malformed envelope so the caller keeps the previous snapshot. */
export function readPush(message) {
  if (!row(message) || message.op !== "screen") throw new Error("not a screen push");
  if (message.v !== 1 && message.v !== 2) throw new Error(`unsupported projection version: ${String(message.v)}`);
  if (!str(message.install_id, S_ID) || !message.install_id) throw new Error("push has no install_id");
  const installation = row(message.installation) ? message.installation : {};
  const runs = Array.isArray(message.runs) ? message.runs : [];
  if (runs.length > MAX_ROWS) throw new Error("projection carries more runs than the bound");
  // Context is no longer a scope dimension. Absent / "" is the one-workspace
  // shape; a real id from an older host is tolerated; anything else is refused.
  if (message.context_id !== undefined && message.context_id !== "" && !(typeof message.context_id === "string" && CONTEXT_ID.test(message.context_id))) {
    throw new Error("push carries a malformed context_id");
  }
  return {
    v: message.v,
    installId: message.install_id,
    digest: str(message.digest, S_ID) ? message.digest : null,
    tag: str(message.tag, 64) ? message.tag : null,
    installation: {
      title: str(installation.title, S_TITLE) ? installation.title : "",
      name: str(installation.name, S_ID) ? installation.name : "",
      version: str(installation.version, S_PHASE) ? installation.version : "",
      summary: str(installation.summary, MAX_TEXT) ? installation.summary : "",
    },
    meetings: runs.map(meeting).filter((entry) => entry !== null),
  };
}

/**
 * Wire the receiver: read the bootstrap, open the channel, send `init`, then
 * feed every push to `onProjection`. Returns a sender for the child's own UI
 * state — the only other message a child may send.
 */
export function createReceiver(onProjection, doc = document) {
  const boot = readBoot(doc);
  const channel = new MessageChannel();
  const state = { ready: false, sent: null };

  channel.port1.onmessage = (event) => {
    channelDebug.count += 1;
    channelDebug.op = row(event.data) ? String(event.data.op) : typeof event.data;
    try {
      onProjection(readPush(event.data));
      channelDebug.error = null;
    } catch (error) {
      // A malformed or unknown push never becomes rendered content — but it is
      // recorded here, so a silent drop is diagnosable instead of invisible.
      channelDebug.error = String((error && error.message) || error);
      try { channelDebug.sample = JSON.stringify(event.data).slice(0, 600); } catch { channelDebug.sample = null; }
    }
  };
  channel.port1.start?.();

  window.parent.postMessage(
    { v: 1, op: "init", tag: boot.tag, bridge_nonce: boot.bridge_nonce, generation: boot.generation },
    boot.parent_origin,
    [channel.port2],
  );

  // `ready` and `state` are CHANNEL messages, never window messages: the host
  // parses them on its side of the port (`screenProtocol`'s ChildToHost union),
  // and a `ready` it never sees leaves the frame forever unready — the wrapper
  // stays hidden, nothing is pushed, and nothing errors. `accepts` announces
  // the v2 projection this screen is built for.
  channel.port1.postMessage({ v: 1, op: "ready", accepts: ["screen.v2"] });
  state.ready = true;

  /** Send bounded UI state (which meeting is open). Over the cap: dropped. */
  function sendState(data) {
    const body = JSON.stringify(data);
    if (byteLen(body) > MAX_STATE_BYTES) return false;
    channel.port1.postMessage({ v: 1, op: "state", data });
    state.sent = data;
    return true;
  }

  return { boot, sendState, state };
}
