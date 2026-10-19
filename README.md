# Cadence Meeting minutes App

The application identity remains `meeting-minutes`; installation and saved-data
identities do not change with the repository name.

## Version 0.2.5

The approved New minutes action opens the trusted host's inline New meeting
recorder, not a pasted-transcript dialog. Recent meetings, recording and full
minutes detail use the host's verified `needs.recording` contract beside the
persistent assistant. Title and participants are optional. Record, Pause,
Resume and Stop operate the microphone; transcript lines come from confirmed
roughly 8-second audio batches. Stop includes the final short batch.

The host persists summary, cited decisions, follow-ups and timestamped source.
Unknown owners/dates remain unassigned. Manual titles cannot be overwritten by
generation. No tasks, messages or outward actions are created. The default
context is internal; its raw identifier and version are not workspace chrome.

The old iframe, truncated run-artifact projection, pasted-transcript workflow,
writer/reviewer rubric and screen generator are removed. There is no app-owned
microphone code, provider credential, provider URL or model pin.

## Bundle

- `app/app.md`: catalog metadata, generic `audio.transcribe@1` and
  `text.generate@1` slots, and the native recording declaration.
- `app/app-chat.json`: shared assistant prompt group, without context chrome.
- `app/assets/meeting-minutes.svg`: catalog icon.

## Host and service requirements

The host must validate, approve and render recording-only applications. Older
validators reject `needs.recording`; do not bypass that refusal. The platform
must expose the reviewed speech-capable provider manifest, a published default
speech route and reviewed positive per-second customer/provider prices. An
operator owns publication, enablement and funding. Missing services disable
Record with an explanation; there is no simulated success or fallback.

Before capture, the host shows cumulative transcription and consolidation
ceilings. Pending audio remains in the host until confirmation; active audio
input is then cleared while transcript and paid-operation receipts remain.
This is not a secure-erasure claim. Unknown paid outcomes retain their exact
operation identity instead of starting replacement charged calls.

## Verification and delivery

`scripts/pre-push` runs `cadence app check app` using `CADENCE_BIN`, or `cadence`
on PATH. It installs no dependencies and writes no bundle files. `--receipt`
records the checked head and exit status; `--tests` uses the same complete gate.
The host repository owns recorder UI, capture and service checks.

CI retains the required `build` check and verifies an immutable native validator
archive and binary before running the same gate. Its validator pin must be a
promoted host build that supports recording-only applications before this app
can pass CI or ship. Keep the host, platform and application rollout ordered;
local validation does not constitute deployment or provider activation.

Install the bundle through the normal catalog flow and approve its exact digest.
It remains reachable at `/apps/meeting-minutes`. Production updates, service
publication, required independent reviews and operator approvals remain owned
by their normal delivery controls.
