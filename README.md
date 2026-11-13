# Meeting minutes (`meeting-minutes` `0.6.0`)

Structured meeting notes, decisions, follow-ups, inline live audio recording, and multi-format audio file upload for hosted Cadence workspaces.

## Architecture & Contracts (`v0.6.0`)

- **Bridge receiver**: `@cadence/app-kit@0.5.0` (`createScreenBridge`) vendored from `favcrm/cadence` (`app-kit/` + `app-kit.lock.json`), accepting `["screen.v2", "screen-records.v1", "screen-locale.v1", "screen-audio.v2"]` and emitting `{ v: 2, op: "leave", unsaved }`.
- **Shared screen components & styling**: `@cadence/screen-ui@1.0.0` (`.cadence-ui/cadence-screen-ui-1.0.0.tgz` + `screen-ui.lock.json`).
- **Screen assets**: Static framework/client partition (`app/screens/minutes/runtime.js`, `client.js`, `minutes.css`, `screens.json`) declaring `contract: "app-screens/v2"`, `host_contract: "screen-records.v1"`, `may: ["records.call"]`, and sections `All meetings` (`?minutes=all`), `New meeting` (`?minutes=new`), and `Follow-ups` (`?minutes=followups`).
- **Dedicated full-page views (`CMM-13`)**:
  - **New meeting (`NewMeetingPage`)**: Dedicated full-page workspace with zero drawers or modals — 1-click inline live recording (`screen-audio.v2` streaming voice level meter, segment counters, inline title/attendees, live transcript, and 1-click `End meeting & save`), drag-and-drop multi-format audio upload, and paste transcript mode.
  - **Meeting detail (`MeetingDetailPage`)**: Dedicated full-page detail view (`← All meetings`, inline title rename, `Summary | Decisions & Follow-ups | Transcript | History` tabs, and full-page editor).
- **App-owned logical storage**: `app/app-storage.json` (`app-storage/v1`, `record_kind: "meeting"`, `default_table: "meetings"`) + `app/storage/001-initial.json`.
  - User-provided titles (`title_source: "user"`) take precedence over generated headings and are protected against downgrade to `"generated"` in both the client and `record_write_schema`.
  - Missing follow-up owners or due dates remain `null` (`Unassigned` / `No due date`) and are never fabricated.
- **Bilingual UI**: Full English (`en`) and written Traditional Chinese (`zh-HK` / `zh-TW`) parity.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm run typecheck        # tsc --noEmit
pnpm run build            # build app/screens/minutes/* with pinned provenance
pnpm run verify           # offline screen/SDK/AST authority check
pnpm test                 # unit + contract + OIDC publisher dry-run tests
pnpm run dev              # synthetic localhost preview (http://localhost:3187/dev/preview/)
sh scripts/pre-push       # full local gate including archive determinism check
```

## Native vs Hosted Check

`meeting-minutes` `0.6.0` requires `app-storage: [1]`, which is hosted-only. Running `cadence app check app --json` with Cadence `v0.3.22` exits `3` with the expected `app-storage` content refusal while emitting the canonical `digest` and `files` inventory verified by `.github/scripts/assert-app-check.py` and `.github/scripts/publish.mjs`.
