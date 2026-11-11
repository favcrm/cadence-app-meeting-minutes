#!/usr/bin/env python3
"""Accept a native app-check report only for the hosted-only storage refusal.

The native checker refuses `app-storage: [1]`; that is the one refusal a hosted
release may proceed with. Every other content refusal is a failed check: the
report still carries a digest and inventory, but those are metadata, not
installability or safety.

Usage: assert-app-check.py [report.json]
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/app-check.json"
try:
    report = json.load(open(path, encoding="utf-8"))
except (OSError, ValueError) as error:
    print(f"app check report is unreadable: {error}", file=sys.stderr)
    sys.exit(1)
if not isinstance(report, dict):
    print("app check report is not an object", file=sys.stderr)
    sys.exit(1)
if report.get("ok") is True:
    print("app check passed")
    sys.exit(0)

checks = ((report.get("compatibility") or {}).get("checks")) or []
bad = {check.get("contract") for check in checks if not check.get("ok")}
refusal = ((report.get("refusal") or {}).get("message")) or ""
digest = report.get("digest")
files = report.get("files")
if (
    bad == {"app-storage"}
    and "app-storage" in refusal
    and isinstance(digest, str)
    and digest.startswith("sha256:")
    and isinstance(files, list)
    and files
):
    print("app-storage is hosted-only; the native refusal is metadata-only")
    sys.exit(0)
print("app check refused for an unaccepted reason: " + (refusal or repr(report)), file=sys.stderr)
sys.exit(1)
