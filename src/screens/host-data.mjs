/**
 * The projection store — the only data this screen has.
 *
 * The host PUSHes a read-only snapshot of the verified scope; nothing here
 * fetches, caches to storage or invents a row. `isEmpty` is honest: it means
 * the host has not attached a projection yet, not that the app has no
 * meetings.
 */

const EMPTY = Object.freeze({
  v: 0,
  installId: "",
  digest: null,
  tag: null,
  contextId: "",
  installation: { title: "", name: "", version: "", summary: "" },
  contexts: [],
  meetings: [],
});

export function createHostData() {
  let snapshot = EMPTY;
  const listeners = new Set();

  return {
    read: () => snapshot,
    isEmpty: () => snapshot.v === 0,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Called only by the receiver with an already-validated projection. */
    attach(next) {
      snapshot = next;
      for (const fn of listeners) fn(snapshot);
    },
  };
}

/** The label a person reads for a host-stated phase. Never a claim. */
export function phaseLabel(phase) {
  if (!phase) return "Not stated";
  if (phase.startsWith("working")) return "Working";
  switch (phase) {
    case "awaiting":
      return "Awaiting";
    case "checking":
      return "Checking";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return phase;
  }
}

/** UTC day from a run's real epoch seconds, or null when the host omitted it. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function meetingWhen(created) {
  if (typeof created !== "number" || !Number.isFinite(created)) return null;
  const date = new Date(created * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** The two review decisions the minutes workflow returns. Anything else is
 *  shown as the host wrote it. */
export function reviewLabel(decision) {
  const value = (decision ?? "").trim();
  if (!value) return null;
  if (value === "approve") return "Approved";
  if (value === "revise") return "Needs revision";
  return value;
}
