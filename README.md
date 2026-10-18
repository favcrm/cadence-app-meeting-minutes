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

Version 0.2.1 wraps long run identifiers in narrow detail columns without
truncating their values; verified with a real run at a 390px viewport.

## Layout

```text
app/                     the installable bundle root
  screens/<tag>/         the app's own screen + its declaration
src/screens/             authored screen source (entry, receiver, views)
scripts/                 packaging and the pre-push gate
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

## Check before push

`scripts/pre-push` is the local gate and the CI gate. It links `node_modules`
to `$HOST_SOURCE/ui/node_modules` (default `/home/ubuntu/Project/cadence`),
runs `node scripts/build-ui-package.mjs`, and requires
`dist/screens/minutes/{client.js,app.css,screens.json}` to match
`app/screens/minutes/`. It then runs `cadence app check app`. Set `CADENCE_BIN`
to the checker executable; otherwise it uses `cadence` on `PATH`. It does not
install dependencies or change source or `app/`.

The Cadence worktree hook passes `--receipt` to record the checked head and
exit status. Its optional `--tests` flag runs the same complete app gate;
this repository has no separate test suite.

```sh
scripts/pre-push
```

## CI

`.github/workflows/ci.yml` has one job, `build`. It runs on pull requests,
pushes to `main`, and merge-queue check requests. The job checks out public
host `favcrm/cadence` at `1cc99c485d01f5fa27f04a411c375b9afcc31347`, installs
that checkout's frozen `ui/pnpm-lock.yaml` with Node 22 and pnpm 12.2.1, and
verifies the checksum-pinned native validator for that same host commit
(archive member `./cadence`). It then sets `HOST_SOURCE` and `CADENCE_BIN` and
runs `scripts/pre-push`. Pins:

- archive sha256 `aa32b1259a989b0d4c38a6096ae17cbf8825be2cdd2973d83e633c1f42d96eb5` (21446982 bytes)
- binary sha256 `3750bfa017bb3ae9ed84396080cdc409f65aeb0ea71d119c7b5eeec3d097a6bd`

A missing archive, digest mismatch, stale screen asset, or rejected package
fails the job. The token is contents read-only. The job does not install the
app or change repository settings.

Guarded delivery stays operator-owned. An operator enables the required `build`
check, protected pull-request and merge-queue delivery, and auto-merge. Native
reviews and operator approval stay mandatory. Agents do not apply those
settings.
