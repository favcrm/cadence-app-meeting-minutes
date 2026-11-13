---
name: followup-management
description: Search decisions across meetings, review and toggle open follow-up items, archive superseded meetings and turn open follow-ups into tracked workspace issues with source citations.
---

# Follow-up management and cross-meeting search

You help the workspace answer questions across past meetings, audit open follow-up items by owner or date, mark follow-ups done or reopened, soft-archive obsolete meetings, and hand off follow-ups to the workspace issue tracker when asked.

## Lightweight cross-meeting search

Meeting transcripts can be up to 96,000 characters per record. Never page full transcripts just to scan titles, summaries, decisions or follow-ups:

1. **Always project out `transcript` on list scans.** Call `app_call` on `meeting-minutes` with `records.list` and include `"omit_fields": ["transcript"]` along with `"sort": {"field": "held_at", "direction": "desc"}`.
2. **Exclude archived meetings by default.** Unless the user asks about archived records, pass `{"field": "status", "op": "in", "value": ["draft", "reviewed"]}` in `filters`.
3. **Combine structured filters with search.**
   - Open follow-ups only: `{"field": "followups", "op": "contains", "value": "\"status\":\"open\""}`
   - Specific attendee: `{"field": "participants_text", "op": "contains", "value": "May"}`
   - Date window: `{"field": "held_at", "op": "gte", "value": "2026-11-01"}` and `{"field": "held_at", "op": "lte", "value": "2026-11-30T23:59:59Z"}`
   - Topic search across `title`, `participants_text`, `summary`, `tags`, `decisions`, `followups` and `transcript`: pass `"query": "<topic>"` (still keeping `omit_fields: ["transcript"]` on the list call).
   - If `app_describe` lists `records.aggregate` in `operations`, prefer `records.aggregate` (`group_by: ["status"]`, `sum: ["duration_seconds"]`, `filters`) for counts and total meeting duration without paging.
4. **Load full transcripts selectively.** Call `records.show` (`{"record_id": "<id>"}`) only on the specific matching meetings where you need to verify an exact verbatim quote or `[MM:SS]` timestamp before answering.

## Toggling follow-up completion (`followup_toggle`)

Because `followups` is stored as a JSON array on each meeting record, updating one follow-up item must preserve every sibling item intact:

1. Call `records.show` with `{"record_id": "<id>"}` first to read the latest `revision`, `title_source` and full `followups` array.
2. Locate the target item by `id` (or exact `task` text when the user named it by description; if two items match ambiguously, show both and ask which one).
3. Build the updated `followups` array keeping every other item's `id`, `task`, `owner`, `due` and `status` byte-for-byte unchanged, changing only the target item's `status` (`"done"` or `"open"`).
4. Stage `records.update` with `expected_revision`, `consent_provenance: {"method": "followup_toggle"}`, and `profile` containing `followups` (plus `"title_source": "user"` whenever the current record has `title_source: "user"`). Never resend `transcript`.

## Soft-archiving obsolete or duplicate meetings

Meeting minutes has no hard-delete verb so audit history is never silently destroyed. When asked to remove or archive a duplicate, test or superseded meeting:

1. Read the record first via `records.show` to confirm its `revision`, `title`, `held_at` and `title_source`.
2. Stage `records.update` setting `profile: {"status": "archived"}` (plus `"title_source": "user"` when `before.title_source === "user"`) and `consent_provenance: {"method": "assistant_consolidation", "note": "Archived at user request"}`.
3. Explain clearly that approving the action soft-archives the meeting (`status: "archived"`), hiding it from active digests while keeping its revision journal intact.

## Turning follow-ups into tracked workspace issues

Meeting minutes never creates board issues on its own. When the user explicitly asks to turn one or more meeting follow-ups into tracked board issues:

1. Read the source meeting (`records.show` or `records.list` with `omit_fields: ["transcript"]`) to gather the exact `task`, `owner`, `due`, meeting `title`, `record_id`, `held_at`, and any supporting decision `quote` / `timestamp`.
2. Check which issue tool your session exposes (`propose_ticket` in workspace chat, or `board_create_issue` when authorized) and include provenance in the issue body: meeting `title`, `record_id`, `held_at`, stated `owner` / `due` (never invented), and `[MM:SS]` transcript reference when available.
3. Do not mark the meeting follow-up `"done"` merely because a tracker ticket was proposed; leave it `"open"` unless the user asks to close it.

Filter recipes and update templates are in references/query-patterns.md.
