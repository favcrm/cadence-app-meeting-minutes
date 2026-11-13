# Consolidation field rules and worked example

## Declared `meetings` columns (`app-storage/v1`)

| Field | Type | Nullable | Bounds and rules |
| --- | --- | --- | --- |
| `schema` | integer | no | Always `1` (default `1`) |
| `title` | text | no | `1..200` chars; default `"Untitled meeting"` |
| `title_source` | text | no | `"user"` or `"generated"`; once `"user"`, updates **must** keep `title_source: "user"` |
| `held_at` | text | yes | ISO-8601 date or timestamp up to 40 chars, or `null` |
| `duration_seconds` | integer | yes | Whole non-negative seconds, or `null` |
| `status` | text | no | `"draft"`, `"reviewed"`, or `"archived"` |
| `participants` | json | no | Array of `1..120`-char strings, at most 50 items |
| `participants_text` | text | no | Searchable flat string (`participants` joined by `", "`), at most 1,000 chars |
| `tags` | json | no | Unique slugs matching `^[A-Za-z0-9_-]{1,40}$`, at most 16 items |
| `summary` | text | no | Plain text up to 8,000 chars |
| `decisions` | json | no | Up to 100 items of `{id, text, quote?, timestamp?}` |
| `followups` | json | no | Up to 100 items of `{id, task, owner?, due?, status}` |
| `transcript` | text | no | Full source transcript up to 96,000 chars |

## Item schemas

### Decision item (`decisions[]`)

- `id`: non-empty string (`1..64` chars), such as `"dec-1"`, `"dec-2"`.
- `text`: concise statement of what was decided (`1..1000` chars).
- `quote`: verbatim supporting excerpt from `transcript` (`<= 1000` chars) or `null`. Keep `quote` in the original spoken language of the transcript so reviewers can verify it word-for-word.
- `timestamp`: time marker copied from the supporting transcript line (`<= 32` chars, such as `"[04:12]"` or `"[01:02:18]"`) or `null` when the transcript has no timestamps.

### Follow-up item (`followups[]`)

- `id`: non-empty string (`1..64` chars), such as `"fu-1"`, `"fu-2"`.
- `task`: actionable description (`1..1000` chars).
- `owner`: string (`1..120` chars) **only** if explicitly assigned in the transcript, else `null`. Never use `"TBD"` or `"Unassigned"` strings — `null` renders localized unassigned badges in the screen.
- `due`: string (`<= 40` chars, ISO date preferred when known, or the exact stated phrase such as `"Friday"`) **only** if explicitly stated in the transcript, else `null`.
- `status`: `"open"` or `"done"`.

## Write-rule invariants

1. **Conditional `title_source` lock:** When the stored record has `before.title_source === "user"`, `record_write_schema` requires `after.title_source === "user"`. Even on a partial `records.update`, the host evaluates `after` on the merged record, and including `title_source: "user"` in `profile` makes the lock explicit in the review diff.
2. **Closed `consent_provenance`:** Admitted `method` values are `"screen_form"`, `"inline_rename"`, `"followup_toggle"`, and `"assistant_consolidation"`, with an optional `note` (`<= 280` chars). Always use `"assistant_consolidation"` when consolidating or translating minutes.
3. **Wire budget:** `app_call` accepts up to 128 KiB of serialized arguments, while remotely staged CLI/MCP actions cap the reviewable payload more tightly (`24,000` UTF-8 bytes). Leaving an unchanged `transcript` out of `records.update` keeps consolidation updates compact across every surface.

## Worked `records.update` call

Suppose `records.show` returned `revision: 2` and `title_source: "user"` for `"mtg-q4-launch"`:

```json
{
  "app": "meeting-minutes",
  "operation": "records.update",
  "reason": "Consolidate Q4 launch transcript into summary, 2 decisions and 2 follow-ups",
  "args": {
    "record_id": "mtg-q4-launch",
    "expected_revision": 2,
    "consent_provenance": {
      "method": "assistant_consolidation",
      "note": "Consolidated from timestamped recording transcript"
    },
    "profile": {
      "title_source": "user",
      "status": "reviewed",
      "summary": "The team finalized the Q4 rollout sequence, starting with demo-company on Tuesday before expanding to general availability the following Monday.",
      "decisions": [
        {
          "id": "dec-1",
          "text": "Deploy Q4 rollout to demo-company on Tuesday first and hold fleet rollout until Thursday QA sign-off.",
          "quote": "Let's deploy to demo-company on Tuesday morning first and hold the fleet push until Thursday QA signs off.",
          "timestamp": "[03:42]"
        }
      ],
      "followups": [
        {
          "id": "fu-1",
          "task": "Run mobile layout verification on demo-company after Tuesday deploy",
          "owner": "May",
          "due": "Wednesday",
          "status": "open"
        },
        {
          "id": "fu-2",
          "task": "Draft customer release announcement",
          "owner": null,
          "due": null,
          "status": "open"
        }
      ]
    }
  }
}
```
