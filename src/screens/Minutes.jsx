/**
 * The Meeting minutes screen.
 *
 * Everything here renders host-stated facts and nothing else: a run's state,
 * its reviewer's decision, and — when the host states one — the first ≤600
 * characters of the reviewer-approved minutes artifact. A field the host
 * omits renders as absent, never as an empty claim.
 *
 * Starting a consolidate run is a host action, not a screen action. This
 * screen says so rather than offering a button that could not work.
 */
import { useEffect, useState } from "react";
import { meetingWhen, phaseLabel, reviewLabel } from "./host-data.mjs";

function Facts({ meeting }) {
  const rows = [
    ["State", phaseLabel(meeting.phase ?? meeting.state)],
    ["When", meetingWhen(meeting.created) ?? "Not stated"],
    ["Workflow", meeting.workflowTitle ?? "Not stated"],
    ["Run", meeting.id],
  ];
  return (
    <dl className="facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={label === "Run" ? "num" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Detail({ meeting }) {
  const review = reviewLabel(meeting.review?.decision);
  const approved = meeting.approved;
  return (
    <section className="detail" aria-label="Meeting">
      <h2>{meeting.title || "Untitled meeting"}</h2>
      <Facts meeting={meeting} />
      {review ? <p className="line"><span className="key">Review</span> {review}</p> : null}
      {meeting.review?.rationale ? <p className="review-why">{meeting.review.rationale}</p> : null}
      {approved?.by ? (
        <p className="line">
          <span className="key">Approved by</span> {approved.by}
          {meetingWhen(approved.at) ? <span className="num"> · {meetingWhen(approved.at)}</span> : null}
        </p>
      ) : null}
      {meeting.refusal ? (
        <p className="refusal" role="alert">{meeting.refusal.text || meeting.refusal.code}</p>
      ) : null}
      {meeting.excerpt ? (
        <section className="minutes" aria-label="Approved minutes">
          <h3>Approved minutes</h3>
          <pre>{meeting.excerpt}</pre>
          <p className="note">
            {meeting.excerpt.length >= 600
              ? "The host sends the first 600 characters of the approved page. The rest stays in the run."
              : "As the host states it for this run."}
          </p>
        </section>
      ) : (
        <p className="note" role="status">
          No approved minutes text in this projection yet. The host sends it only for a
          reviewer-approved page.
        </p>
      )}
    </section>
  );
}

export default function Minutes({ hostData }) {
  const [snapshot, setSnapshot] = useState(() => hostData.read());
  const [open, setOpen] = useState(null);

  useEffect(() => {
    // The host pushes once, right after the handshake, so a push can land
    // before this effect subscribes — `attach` would then notify an empty
    // listener set and the first render's empty snapshot would stick. Re-read
    // on subscribe so the store always wins over the initial render.
    setSnapshot(hostData.read());
    return hostData.subscribe(setSnapshot);
  }, [hostData]);

  const meetings = snapshot.meetings;
  const selected = meetings.find((meeting) => meeting.id === open) ?? null;

  if (hostData.isEmpty() && snapshot.v === 0) {
    return (
      <div className="screen">
        <p className="note" role="status">Waiting for the host to attach this scope…</p>
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="head">
        <h1>{snapshot.installation.title || "Meeting minutes"}</h1>
        <p className="sub num">
          {snapshot.contextId ? `Context ${snapshot.contextId}` : "No context"}
          {snapshot.installation.version ? ` · ${snapshot.installation.version}` : ""}
        </p>
      </header>

      {meetings.length === 0 ? (
        <div className="card empty" role="status">
          <p className="strong">No meetings in this scope</p>
          <p className="note">
            This read-only view shows consolidation runs for the selected scope.
            Consolidation starts in the host's local text workflow, not in this screen.
          </p>
        </div>
      ) : (
        <div className="split">
          <ul className="list" aria-label="Meetings">
            {meetings.map((meeting) => (
              <li key={meeting.id}>
                <button type="button" className="row" data-on={meeting.id === open || undefined} onClick={() => setOpen(meeting.id)}>
                  <span className="row-title">{meeting.title || "Untitled meeting"}</span>
                  <span className="row-meta num">
                    {meetingWhen(meeting.created) ? `${meetingWhen(meeting.created)} · ` : ""}
                    {phaseLabel(meeting.phase ?? meeting.state)}
                    {reviewLabel(meeting.review?.decision) ? ` · ${reviewLabel(meeting.review.decision)}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <Detail meeting={selected} />
          ) : (
            <p className="note" role="status">Pick a meeting to read its state.</p>
          )}
        </div>
      )}
    </div>
  );
}
