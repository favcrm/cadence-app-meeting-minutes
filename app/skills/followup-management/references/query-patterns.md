# Cross-meeting query and follow-up update patterns

## 1. List active meetings with open follow-ups (without loading transcripts)

```json
{
  "app": "meeting-minutes",
  "operation": "records.list",
  "args": {
    "omit_fields": ["transcript"],
    "filters": [
      { "field": "status", "op": "in", "value": ["draft", "reviewed"] },
      { "field": "followups", "op": "contains", "value": "\"status\":\"open\"" }
    ],
    "sort": { "field": "held_at", "direction": "desc" },
    "limit": 50
  }
}
```

If `has_more` is `true`, pass `next_cursor` as `cursor` with the exact same `filters` and `sort` until all active rows are inspected.

## 2. Search decisions and discussions for a client or topic in a date range

```json
{
  "app": "meeting-minutes",
  "operation": "records.list",
  "args": {
    "query": "security review",
    "omit_fields": ["transcript"],
    "filters": [
      { "field": "status", "op": "in", "value": ["draft", "reviewed"] },
      { "field": "held_at", "op": "gte", "value": "2026-10-01" }
    ],
    "sort": { "field": "held_at", "direction": "desc" },
    "limit": 25
  }
}
```

Because `record_search_columns` includes `transcript` even when `omit_fields: ["transcript"]` is set, `query` still matches words spoken only in the transcript while keeping the response small. Call `records.show` on individual hits when you need the exact `[MM:SS]` line.

## 3. Mark one follow-up item `"done"` safely

After reading `records.show` (`revision: 4`, `title_source: "user"`, two follow-ups `"fu-1"` and `"fu-2"`):

```json
{
  "app": "meeting-minutes",
  "operation": "records.update",
  "reason": "Mark follow-up fu-1 (security questionnaire) as done",
  "args": {
    "record_id": "mtg-nov-onboarding",
    "expected_revision": 4,
    "consent_provenance": {
      "method": "followup_toggle",
      "note": "Marked fu-1 done from chat"
    },
    "profile": {
      "title_source": "user",
      "followups": [
        {
          "id": "fu-1",
          "task": "Send updated security questionnaire to Acme",
          "owner": "Priya",
          "due": "Friday",
          "status": "done"
        },
        {
          "id": "fu-2",
          "task": "Schedule December architecture check-in",
          "owner": null,
          "due": null,
          "status": "open"
        }
      ]
    }
  }
}
```

## 4. Soft-archive a superseded or test meeting

```json
{
  "app": "meeting-minutes",
  "operation": "records.update",
  "reason": "Archive duplicate dry-run meeting record",
  "args": {
    "record_id": "mtg-dry-run-01",
    "expected_revision": 1,
    "consent_provenance": {
      "method": "assistant_consolidation",
      "note": "Soft-archived duplicate record"
    },
    "profile": {
      "status": "archived"
    }
  }
}
```

Include `"title_source": "user"` inside `profile` whenever `records.show` reported `title_source: "user"`.
