# Meeting minutes (`meeting-minutes` `0.5.0`)

Structured meeting notes, decisions, follow-ups, live audio recording, and multi-format audio file upload for hosted Cadence workspaces.

## Architecture & Contracts (`v0.5.0`)

- **Bridge receiver**: `@cadence/app-kit@0.4.0` (`createScreenBridge`) vendored from `favcrm/cadence` `278834fe9590e68b59fd84331a9f3e4eff6fefb2` (`app-kit/` + `app-kit.lock.json`), accepting `["screen.v2", "screen-surfaces.v1", "screen-records.v1", "screen-locale.v1", "screen-audio.v1"]` and emitting `{ v: 2, op: "leave", unsaved }`.
- **Shared screen components & styling**: `@cadence/screen-ui@1.0.0` (`.cadence-ui/cadence-screen-ui-1.0.0.tgz` + `screen-ui.lock.json`).
- **Screen assets**: Static framework/client partition (`app/screens/minutes/runtime.js`, `client.js`, `minutes.css`, `screens.json`) declaring `contract: "app-screens/v2"`, `host_contract: "screen-records.v1"`, `may: ["records.call"]`, and sections `All meetings` (`?minutes=all`) + `Follow-ups` (`?minutes=followups`).
- **App-owned logical storage**: `app/app-storage.json` (`app-storage/v1`, `record_kind: "meeting"`, `default_table: "meetings"`) + `app/storage/001-initial.json`.
  - User-provided titles (`title_source: "user"`) take precedence over generated headings and are protected against downgrade to `"generated"` in both the client and `record_write_schema`.
  - Missing follow-up owners or due dates remain `null` (`Unassigned` / `No due date`) and are never fabricated.
- **Bilingual UI**: Full English (`en`) and written Traditional Chinese (`zh-HK` / `zh-TW`) parity.
- **Audio capture (`CMM-6`)**: Zero-upfront-input 1-click **Record audio** (`開始錄音`) and **Upload audio** (`上載錄音檔`) actions via the generic host `screen-audio.v1` modal when `audio_capture === 1` is advertised on the screen push.

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

`meeting-minutes` `0.3.1` requires `app-storage: [1]`, which is hosted-only. Running `cadence app check app --json` with Cadence `v0.3.22` exits `3` with the expected `app-storage` content refusal while emitting the canonical `digest` and `files` inventory verified by `.github/scripts/assert-app-check.py` and `.github/scripts/publish.mjs`.
