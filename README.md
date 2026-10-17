# Cadence Meeting minutes App

App identity stays `meeting-minutes`; the repository name does not change
installation or data identities. Local checkout:
`/home/ubuntu/Project/cadence-app-meeting-minutes`.

## Status

Extracted from the Cadence tree under CAD-1505, after CAD-1422 made detached
app repositories the source of truth. `app/` is the installable bundle:

- `app.md` — the manifest, including the `app-screens: [1]` requirement
- `app-chat.json`, `workflows/consolidate.md`, `rubrics/minutes.md`
- `views/app-views-v1.json` — the data-only descriptor
- `screens/minutes/` — the app-owned screen (`app-screens/v2`): `screens.json`
  plus the exact `client.js`/`app.css` bytes it declares

The screen is built from `src/screens/` by `scripts/build-ui-package.mjs` and
then copied into `app/screens/`. What it can show is bounded by the host's
read-only projection: run state, the reviewer's decision, and the approved
minutes text the host publishes. Nothing here starts a run, records audio or
writes anything — those are host actions.

## Layout

```text
app/                     the installable bundle root
  screens/<tag>/         the app's own screen + its declaration
src/screens/             authored screen source (entry, receiver, views)
scripts/                 packaging (host toolchain, read-only)
docs/                    descriptor companion and notes
```

## Build the screen package

The toolchain resolves from a Cadence checkout's `ui/node_modules`; nothing is
installed into this repository.

```sh
ln -sfn /home/ubuntu/Project/cadence/ui/node_modules node_modules   # once
node scripts/build-ui-package.mjs
cp dist/screens/minutes/{client.js,app.css,screens.json} app/screens/minutes/
```

## Install

```sh
cadence app catalog install .
cadence app catalog approve INSTALL_ID --digest BUNDLE_DIGEST
```

The app is then reachable at `/apps/meeting-minutes` (CAD-1438 retired the
`/app-installations/<id>` shape to a compatibility redirect).
