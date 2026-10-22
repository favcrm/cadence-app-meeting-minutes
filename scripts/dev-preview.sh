#!/bin/sh
# One-command offline preview for the committed Minutes screen (CMM-7).
# Uses the canonical host frame; no source checkout, build or host data.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

port=${CADENCE_APP_PORT:-3190}
host=${CADENCE_APP_HOST:-127.0.0.1}
case "$host" in
  127.0.0.1|localhost) ;;
  *)
    echo "dev-preview: preview must bind loopback, got $host" >&2
    exit 2
    ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/minutes-preview.XXXXXX")
out=$tmp/frame
server=
cleanup() {
  if [ -n "$server" ]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

cadence=${CADENCE_BIN:-cadence}
"$cadence" app frame-kit --bundle "$root/app" --out "$out" >/dev/null
cp "$out/frame.html" "$out/index.html"

python3 -m http.server "$port" --bind 127.0.0.1 --directory "$out" &
server=$!
wait "$server"
