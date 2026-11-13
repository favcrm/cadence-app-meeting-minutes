# Transcript normalization and `records.create` patterns

## Subtitle and platform transcript normalization

### 1. WebVTT captions

Input excerpt:

```text
WEBVTT

1
00:00:08.400 --> 00:00:14.120
<v Alex Chan>Welcome everyone, let's confirm the November onboarding checklist.</v>

2
00:02:35.010 --> 00:02:41.900
<v Priya>I will send the updated security questionnaire to Acme by Friday.</v>
```

Normalized `transcript` text:

```text
[00:08] Alex Chan: Welcome everyone, let's confirm the November onboarding checklist.

[02:35] Priya: I will send the updated security questionnaire to Acme by Friday.
```

Derived `duration_seconds`: `162` (rounded from `00:02:41.900`).
Derived `participants`: `["Alex Chan", "Priya"]` and `participants_text`: `"Alex Chan, Priya"`.

### 2. SubRip (SRT) captions without speaker tags

Input excerpt:

```text
1
00:00:03,100 --> 00:00:07,500
We agreed to keep the weekly sync at 10am HKT on Tuesdays.

2
01:04:12,000 --> 01:04:19,000
Next review is scheduled for December 3.
```

Normalized `transcript` text:

```text
[00:03] We agreed to keep the weekly sync at 10am HKT on Tuesdays.

[01:04:12] Next review is scheduled for December 3.
```

Notice that no speaker prefix is invented, sub-hour timestamps use `[MM:SS]`, and timestamps at or above one hour use `[HH:MM:SS]`.

### 3. Plain meeting notes without timestamps

When importing bulleted or paragraph notes that have no time markers:

- Keep the text as clean paragraphs or bullets in `transcript`.
- Set `duration_seconds: null`.
- On extracted `decisions[]`, set `timestamp: null` and copy the exact supporting bullet into `quote`.

## Worked `records.create` call

```json
{
  "app": "meeting-minutes",
  "operation": "records.create",
  "reason": "Import November onboarding sync transcript and consolidated minutes",
  "args": {
    "consent_provenance": {
      "method": "assistant_consolidation",
      "note": "Imported from attached WebVTT caption transcript"
    },
    "profile": {
      "schema": 1,
      "title": "November onboarding checklist sync",
      "title_source": "generated",
      "held_at": "2026-11-13T10:00:00Z",
      "duration_seconds": 162,
      "status": "reviewed",
      "participants": ["Alex Chan", "Priya"],
      "participants_text": "Alex Chan, Priya",
      "tags": ["onboarding", "acme"],
      "summary": "Reviewed the November onboarding checklist for Acme and assigned delivery of the updated security questionnaire.",
      "decisions": [
        {
          "id": "dec-1",
          "text": "Proceed with the November onboarding checklist for Acme.",
          "quote": "Welcome everyone, let's confirm the November onboarding checklist.",
          "timestamp": "[00:08]"
        }
      ],
      "followups": [
        {
          "id": "fu-1",
          "task": "Send updated security questionnaire to Acme",
          "owner": "Priya",
          "due": "Friday",
          "status": "open"
        }
      ],
      "transcript": "[00:08] Alex Chan: Welcome everyone, let's confirm the November onboarding checklist.\n\n[02:35] Priya: I will send the updated security questionnaire to Acme by Friday."
    }
  }
}
```
