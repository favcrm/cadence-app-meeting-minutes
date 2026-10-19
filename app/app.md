---
app: meeting-minutes
title: Meeting minutes
version: '0.2.5'
summary: Record a meeting, follow its transcript, and reread saved minutes.
needs:
  connections: []
  capabilities:
    transcription:
      schema: 1
      capability: audio.transcribe
      version: 1
      action: transcribe_audio
      resource_kind: connection_account
      effect: draft
    consolidation:
      schema: 1
      capability: text.generate
      version: 1
      action: generate_text
      resource_kind: connection_account
      effect: draft
  recording:
    transcription: transcription
    consolidation: consolidation
    label: New minutes
    title: New meeting
listing:
  tagline: Record a meeting. Keep what was decided.
  icon: assets/meeting-minutes.svg
  category: operations
  tags: [meetings, minutes]
  publisher:
    name: Cadence
  about: Record in the trusted host, follow confirmed transcript batches, then read a saved summary, decisions and follow-ups beside their source. The assistant stays available. No writer, reviewer, profile or model setup is required.
  can:
    - Record, pause, resume and stop a meeting after seeing the price
    - Follow confirmed transcript batches while recording
    - Reread full minutes and their timestamped source transcript
    - Rename a meeting without a later generated title overwriting it
  screenshots: []
  setup: []
  data:
    stores:
      - Title, optional participants, consent, transcript timestamps and minutes in this installation's default context
      - Pending audio and private paid receipts in the host; confirmed audio is removed from active input
    personal: true
---

# Meeting minutes

The trusted host renders the recent meetings list, inline New meeting recorder
and full minutes detail beside the persistent assistant. The default context
is internal; there is no context picker or raw context identifier in this view.
There is no app-owned iframe, pasted-transcript launcher or agent-team workflow.

Press Record only after everyone knows the meeting is being recorded and you
accept the displayed cumulative transcription and minutes ceilings. Title and
participants are optional single-line fields. Pause releases the microphone;
Resume continues the same source timeline. Stop saves the final short audio
batch before generating minutes. Speech arrives in ordered roughly 8-second
16 kHz mono PCM16 WAV batches, not simulated transcript lines.

The bundle requests generic `audio.transcribe@1` and `text.generate@1` services.
The host selects reviewed connections and platform defaults; the app contains
no provider URL, credential or model pin. An unavailable, disabled or unpriced
service prevents Record rather than falling back or claiming success.

Saved minutes contain summary, source-backed decisions and follow-ups. Unknown
owners and dates remain unassigned. A supplied or manually renamed title belongs
to you; generation cannot replace it. No tasks, messages or outward actions are
created. Interrupted paid operations retain their exact retry identity.

Install and approve the exact bundle digest using the normal host catalog flow.
The host must support `needs.recording`; older hosts reject this bundle.
