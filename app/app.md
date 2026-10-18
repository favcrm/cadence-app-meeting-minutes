---
app: meeting-minutes
title: Meeting minutes
version: '0.2.1'
summary: Read the reviewed minutes of this scope's consolidation runs — state, the reviewer's decision, and the approved page the host publishes.
needs:
  connections: []
  capabilities: {}
  views:
    contract: app-views/v1
  requires:
    contracts:
      app-screens: [1]
listing:
  tagline: Read minutes from a transcript
  icon: assets/meeting-minutes.svg
  category: operations
  tags:
    - meetings
    - minutes
  publisher:
    name: Cadence
  about: Meeting minutes shows the runs that turn one pasted transcript into a single reviewed page, with the summary, decisions, follow-ups and the reviewer's decision. The screen reads the host's read-only projection. Recording, speech-to-text, starting a run, and naming a blank title from the room stay outside this bundle.
  can:
    - Show the consolidation runs of this scope with their real state
    - Show the reviewer's decision and why
    - Show the approved minutes text the host publishes for a run
  screenshots: []
  setup: []
  data:
    stores:
      - The reviewed minutes text, as the host publishes it
    personal: true
---

# Meeting minutes — the reviewed-minutes screen

This bundle installs the `meeting-minutes` app: one manifest, one local-only
consolidation workflow, one review rubric, and one app-owned screen
(`screens/minutes/`, `app-screens/v2`).

The screen renders the host's read-only projection of this scope: the runs
that belong to it, each run's real state, the reviewer's decision, and — for a
reviewer-approved run — the first characters of the approved minutes text as
the host states them. A field the host omits is shown as absent, never filled
in with a guess.

Nothing in this bundle records audio, calls a speech model, starts a run,
creates a task, or sends a message. Recording and speech-to-text stay
operator-run host actions; starting a consolidation run is the host's job too,
which is why the screen offers no button that could not work.

The only workflow is `consolidate`, which turns one pasted transcript into a
single minutes page: a summary, the decisions, and the follow-ups. The result
is draft text until the independent review approves it.

## Set up once

From a trusted Cadence source checkout, install this directory and read the
returned installation ID and bundle digest. Approve that exact digest:

```sh
cadence app catalog install .
cadence app catalog approve INSTALL_ID --digest BUNDLE_DIGEST
```

## Run

Ask for a new minutes page and paste the transcript. Register two different
agents in the owner PM group: one writer and one reviewer. The writer produces
one markdown artifact. The reviewer fetches that artifact, checks it against
the quoted transcript, and approves or sends it back.

An approved page is text for a person to read. It is not a task list the host
will execute.
