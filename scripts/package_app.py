#!/usr/bin/env python3
"""Deterministic packaging and verification for the ``app/`` bundle.

CMM-8: builds the ``app/`` tree into a versioned ``.tar.gz`` release archive
plus a SHA256 sidecar under ``dist/``, or verifies a previously built archive
against the bundle.

Scope and honesty notes:

* This tool packages the bundle *bytes* only. The SHA256 sidecar is an
  integrity digest of the archive — it is NOT the Cadence host bundle digest
  (`sha256:...` from `app check`), never a signature, and no authorization or
  approval evidence.
* The structural checks mirror the *shape* rules the host loader applies in
  `src/issue/app.rs` (`bundle_files` + `parse_manifest`), including flat
  `assets/*.svg`, bounded `screens/minutes/`, and `app-storage/v1` migrations.
* Native Cadence refuses `app-storage: [1]`; this offline check proves member
  and grammar integrity only, never runtime schema execution or installation.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

MANIFEST = "app.md"
ROOT_DESCRIPTORS = ("app-actions.json", "app-assistant.json", "app-chat.json", "app-storage.json")
DESCRIPTOR_CONTRACTS = {
    "app-actions.json": "app-actions/v1",
    "app-assistant.json": "app-assistant/v1",
    "app-chat.json": "app-chat/v1",
    "app-storage.json": "app-storage/v1",
}
TOP_DIRS = ("workflows", "rubrics", "templates", "views", "bindings", "screens", "storage", "assets", "skills")
SKILL_DIR = "skills"
SKILL_MANIFEST = "skill.json"
SKILL_ENTRY = "SKILL.md"
SKILL_FILES_MAX = 16
SKILL_FILE_BYTES = 16 * 1024
SKILL_MANIFEST_BYTES = 4 * 1024
SKILL_PACKAGE_BYTES = 32 * 1024
SKILL_ROOT_EXTS = ("md", "txt", "json", "yaml", "yml", "csv", "css", "svg")
SKILL_NESTED_EXTS = {"scripts": ("py", "sh", "js", "mjs"), "references": ("md", "txt")}
SKILL_ALL_EXTS = SKILL_ROOT_EXTS + SKILL_NESTED_EXTS["scripts"]
SKILL_TOKEN_RE = re.compile(r"[A-Za-z0-9._/-]+")
STORAGE_DESCRIPTOR = "app-storage.json"
STORAGE_DIR = "storage"
STORAGE_CONTRACT = "app-storage/v1"
SCREEN_DIR = "screens/minutes"
EXPECTED_APP = "meeting-minutes"

MAX_STORAGE_DESCRIPTOR_BYTES = 32 * 1024
MAX_MIGRATION_BYTES = 64 * 1024
MAX_STORAGE_BYTES = 256 * 1024
MAX_MIGRATIONS = 128
MAX_RECORD_BYTES = 256 * 1024
MAX_STORAGE_TABLES = 64
MAX_TABLE_COLUMNS = 64
MAX_TABLE_INDEXES = 32
MAX_MIGRATION_OPS = 128
MAX_PLAN_OPS = 512
STORAGE_IDENT_RE = re.compile(r"[a-z][a-z0-9_]{0,62}\Z")
RECORD_KIND_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z")
COLUMN_FORMATS = ("email", "phone", "tag")
MAX_JSON_SCHEMA_BYTES = 8 * 1024
MAX_JSON_SCHEMA_DEPTH = 8
MAX_JSON_SCHEMA_NODES = 128
STORAGE_PATH_RE = re.compile(r"storage/[a-z0-9][a-z0-9-]{0,31}\.json\Z")
HOST_COLUMNS = ("id", "context_id", "revision", "created_at", "updated_at")
COLUMN_TYPES = ("text", "integer", "real", "boolean", "json")
STORAGE_DESCRIPTOR_KEYS = (
    "contract",
    "app",
    "record_kind",
    "schema_version",
    "compatible_schema_versions",
    "default_table",
    "migrations",
    "record_write_schema",
    "record_search_columns",
)
OPTIONAL_DESCRIPTOR_KEYS = ("record_write_schema", "record_search_columns")
MIGRATION_KEYS = ("version", "path", "sha256")
COLUMN_KEYS = ("name", "type", "nullable", "default", "max_length", "enum", "format", "json_schema")
JSON_SCHEMA_TYPES = ("object", "array", "string", "number", "integer", "boolean", "null")
JSON_SCHEMA_SINGLE = ("items", "not", "if", "then", "else")
JSON_SCHEMA_ARRAY = ("allOf", "anyOf", "oneOf")
JSON_SCHEMA_KEYWORDS = (
    "type",
    "const",
    "enum",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
)

MANIFEST_KEYS = ("app", "title", "version", "needs", "summary", "listing")
GATED_KEYS = ("records", "actions", "ui", "settings", "actors")
NEEDS_KEYS = ("connections", "capabilities", "views", "bindings", "requires")
VIEW_CONTRACT = "app-views/v1"
BINDING_CONTRACT = "app-bindings/v1"
VIEWS_FILE = "app-views-v1.json"
BINDINGS_FILE = "app-bindings-v1.json"
MAX_FILE_BYTES = 256 * 1024
MAX_FILES = 128
MAX_APP_BYTES = 2 * 1024 * 1024
TAG_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,31}\Z")
VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")

EPOCH = 0
SIDECAR_SUFFIX = ".sha256"
ALLOWED_FORMATS = ("tar.gz", "zip")


class PackageError(Exception):
    """A refused input or failed check — printed to stderr, exit 1."""


@dataclass(frozen=True)
class Manifest:
    app: str
    title: str
    version: str
    summary: str | None
    connections: tuple[str, ...]
    view_contract: str | None
    binding_contract: str | None
    requires: tuple[tuple[str, tuple[int, ...]], ...] = ()


def _split_front(text: str, rel: str = MANIFEST) -> tuple[str, str]:
    stripped = text.removeprefix("\ufeff")
    if not (stripped.startswith("---\n") or stripped.startswith("---\r\n")):
        raise PackageError(
            f"{rel} must start with a '---' frontmatter fence — "
            "frontmatter `app`, `title`, `version` and the agent guide are required"
        )
    after_open = 5 if stripped.startswith("---\r\n") else 4
    rest = stripped[after_open:]
    for m in re.finditer(r"---", rest):
        idx = m.start()
        before_ok = idx == 0 or rest[idx - 1] == "\n"
        after = rest[idx + 3 :]
        after_ok = (
            after == ""
            or after.startswith("\n")
            or after.startswith("\r\n")
            or after.startswith(" ")
        )
        if before_ok and after_ok:
            yaml = rest[:idx]
            body = after
            if body.startswith("\r\n"):
                body = body[2:]
            elif body.startswith("\n"):
                body = body[1:]
            if body.startswith("\n"):
                body = body[1:]
            elif body.startswith("\r\n"):
                body = body[2:]
            return yaml, body
    raise PackageError(f"{rel}: frontmatter has no closing '---' fence")


def _unquote(value: str, where: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        return value[1:-1].replace("''", "'")
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        inner = value[1:-1]
        out = []
        i = 0
        escapes = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "0": "\0"}
        while i < len(inner):
            ch = inner[i]
            if ch == "\\":
                i += 1
                if i >= len(inner) or inner[i] not in escapes:
                    raise PackageError(f"{where}: unsupported escape in quoted scalar")
                out.append(escapes[inner[i]])
            else:
                out.append(ch)
            i += 1
        return "".join(out)
    if value == "" or value.startswith(("{", "[", "#", "!", "&", "*", "|", ">")):
        raise PackageError(f"{where}: expected a plain scalar value")
    value = re.sub(r"\s+#.*\Z", "", value).strip()
    if value in ("~", "null", "Null", "NULL"):
        raise PackageError(f"{where}: expected a non-empty scalar, got null")
    return value


_SCALAR_WORDS = {"true", "false", "yes", "no", "on", "off", "null", "~"}


def _refuse_nonstring_scalar(key: str, value: str | None) -> None:
    if value is None:
        return
    low = value.strip().lower()
    if low in _SCALAR_WORDS or re.fullmatch(r"[-+]?[0-9]+", low) or re.fullmatch(
        r"[-+]?[0-9]*\.[0-9]+", low
    ):
        raise PackageError(
            f"{MANIFEST} `{key}:` must be a string — `{value}` reads as a non-string scalar"
        )


def _flow_strings(value: str, where: str) -> list[str]:
    value = value.strip()
    if not (value.startswith("[") and value.endswith("]")):
        raise PackageError(f"{where} is a list of slot names — [publish, cms]")
    inner = value[1:-1].strip()
    if not inner:
        return []
    return [_unquote(tok.strip(), where) for tok in inner.split(",")]


def parse_manifest(text: str) -> Manifest:
    yaml, _body = _split_front(text)
    fields: dict[str, str | None] = {}
    needs: dict[str, str] = {}
    seen_fields: set[str] = set()
    seen_needs: set[str] = set()
    in_needs = False
    in_listing = False
    needs_child_indent: int | None = None
    needs_sub: str | None = None
    for raw_line in yaml.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if "\t" in raw_line[: len(raw_line) - len(raw_line.lstrip())]:
            raise PackageError(f"{MANIFEST} frontmatter: tab indentation refuses")
        indented = raw_line[0] == " "
        line = raw_line.strip()
        if not indented:
            in_needs = False
            in_listing = False
            needs_sub = None
            if ":" not in line:
                raise PackageError(f"{MANIFEST} frontmatter line is not a `key: value` — {line!r}")
            key, _, value = line.partition(":")
            key = key.strip()
            if key in seen_fields:
                raise PackageError(f"{MANIFEST} frontmatter key '{key}' is declared twice")
            seen_fields.add(key)
            if key in GATED_KEYS:
                raise PackageError(f"{MANIFEST} frontmatter key '{key}' is a later stage")
            if key not in MANIFEST_KEYS:
                raise PackageError(
                    f"{MANIFEST} frontmatter key '{key}' is unknown — knows {', '.join(MANIFEST_KEYS)}"
                )
            if key == "listing":
                in_listing = True
                continue
            if key == "needs":
                if value.strip() and value.strip() != "{}":
                    raise PackageError(f"{MANIFEST} `needs:` is a mapping")
                in_needs = True
                if value.strip() == "{}":
                    seen_needs.add("{}")
                continue
            raw_val = value.strip()
            is_quoted = (len(raw_val) >= 2 and raw_val[0] == "'" and raw_val[-1] == "'") or (
                len(raw_val) >= 2 and raw_val[0] == '"' and raw_val[-1] == '"'
            )
            fields[key] = _unquote(value, f"{MANIFEST} `{key}:`")
            if not is_quoted:
                _refuse_nonstring_scalar(key, fields[key])
        elif in_listing:
            continue
        elif in_needs:
            indent = len(raw_line) - len(raw_line.lstrip())
            if needs_child_indent is None:
                needs_child_indent = indent
            if ":" not in line:
                raise PackageError(f"{MANIFEST} `needs:` entry is not a `key: value` — {line!r}")
            key, _, value = line.partition(":")
            key = key.strip()
            if indent > needs_child_indent:
                if needs_sub is None or key != ("contracts" if needs_sub == "requires" else "contract"):
                    raise PackageError(f"{MANIFEST} unsupported nested needs field")
                if needs[needs_sub]:
                    raise PackageError(f"{MANIFEST} duplicate nested needs.{needs_sub} field")
                needs[needs_sub] = f"{key}:{value.strip()}"
                continue
            needs_sub = None
            if key not in NEEDS_KEYS:
                raise PackageError(f"{MANIFEST} `needs.{key}` is unknown")
            if key in seen_needs:
                raise PackageError(f"{MANIFEST} `needs.{key}` is declared twice")
            seen_needs.add(key)
            needs[key] = value.strip()
            if value.strip() == "" and key in ("views", "bindings", "requires"):
                needs_sub = key
        else:
            raise PackageError(f"{MANIFEST} frontmatter: unexpected nested content")

    if in_needs and "{}" not in seen_needs and not needs:
        raise PackageError(f"{MANIFEST} `needs:` is a mapping")

    def need(key: str, what: str) -> str:
        value = fields.get(key)
        if value is None or not value.strip():
            raise PackageError(f"{MANIFEST} needs `{key}:` — {what}")
        return value.strip()

    app = need("app", "the app name")
    _check_tag(app, "app name")
    title = need("title", "one line naming the app")
    version = need("version", "a version string like 0.3.0")
    for key, cap in (("title", 120), ("version", 40)):
        value = title if key == "title" else version
        if len(value) > cap or any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
            raise PackageError(f"{MANIFEST} `{key}:` — ≤{cap} chars, no control characters")
    summary = fields.get("summary")
    if summary is not None:
        summary = summary.strip()
        if not summary:
            summary = None
        elif len(summary) > 160 or any(ord(c) < 0x20 or ord(c) == 0x7F for c in summary):
            raise PackageError(f"{MANIFEST} `summary:` — ≤160 chars, no control characters")

    requires = ()
    if "requires" in needs:
        value = needs["requires"]
        if not value.startswith("contracts:"):
            raise PackageError("packaging supports needs.requires.contracts inline mapping")
        raw = value.removeprefix("contracts:").strip()
        if not (raw.startswith("{") and raw.endswith("}")):
            raise PackageError("needs.requires.contracts must be an inline mapping")
        entries = re.findall(r"([a-z0-9][a-z0-9-]{0,31}):\s*\[([0-9, ]+)\]", raw[1:-1])
        remainder = re.sub(r"[a-z0-9][a-z0-9-]{0,31}:\s*\[[0-9, ]+\]", "", raw[1:-1])
        if not entries or len(entries) > 16 or remainder.strip(" ,"):
            raise PackageError("invalid needs.requires.contracts mapping")
        names = set()
        parsed = []
        for name, numbers in entries:
            if not re.fullmatch(r"\s*[1-9][0-9]*(?:\s*,\s*[1-9][0-9]*)*\s*", numbers):
                raise PackageError("required majors are positive integers")
            majors = tuple(int(n.strip()) for n in numbers.split(","))
            if name in names or not 1 <= len(majors) <= 8 or min(majors) < 1 or len(set(majors)) != len(majors):
                raise PackageError("duplicate or invalid required contract/major")
            names.add(name)
            parsed.append((name, majors))
        requires = tuple(parsed)

    connections: list[str] = []
    view_contract = None
    binding_contract = None
    if "views" in needs:
        view_contract = _needs_contract(needs["views"], "views", VIEW_CONTRACT)
    if "bindings" in needs:
        binding_contract = _needs_contract(needs["bindings"], "bindings", BINDING_CONTRACT)
    if "capabilities" in needs and needs["capabilities"] not in ("{}",):
        raise PackageError(f"{MANIFEST} `needs.capabilities` accepts only `{{}}`")
    if "connections" in needs:
        for slot in _flow_strings(needs["connections"], f"{MANIFEST} `needs.connections`"):
            _check_tag(slot, "connection slot")
            if slot in connections:
                raise PackageError(f"connection slot '{slot}' is declared twice")
            connections.append(slot)

    return Manifest(
        app=app,
        title=title,
        version=version,
        summary=summary,
        connections=tuple(connections),
        view_contract=view_contract,
        binding_contract=binding_contract,
        requires=requires,
    )


def _needs_contract(value: str, key: str, expected: str) -> str:
    value = value.strip()
    if value.startswith("{"):
        inner = value.strip("{}").strip()
        parts = dict(p.strip().split(":", 1) for p in inner.split(",") if p.strip())
        contract = parts.get("contract", "").strip()
        if set(parts) != {"contract"} or not contract:
            raise PackageError(f"{MANIFEST} `needs.{key}` knows only `contract`")
    elif value.startswith("contract:"):
        contract = value.split(":", 1)[1].strip()
    else:
        raise PackageError(f"{MANIFEST} `needs.{key}` knows only `contract`")
    contract = contract.strip("'\"")
    if contract != expected:
        raise PackageError(f"{MANIFEST} `needs.{key}.contract` must be `{expected}`")
    return contract


def _check_tag(name: str, what: str) -> None:
    if not TAG_RE.match(name):
        raise PackageError(f"{what} '{name}' — 1-32 lowercase letters, digits or hyphens")


def _check_version_semver(version: str) -> None:
    if not VERSION_RE.match(version):
        raise PackageError(f"{MANIFEST} version '{version}' — release archives need major.minor.patch")


def _check_asset_leaf(name: str, where: str) -> None:
    if not name.endswith(".svg") or len(name.encode("utf-8")) > 128:
        raise PackageError(f"{where}: assets/ holds flat .svg files (≤128-byte leaf name)")
    _check_tag(name[: -len(".svg")], "asset name")


def bundle_files(root: Path) -> list[str]:
    try:
        st = os.lstat(root)
    except OSError as e:
        raise PackageError(f"cannot stat app source {root}: {e}") from e
    if stat.S_ISLNK(st.st_mode):
        raise PackageError(f"app source {root} is a symlink — an app is a real folder")
    if not stat.S_ISDIR(st.st_mode):
        raise PackageError(f"app source {root} is not a folder")

    files: list[str] = []
    dirs: list[str] = []
    manifest = False
    for entry in sorted(os.scandir(root), key=lambda e: e.name):
        name = entry.name
        _check_utf8_name(name, "app source")
        if name.startswith("."):
            if name == ".git":
                continue
            raise PackageError(f"app source entry '{name}': dotfiles are not app content")
        if entry.is_symlink():
            raise PackageError(f"app source entry '{name}': a symlink refuses")
        if entry.is_file(follow_symlinks=False):
            if name == MANIFEST:
                manifest = True
                files.append(name)
                continue
            if name in ROOT_DESCRIPTORS:
                files.append(name)
                continue
            raise PackageError(
                f"app source entry '{name}' — admits app.md, root descriptors, and {TOP_DIRS}"
            )
        if entry.is_dir(follow_symlinks=False):
            if name in TOP_DIRS:
                dirs.append(name)
                continue
            raise PackageError(
                f"app source entry '{name}' — admits app.md, root descriptors, and {TOP_DIRS}"
            )
        raise PackageError(f"app source entry '{name}': not a regular file")

    if not manifest:
        raise PackageError(f"app source {root} has no app.md")
    if "workflows" not in dirs:
        raise PackageError("an app needs workflows/")

    for top in dirs:
        if top == "screens":
            tags = sorted(os.scandir(root / top), key=lambda e: e.name)
            if (
                len(tags) != 1
                or tags[0].name != "minutes"
                or tags[0].is_symlink()
                or not tags[0].is_dir(follow_symlinks=False)
            ):
                raise PackageError("screens/ holds only the real minutes/ screen directory")
            for entry in sorted(os.scandir(root / SCREEN_DIR), key=lambda e: e.name):
                rel = f"{SCREEN_DIR}/{entry.name}"
                if (
                    entry.is_symlink()
                    or not entry.is_file(follow_symlinks=False)
                    or not screen_leaf(entry.name)
                ):
                    raise PackageError(f"invalid screen member {rel}")
                files.append(rel)
            continue
        if top == SKILL_DIR:
            files.extend(_skill_source_files(root))
            continue
        for entry in sorted(os.scandir(root / top), key=lambda e: e.name):
            name = entry.name
            rel = f"{top}/{name}"
            _check_utf8_name(name, top)
            if name.startswith("."):
                raise PackageError(f"app source entry '{rel}': dotfiles are not app content")
            if entry.is_symlink():
                raise PackageError(f"app source entry '{rel}': a symlink refuses")
            if entry.is_dir(follow_symlinks=False):
                raise PackageError(f"app source entry '{rel}': app dirs are flat")
            if not entry.is_file(follow_symlinks=False):
                raise PackageError(f"app source entry '{rel}': not a regular file")
            if top == "storage":
                if not name.endswith(".json") or not STORAGE_PATH_RE.fullmatch(rel):
                    raise PackageError(f"app source entry '{rel}': storage holds flat storage/<tag>.json")
            if top == "assets":
                _check_asset_leaf(name, f"app source entry '{rel}'")
            if top == "workflows":
                if not name.endswith(".md"):
                    raise PackageError(f"app source entry '{rel}': workflows end in .md")
                _check_tag(name[: -len(".md")], "workflow name")
            if top == "views" and name != VIEWS_FILE:
                raise PackageError(f"app source entry '{rel}': views/ holds {VIEWS_FILE}")
            if top == "bindings" and name != BINDINGS_FILE:
                raise PackageError(f"app source entry '{rel}': bindings/ holds {BINDINGS_FILE}")
            files.append(rel)

    if len(files) > MAX_FILES:
        raise PackageError(f"app carries {len(files)} files — at most {MAX_FILES}")
    total = 0
    for rel in files:
        size = os.lstat(root / rel).st_size
        if size > file_cap(rel):
            raise PackageError(f"{rel} is {size} bytes — at most {file_cap(rel)}")
        total += size
        if total > MAX_APP_BYTES:
            raise PackageError(f"app is over {MAX_APP_BYTES} bytes of content")
    files.sort()
    return files


def _skill_source_files(root: Path) -> list[str]:
    found: list[str] = []
    for tag_entry in sorted(os.scandir(root / SKILL_DIR), key=lambda e: e.name):
        tag = tag_entry.name
        _check_utf8_name(tag, SKILL_DIR)
        if tag_entry.is_symlink() or not tag_entry.is_dir(follow_symlinks=False):
            raise PackageError(
                f"app source entry 'skills/{tag}' — a skill package is a skills/<tag>/ directory"
            )
        for entry in sorted(os.scandir(root / SKILL_DIR / tag), key=lambda e: e.name):
            name = entry.name
            rel = f"{SKILL_DIR}/{tag}/{name}"
            _check_utf8_name(name, rel)
            if name.startswith("."):
                raise PackageError(f"app source entry '{rel}': dotfiles are not app content")
            if entry.is_symlink():
                raise PackageError(f"app source entry '{rel}': a symlink refuses")
            if entry.is_dir(follow_symlinks=False):
                if name not in SKILL_NESTED_EXTS:
                    raise PackageError(
                        f"app source entry '{rel}': a skill package nests only scripts/ and references/"
                    )
                for leaf in sorted(os.scandir(root / SKILL_DIR / tag / name), key=lambda e: e.name):
                    leaf_rel = f"{rel}/{leaf.name}"
                    _check_utf8_name(leaf.name, leaf_rel)
                    if leaf.name.startswith("."):
                        raise PackageError(f"app source entry '{leaf_rel}': dotfiles are not app content")
                    if leaf.is_symlink() or not leaf.is_file(follow_symlinks=False):
                        raise PackageError(f"app source entry '{leaf_rel}': a skill member is a regular file")
                    found.append(leaf_rel)
                continue
            if not entry.is_file(follow_symlinks=False):
                raise PackageError(f"app source entry '{rel}': not a regular file")
            found.append(rel)
    return found


def _skill_leaf_ok(name: str, exts: tuple[str, ...]) -> bool:
    if not name or not name.isascii() or name.startswith(".") or "\\" in name or "\0" in name:
        return False
    return any(name.endswith(f".{ext}") and len(name) > len(ext) + 1 for ext in exts)


def skill_member_ok(member: str) -> bool:
    if not member or not member.isascii() or "\\" in member or "\0" in member:
        return False
    segments = member.split("/")
    if len(segments) == 1:
        return _skill_leaf_ok(segments[0], SKILL_ROOT_EXTS)
    if len(segments) == 2:
        exts = SKILL_NESTED_EXTS.get(segments[0])
        return exts is not None and _skill_leaf_ok(segments[1], exts)
    return False


def screen_leaf(name: str) -> bool:
    return (
        name == "screens.json"
        or re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}\.(js|css|svg|json)", name) is not None
    )


def file_cap(rel: str) -> int:
    if rel.startswith(f"{SKILL_DIR}/"):
        return (
            SKILL_MANIFEST_BYTES
            if rel.count("/") == 2 and rel.endswith(f"/{SKILL_MANIFEST}")
            else SKILL_FILE_BYTES
        )
    if rel == STORAGE_DESCRIPTOR:
        return MAX_STORAGE_DESCRIPTOR_BYTES
    if rel.startswith(f"{STORAGE_DIR}/"):
        return MAX_MIGRATION_BYTES
    if rel.startswith(f"{SCREEN_DIR}/") and rel.count("/") == 2:
        if rel == f"{SCREEN_DIR}/screens.json":
            return 32768
        return 2097152
    return MAX_FILE_BYTES


def check_screen_bytes(contents: list[tuple[str, bytes]], where: str) -> None:
    screen = {
        rel.removeprefix(f"{SCREEN_DIR}/"): data
        for rel, data in contents
        if rel.startswith(f"{SCREEN_DIR}/")
    }
    if not screen:
        return

    def closed_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PackageError(f"{where}: duplicate screen JSON field {key}")
            result[key] = value
        return result

    try:
        raw = screen.pop("screens.json")
        if len(raw) > 32768:
            raise PackageError("screen manifest exceeds 32768 bytes")
        decl = json.loads(raw.decode("utf-8"), object_pairs_hook=closed_pairs)
        assets = decl["assets"]
        if (
            decl["app"] != EXPECTED_APP
            or decl["contract"] != "app-screens/v2"
            or decl["host_contract"] != "screen-records.v1"
            or decl["entry"] != "client.js"
        ):
            raise PackageError("Meeting minutes screen contract mismatch")
        if not isinstance(assets, list) or not 1 <= len(assets) <= 32 or sum(map(len, screen.values())) > 2097152:
            raise PackageError("screen asset count/total exceeds bounds")
        names = set()
        media = {
            "js": "text/javascript",
            "css": "text/css",
            "svg": "image/svg+xml",
            "json": "application/json",
        }
        for asset in assets:
            name = asset["name"]
            if (
                set(asset) != {"name", "size", "sha256", "media_type"}
                or name in names
                or not screen_leaf(name)
                or name == "screens.json"
            ):
                raise PackageError("invalid/duplicate screen asset")
            names.add(name)
            data = screen[name]
            text = data.decode("utf-8")
            if name.endswith(".js") and re.search(r"</script|<!--|-->", text, re.IGNORECASE):
                raise PackageError(f"unsafe inline screen script: {name}")
            if (
                type(asset["size"]) is not int
                or asset["size"] != len(data)
                or len(data) > file_cap(f"{SCREEN_DIR}/{name}")
                or asset["sha256"] != "sha256:" + sha256_hex(data)
                or asset["media_type"] != media[name.rsplit(".", 1)[1]]
            ):
                raise PackageError(f"screen asset integrity mismatch: {name}")
        if names != set(screen) or "client.js" not in names:
            raise PackageError("missing/unspecified screen assets")
        if "startup" in decl:
            startup = decl["startup"]
            scripts = {a["name"] for a in assets if a["media_type"] == "text/javascript"}
            if (
                not isinstance(startup, list)
                or not 2 <= len(startup) <= 32
                or any(not isinstance(n, str) for n in startup)
                or len(set(startup)) != len(startup)
                or set(startup) != scripts
                or startup[-1] != decl["entry"]
            ):
                raise PackageError("startup must name all JavaScript assets once, entry last")
            manifest = parse_manifest(dict(contents)[MANIFEST].decode("utf-8"))
            if ("screen-startup", (1,)) not in manifest.requires:
                raise PackageError("startup requires needs.requires.contracts screen-startup: [1]")
    except (KeyError, TypeError, ValueError, UnicodeDecodeError) as e:
        raise PackageError(f"{where}: invalid screen declaration: {e}") from e


def _check_utf8_name(name: str, where: str) -> None:
    try:
        name.encode("utf-8")
    except UnicodeEncodeError as e:
        raise PackageError(f"{where} carries a file name that is not UTF-8") from e


def _storage_json(raw: bytes, where: str, rel: str) -> object:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise PackageError(f"{where}: {rel}: not UTF-8 text") from e

    def closed(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate field {key}")
            result[key] = value
        return result

    try:
        return json.loads(text, object_pairs_hook=closed)
    except ValueError as e:
        raise PackageError(f"{where}: {rel}: not valid JSON — {e}") from e


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_scalar(value: object) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _scalar_matches(value: object, ctype: str) -> bool:
    if ctype == "text":
        return isinstance(value, str)
    if ctype == "integer":
        return _is_int(value)
    if ctype == "real":
        return _is_number(value)
    if ctype == "boolean":
        return isinstance(value, bool)
    return False


def _enum_matches(value: object, enum: list) -> bool:
    return any(type(value) is type(item) and value == item for item in enum)


def _storage_value_ok(value: object, column: dict, where: str, what: str) -> None:
    ctype = column["type"]
    if ctype == "json" or value is None:
        return
    if not _scalar_matches(value, ctype):
        raise PackageError(f"{where}: {what} does not match column type '{ctype}'")
    cap = column.get("max_length")
    if ctype == "text" and cap is not None and len(value) > cap:
        raise PackageError(f"{where}: {what} exceeds max_length {cap}")
    if "enum" in column and not _enum_matches(value, column["enum"]):
        raise PackageError(f"{where}: {what} is not one of the declared enum values")


def _storage_json_schema(schema: object, where: str, what: str) -> None:
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise PackageError(f"{where}: {what} is a JSON Schema object or boolean")
    try:
        encoded = json.dumps(schema, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as e:
        raise PackageError(f"{where}: {what} is not serializable JSON — {e}") from e
    if len(encoded) > MAX_JSON_SCHEMA_BYTES:
        raise PackageError(f"{where}: {what} exceeds {MAX_JSON_SCHEMA_BYTES} bytes")
    nodes = 0

    def walk(node: object, depth: int) -> None:
        nonlocal nodes
        if depth > MAX_JSON_SCHEMA_DEPTH:
            raise PackageError(f"{where}: {what} nests deeper than {MAX_JSON_SCHEMA_DEPTH}")
        nodes += 1
        if nodes > MAX_JSON_SCHEMA_NODES:
            raise PackageError(f"{where}: {what} exceeds {MAX_JSON_SCHEMA_NODES} schema nodes")
        if isinstance(node, bool):
            return
        if not isinstance(node, dict):
            raise PackageError(f"{where}: {what} has a non-schema value")
        for key, value in node.items():
            if key not in JSON_SCHEMA_KEYWORDS:
                raise PackageError(f"{where}: {what} uses unsupported JSON Schema keyword {key!r}")
            if key in JSON_SCHEMA_SINGLE:
                walk(value, depth + 1)
            elif key in JSON_SCHEMA_ARRAY:
                if not isinstance(value, list) or not 1 <= len(value) <= 16:
                    raise PackageError(f"{where}: {what} keyword {key!r} carries 1–16 schemas")
                for item in value:
                    walk(item, depth + 1)
            elif key == "properties":
                if not isinstance(value, dict) or len(value) > 64:
                    raise PackageError(f"{where}: {what} properties is an object of ≤64 schemas")
                for name, child in value.items():
                    if (
                        not isinstance(name, str)
                        or len(name) > 64
                        or any(ord(c) < 0x20 or ord(c) > 0x7E for c in name)
                        or name in ("__proto__", "constructor", "prototype")
                    ):
                        raise PackageError(f"{where}: {what} has an unsupported property name")
                    walk(child, depth + 1)
            elif key == "type":
                if value not in JSON_SCHEMA_TYPES:
                    raise PackageError(f"{where}: {what} type is one of {JSON_SCHEMA_TYPES}")
            elif key == "enum":
                if (
                    not isinstance(value, list)
                    or not 1 <= len(value) <= 64
                    or any(not _is_scalar(item) for item in value)
                    or len({json.dumps(item, sort_keys=True) for item in value}) != len(value)
                ):
                    raise PackageError(f"{where}: {what} enum is 1–64 unique scalars")
            elif key == "const":
                if not _is_scalar(value):
                    raise PackageError(f"{where}: {what} const is a scalar")
            elif key == "required":
                if (
                    not isinstance(value, list)
                    or len(value) > 64
                    or any(not isinstance(item, str) or len(item) > 64 for item in value)
                ):
                    raise PackageError(f"{where}: {what} required is ≤64 property names")
            elif key == "additionalProperties":
                if not isinstance(value, bool):
                    walk(value, depth + 1)
            elif key in ("minItems", "maxItems", "minLength", "maxLength"):
                if not _is_int(value) or value < 0:
                    raise PackageError(f"{where}: {what} {key} is a non-negative integer")
            elif key == "uniqueItems":
                if not isinstance(value, bool):
                    raise PackageError(f"{where}: {what} uniqueItems is a boolean")
            elif key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"):
                if not _is_number(value):
                    raise PackageError(f"{where}: {what} {key} is a number")
            elif key == "pattern":
                if not isinstance(value, str) or len(value) > 256:
                    raise PackageError(f"{where}: {what} pattern is a bounded string")
        if ("then" in node or "else" in node) and "if" not in node:
            raise PackageError(f"{where}: {what} then/else requires if")
        if "if" in node and "then" not in node and "else" not in node:
            raise PackageError(f"{where}: {what} if requires then or else")

    walk(schema, 1)


def _storage_column(column: object, where: str, table: str) -> dict:
    if not isinstance(column, dict):
        raise PackageError(f"{where}: table '{table}' column is not an object")
    unknown = set(column) - set(COLUMN_KEYS)
    if unknown:
        raise PackageError(f"{where}: column has unknown field(s) {sorted(unknown)}")
    for key in ("name", "type", "nullable"):
        if key not in column:
            raise PackageError(f"{where}: every column declares name/type/nullable")
    name = column["name"]
    if not isinstance(name, str) or not STORAGE_IDENT_RE.fullmatch(name):
        raise PackageError(f"{where}: column name is not a lowercase identifier")
    if name in HOST_COLUMNS:
        raise PackageError(f"{where}: column '{name}' is host-owned")
    ctype = column["type"]
    if ctype not in COLUMN_TYPES:
        raise PackageError(f"{where}: column '{name}' has unsupported type {ctype!r}")
    if not isinstance(column["nullable"], bool):
        raise PackageError(f"{where}: column '{name}' nullable is a boolean")
    if "max_length" in column:
        cap = column["max_length"]
        if not _is_int(cap) or cap < 1 or ctype != "text":
            raise PackageError(f"{where}: column '{name}' max_length invalid")
    if "enum" in column:
        enum = column["enum"]
        if ctype == "json" or not isinstance(enum, list) or not 1 <= len(enum) <= 32:
            raise PackageError(f"{where}: column '{name}' enum invalid")
        seen = []
        for item in enum:
            if item is None or not _scalar_matches(item, ctype) or _enum_matches(item, seen):
                raise PackageError(f"{where}: column '{name}' enum entry invalid")
            seen.append(item)
    if "default" in column:
        value = column["default"]
        if value is None and not column["nullable"]:
            raise PackageError(f"{where}: non-null column '{name}' cannot default to null")
        _storage_value_ok(value, column, where, f"column '{name}' default")
    if "format" in column:
        if ctype != "text" or column["format"] not in COLUMN_FORMATS:
            raise PackageError(f"{where}: column '{name}' format invalid")
    if "json_schema" in column:
        if ctype != "json":
            raise PackageError(f"{where}: column '{name}' json_schema requires json column")
        _storage_json_schema(column["json_schema"], where, f"column '{name}' json_schema")
    return column


def _storage_apply_op(model: dict, op: object, where: str, migration: str) -> None:
    if not isinstance(op, dict):
        raise PackageError(f"{where}: {migration}: operation is not an object")
    kind = op.get("op")
    if kind == "create_table":
        if set(op) not in ({"op", "table", "columns"}, {"op", "table", "columns", "record_bytes"}):
            raise PackageError(f"{where}: {migration}: create_table fields are closed")
        table = op["table"]
        if not isinstance(table, str) or not STORAGE_IDENT_RE.fullmatch(table):
            raise PackageError(f"{where}: {migration}: invalid table name")
        record_bytes = op.get("record_bytes")
        if "record_bytes" in op and (
            not _is_int(record_bytes) or not 1 <= record_bytes <= MAX_RECORD_BYTES
        ):
            raise PackageError(f"{where}: {migration}: record_bytes out of bounds")
        if table in model or len(model) >= MAX_STORAGE_TABLES:
            raise PackageError(f"{where}: {migration}: duplicate/excess table '{table}'")
        columns = op["columns"]
        if not isinstance(columns, list) or len(columns) > MAX_TABLE_COLUMNS:
            raise PackageError(f"{where}: {migration}: table '{table}' column count invalid")
        declared: dict[str, dict] = {}
        for column in columns:
            entry = _storage_column(column, where, table)
            if entry["name"] in declared:
                raise PackageError(f"{where}: {migration}: duplicate column '{entry['name']}'")
            declared[entry["name"]] = entry
        model[table] = {"columns": declared, "indexes": {}, "record_bytes": record_bytes}
        return
    if kind == "add_column":
        if set(op) != {"op", "table", "column"}:
            raise PackageError(f"{where}: {migration}: add_column fields are closed")
        table = op["table"]
        target = model.get(table) if isinstance(table, str) else None
        if target is None:
            raise PackageError(f"{where}: {migration}: unknown table {table!r}")
        entry = _storage_column(op["column"], where, table)
        if entry["name"] in target["columns"]:
            raise PackageError(f"{where}: {migration}: column '{entry['name']}' exists")
        if not entry["nullable"] and "default" not in entry:
            raise PackageError(f"{where}: {migration}: non-null added column requires default")
        if len(target["columns"]) >= MAX_TABLE_COLUMNS:
            raise PackageError(f"{where}: {migration}: too many columns")
        target["columns"][entry["name"]] = entry
        return
    if kind == "create_index":
        if set(op) != {"op", "table", "name", "columns", "unique"}:
            raise PackageError(f"{where}: {migration}: create_index fields are closed")
        table = op["table"]
        target = model.get(table) if isinstance(table, str) else None
        if target is None:
            raise PackageError(f"{where}: {migration}: unknown table {table!r}")
        name = op["name"]
        if (
            not isinstance(name, str)
            or not STORAGE_IDENT_RE.fullmatch(name)
            or name in target["indexes"]
            or not isinstance(op["unique"], bool)
        ):
            raise PackageError(f"{where}: {migration}: invalid index '{name}'")
        columns = op["columns"]
        if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_TABLE_COLUMNS:
            raise PackageError(f"{where}: {migration}: invalid index columns")
        seen: list[str] = []
        for column in columns:
            if not isinstance(column, str) or column not in target["columns"] or column in seen:
                raise PackageError(f"{where}: {migration}: invalid index column {column!r}")
            seen.append(column)
        if len(target["indexes"]) >= MAX_TABLE_INDEXES:
            raise PackageError(f"{where}: {migration}: too many indexes")
        target["indexes"][name] = {"columns": seen, "unique": op["unique"]}
        return
    if kind == "backfill":
        if set(op) != {"op", "table", "column", "value", "only_null"}:
            raise PackageError(f"{where}: {migration}: backfill fields are closed")
        table = op["table"]
        target = model.get(table) if isinstance(table, str) else None
        column = op["column"]
        entry = target["columns"].get(column) if target and isinstance(column, str) else None
        if entry is None or not isinstance(op["only_null"], bool):
            raise PackageError(f"{where}: {migration}: invalid backfill")
        value = op["value"]
        if value is not None and not _scalar_matches(value, entry["type"]) and entry["type"] != "json":
            raise PackageError(f"{where}: {migration}: backfill value mismatch")
        _storage_value_ok(value, entry, where, f"backfill value for '{column}'")
        return
    raise PackageError(f"{where}: {migration}: unknown storage operation {kind!r}")


def _check_app_storage(
    contents: list[tuple[str, bytes]], where: str, app: str | None = None
) -> None:
    mapping = dict(contents)
    storage_paths = sorted(rel for rel in mapping if rel.startswith(f"{STORAGE_DIR}/"))
    if STORAGE_DESCRIPTOR not in mapping:
        if storage_paths:
            raise PackageError(f"{where}: storage/ exists without {STORAGE_DESCRIPTOR}")
        return
    raw = mapping[STORAGE_DESCRIPTOR]
    if len(raw) > MAX_STORAGE_DESCRIPTOR_BYTES:
        raise PackageError(f"{where}: {STORAGE_DESCRIPTOR} exceeds {MAX_STORAGE_DESCRIPTOR_BYTES} bytes")
    doc = _storage_json(raw, where, STORAGE_DESCRIPTOR)
    if not isinstance(doc, dict):
        raise PackageError(f"{where}: {STORAGE_DESCRIPTOR} is not a JSON object")
    unknown = set(doc) - set(STORAGE_DESCRIPTOR_KEYS)
    missing = set(STORAGE_DESCRIPTOR_KEYS) - set(doc) - set(OPTIONAL_DESCRIPTOR_KEYS)
    if unknown or missing:
        raise PackageError(f"{where}: {STORAGE_DESCRIPTOR} fields are closed")
    if doc["contract"] != STORAGE_CONTRACT:
        raise PackageError(f'{where}: {STORAGE_DESCRIPTOR} contract must be "{STORAGE_CONTRACT}"')
    descriptor_app = doc["app"]
    if not isinstance(descriptor_app, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", descriptor_app):
        raise PackageError(f"{where}: {STORAGE_DESCRIPTOR} app is not a tag")
    if app is not None and descriptor_app != app:
        raise PackageError(f"{where}: {STORAGE_DESCRIPTOR} app '{descriptor_app}' != '{app}'")
    record_kind = doc["record_kind"]
    if not isinstance(record_kind, str) or not RECORD_KIND_RE.fullmatch(record_kind):
        raise PackageError(f"{where}: {STORAGE_DESCRIPTOR} record_kind invalid")
    if "record_write_schema" in doc:
        _storage_json_schema(doc["record_write_schema"], where, f"{STORAGE_DESCRIPTOR} record_write_schema")
    schema_version = doc["schema_version"]
    if not _is_int(schema_version) or not 1 <= schema_version <= MAX_MIGRATIONS:
        raise PackageError(f"{where}: invalid schema_version")
    compatible = doc["compatible_schema_versions"]
    if (
        not isinstance(compatible, list)
        or not 1 <= len(compatible) <= 16
        or any(not _is_int(v) or not 1 <= v <= schema_version for v in compatible)
        or len(set(compatible)) != len(compatible)
        or schema_version not in compatible
    ):
        raise PackageError(f"{where}: invalid compatible_schema_versions")
    default_table = doc["default_table"]
    if not isinstance(default_table, str) or not STORAGE_IDENT_RE.fullmatch(default_table):
        raise PackageError(f"{where}: invalid default_table")

    migrations = doc["migrations"]
    if not isinstance(migrations, list) or len(migrations) != schema_version:
        raise PackageError(f"{where}: migrations must cover 1..{schema_version}")
    declared_paths: list[str] = []
    model: dict[str, dict] = {}
    total_ops = 0
    total_bytes = 0
    for expected_version, entry in enumerate(migrations, start=1):
        if not isinstance(entry, dict) or set(entry) != set(MIGRATION_KEYS):
            raise PackageError(f"{where}: migration entries are closed")
        version = entry["version"]
        path = entry["path"]
        digest = entry["sha256"]
        if version != expected_version or not _is_int(version):
            raise PackageError(f"{where}: migration versions must be contiguous")
        if not isinstance(path, str) or not STORAGE_PATH_RE.fullmatch(path) or path in declared_paths:
            raise PackageError(f"{where}: invalid/duplicate migration path {path!r}")
        declared_paths.append(path)
        if path not in mapping:
            raise PackageError(f"{where}: missing migration '{path}'")
        data = mapping[path]
        if len(data) > MAX_MIGRATION_BYTES:
            raise PackageError(f"{where}: {path} exceeds {MAX_MIGRATION_BYTES} bytes")
        total_bytes += len(data)
        if total_bytes > MAX_STORAGE_BYTES:
            raise PackageError(f"{where}: migrations exceed {MAX_STORAGE_BYTES} bytes")
        if (
            not isinstance(digest, str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
            or digest != f"sha256:{sha256_hex(data)}"
        ):
            raise PackageError(f"{where}: {path}: declared sha256 mismatch")
        migration = _storage_json(data, where, path)
        if not isinstance(migration, dict) or set(migration) != {"version", "operations"}:
            raise PackageError(f"{where}: {path}: invalid migration object")
        if migration["version"] != version:
            raise PackageError(f"{where}: {path}: version mismatch")
        operations = migration["operations"]
        if not isinstance(operations, list) or len(operations) > MAX_MIGRATION_OPS:
            raise PackageError(f"{where}: {path}: too many operations")
        total_ops += len(operations)
        if total_ops > MAX_PLAN_OPS:
            raise PackageError(f"{where}: plan exceeds {MAX_PLAN_OPS} operations")
        for op in operations:
            _storage_apply_op(model, op, where, path)

    if sorted(declared_paths) != storage_paths:
        raise PackageError(f"{where}: undeclared storage member(s)")
    if default_table not in model:
        raise PackageError(f"{where}: default_table '{default_table}' undeclared")
    if "record_search_columns" in doc:
        search = doc["record_search_columns"]
        target = model[default_table]["columns"]
        if not isinstance(search, list) or not 1 <= len(search) <= MAX_TABLE_COLUMNS:
            raise PackageError(f"{where}: invalid record_search_columns")
        seen: list[str] = []
        for name in search:
            column = target.get(name) if isinstance(name, str) else None
            if (
                column is None
                or not STORAGE_IDENT_RE.fullmatch(name)
                or column["type"] not in ("text", "json")
                or name in seen
            ):
                raise PackageError(f"{where}: invalid search column {name!r}")
            seen.append(name)


def _skill_references(text: str, tag: str) -> list[tuple[str, str, bool, str]]:
    found = []
    for raw in SKILL_TOKEN_RE.findall(text):
        token = raw.rstrip(".")
        if not token:
            continue
        absolute = token.startswith("/") and not token.startswith(".")
        escaped = False
        segments = []
        for segment in token.split("/"):
            if segment in ("", "."):
                continue
            if segment == "..":
                escaped = True
            else:
                segments.append(segment)
        if not segments or absolute:
            continue
        path = "/".join(segments)
        if path.startswith(f"{SKILL_DIR}/"):
            owner, sep, member = path[len(SKILL_DIR) + 1 :].partition("/")
            if sep:
                found.append((owner, member, escaped, token))
            continue
        if any(path.startswith(f"{directory}/") for directory in SKILL_NESTED_EXTS):
            found.append((tag, path, escaped, token))
            continue
        if "/" in path or "." not in path:
            continue
        if path.rsplit(".", 1)[1] not in SKILL_ALL_EXTS:
            continue
        found.append((tag, path, escaped, token))
    return found


def _check_skill_package(tag: str, files: dict[str, str], where: str) -> None:
    prefix = f"{SKILL_DIR}/{tag}"
    if not TAG_RE.fullmatch(tag):
        raise PackageError(f"{where}: skill package '{tag}' — [a-z0-9-], at most 32 bytes")
    if SKILL_MANIFEST not in files:
        raise PackageError(f"{where}: skill package '{tag}' needs {prefix}/{SKILL_MANIFEST}")
    manifest_text = files[SKILL_MANIFEST]
    if len(manifest_text.encode("utf-8")) > SKILL_MANIFEST_BYTES:
        raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} exceeds {SKILL_MANIFEST_BYTES} bytes")

    def closed(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} repeats field {key!r}")
            result[key] = value
        return result

    try:
        manifest = json.loads(manifest_text, object_pairs_hook=closed)
    except ValueError as e:
        raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST}: {e}") from e
    if not isinstance(manifest, dict) or set(manifest) != {"schema", "name", "files"}:
        raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} holds exactly schema, name and files")
    if type(manifest["schema"]) is not int or manifest["schema"] != 1:
        raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} schema must be integer 1")
    if manifest["name"] != tag:
        raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} name must match '{tag}'")
    declared = manifest["files"]
    if not isinstance(declared, list) or not declared:
        raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} declares no files")
    if len(declared) > SKILL_FILES_MAX:
        raise PackageError(f"{where}: {prefix} declares more than {SKILL_FILES_MAX} files")
    seen: list[str] = []
    for member in declared:
        if not isinstance(member, str):
            raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} files must all be strings")
        if member == SKILL_MANIFEST:
            raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} lists itself")
        if not skill_member_ok(member):
            raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} declares invalid member '{member}'")
        if member in seen:
            raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} declares '{member}' twice")
        seen.append(member)
    if SKILL_ENTRY not in seen:
        raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} must declare {SKILL_ENTRY}")
    for member in files:
        if not skill_member_ok(member):
            raise PackageError(f"{where}: {prefix}/{member} is not a package member")
    for member in seen:
        if member not in files:
            raise PackageError(f"{where}: {prefix}/{SKILL_MANIFEST} declares missing '{member}'")
    for member in files:
        if member != SKILL_MANIFEST and member not in seen:
            raise PackageError(f"{where}: {prefix}/{member} is undeclared in {prefix}/{SKILL_MANIFEST}")
    total = len(manifest_text.encode("utf-8"))
    for member in seen:
        size = len(files[member].encode("utf-8"))
        if size > SKILL_FILE_BYTES:
            raise PackageError(f"{where}: {prefix}/{member} exceeds {SKILL_FILE_BYTES} bytes")
        total += size
    if total > SKILL_PACKAGE_BYTES:
        raise PackageError(f"{where}: {prefix} exceeds {SKILL_PACKAGE_BYTES} bytes")
    for member in seen:
        for owner, ref, escaped, token in _skill_references(files[member], tag):
            if escaped:
                raise PackageError(f"{where}: {prefix}/{member}: '{token}' reaches '..'")
            if owner != tag:
                raise PackageError(f"{where}: {prefix}/{member}: '{token}' names skill '{owner}'")
            if ref not in seen:
                raise PackageError(
                    f"{where}: {prefix}/{member}: '{token}' is undeclared in {prefix}/{SKILL_MANIFEST}"
                )


def _check_skills(contents: list[tuple[str, bytes]], where: str) -> None:
    packages: dict[str, dict[str, str]] = {}
    for rel, data in contents:
        if not rel.startswith(f"{SKILL_DIR}/"):
            continue
        parts = rel.split("/", 2)
        if len(parts) != 3:
            raise PackageError(f"{where}: {rel} — a skill package is a skills/<tag>/ directory")
        packages.setdefault(parts[1], {})[parts[2]] = data.decode("utf-8")
    for tag in sorted(packages):
        _check_skill_package(tag, packages[tag], where)


def check_pairing(manifest: Manifest, files: list[str], where: str) -> None:
    present = set(files)
    if "app-actions.json" in present and "app-assistant.json" not in present:
        raise PackageError(f"{where}: app-actions.json carries no paired app-assistant.json")
    screen_members = [f for f in files if f.startswith("screens/")]
    if screen_members:
        if f"{SCREEN_DIR}/screens.json" not in present or any(
            (name, (1,)) not in manifest.requires for name in ("app-screens", "screen-records")
        ):
            raise PackageError(
                f"{where}: Meeting minutes screen needs {SCREEN_DIR}/screens.json and app-screens/screen-records: [1]"
            )
    elif any(name in ("screen-records", "screen-startup") for name, _ in manifest.requires):
        raise PackageError(f"{where}: screen-records/startup demand requires {SCREEN_DIR}/")
    if manifest.view_contract and f"views/{VIEWS_FILE}" not in present:
        raise PackageError(f"{where}: missing views/{VIEWS_FILE}")
    if manifest.binding_contract and f"bindings/{BINDINGS_FILE}" not in present:
        raise PackageError(f"{where}: missing bindings/{BINDINGS_FILE}")
    if f"views/{VIEWS_FILE}" in present and not manifest.view_contract:
        raise PackageError(f"{where}: undeclared views/{VIEWS_FILE}")
    if f"bindings/{BINDINGS_FILE}" in present and not manifest.binding_contract:
        raise PackageError(f"{where}: undeclared bindings/{BINDINGS_FILE}")
    storage_declared = [majors for name, majors in manifest.requires if name == "app-storage"]
    if storage_declared and storage_declared != [(1,)]:
        raise PackageError(f"{where}: app-storage must declare [1]")
    if STORAGE_DESCRIPTOR in present and not storage_declared:
        raise PackageError(f"{where}: {STORAGE_DESCRIPTOR} present without app-storage: [1]")
    if storage_declared and STORAGE_DESCRIPTOR not in present:
        raise PackageError(f"{where}: app-storage: [1] declared without {STORAGE_DESCRIPTOR}")


def _check_descriptor_json(rel: str, text: str, where: str) -> None:
    try:
        doc = json.loads(text)
    except ValueError as e:
        raise PackageError(f"{where}: {rel}: not valid JSON — {e}") from e
    want = DESCRIPTOR_CONTRACTS[rel]
    if not isinstance(doc, dict) or doc.get("contract") != want:
        raise PackageError(f'{where}: {rel}: root must carry contract "{want}"')


def check_file_bytes(
    contents: list[tuple[str, bytes]], where: str, app: str | None = None
) -> None:
    check_screen_bytes(contents, where)
    total = 0
    for rel, data in contents:
        if len(data) > file_cap(rel):
            raise PackageError(f"{where}: {rel} exceeds {file_cap(rel)} bytes")
        total += len(data)
        if total > MAX_APP_BYTES:
            raise PackageError(f"{where}: app is over {MAX_APP_BYTES} bytes")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as e:
            raise PackageError(f"{where}: {rel}: not UTF-8 text") from e
        if rel in DESCRIPTOR_CONTRACTS:
            _check_descriptor_json(rel, text, where)
    _check_app_storage(contents, where, app)
    _check_skills(contents, where)


def read_manifest(root: Path, files: list[str] | None = None) -> Manifest:
    if files is None:
        files = bundle_files(root)
    raw = (root / MANIFEST).read_bytes()
    text = raw.decode("utf-8")
    manifest = parse_manifest(text)
    check_pairing(manifest, files, MANIFEST)
    return manifest


def _tar_info(name: str, data: bytes, dir_: bool = False) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.mtime = EPOCH
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    if dir_:
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        info.size = 0
    else:
        info.type = tarfile.REGTYPE
        info.mode = 0o644
        info.size = len(data)
    return info


def _member_names(prefix: str, files: list[str]) -> list[str]:
    dirnames = sorted(
        {str(parent) for rel in files for parent in PurePosixPath(rel).parents if str(parent) != "."}
    )
    return [f"{prefix}{d}/" for d in dirnames] + [f"{prefix}{rel}" for rel in files]


def write_tar_gz(dest: Path, prefix: str, contents: list[tuple[str, bytes]]) -> None:
    files = [rel for rel, _ in contents]
    data = dict(contents)
    with dest.open("wb") as fh:
        with gzip.GzipFile(filename="", fileobj=fh, mode="wb", mtime=EPOCH) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tf:
                for member in _member_names(prefix, files):
                    if member.endswith("/"):
                        tf.addfile(_tar_info(member, b"", dir_=True))
                    else:
                        body = data[member[len(prefix) :]]
                        tf.addfile(_tar_info(member, body), io.BytesIO(body))


def write_zip(dest: Path, prefix: str, contents: list[tuple[str, bytes]]) -> None:
    files = [rel for rel, _ in contents]
    data = dict(contents)
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for member in _member_names(prefix, files):
            info = zipfile.ZipInfo(member, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 0
            if member.endswith("/"):
                info.external_attr = (0o40755 << 16) | 0x10
                zf.writestr(info, b"")
            else:
                info.external_attr = 0o100644 << 16
                zf.writestr(info, data[member[len(prefix) :]])


def read_contents(
    root: Path, files: list[str], app: str | None = None
) -> list[tuple[str, bytes]]:
    contents = []
    for rel in files:
        data = (root / rel).read_bytes()
        if len(data) > file_cap(rel):
            raise PackageError(f"{rel} exceeds {file_cap(rel)} bytes")
        contents.append((rel, data))
    check_file_bytes(contents, str(root), app)
    return contents


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_sidecar(archive: Path) -> Path:
    digest = sha256_hex(archive.read_bytes())
    sidecar = archive.with_name(archive.name + SIDECAR_SUFFIX)
    sidecar.write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    return sidecar


def read_sidecar(archive: Path) -> str:
    sidecar = archive.with_name(archive.name + SIDECAR_SUFFIX)
    try:
        line = sidecar.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError) as e:
        raise PackageError(f"cannot read {sidecar}: {e}") from e
    parts = line.split()
    if len(parts) != 2 or not re.fullmatch(r"[0-9a-f]{64}", parts[0]) or parts[1] != archive.name:
        raise PackageError(f"{sidecar.name}: malformed sidecar")
    return parts[0]


def _check_member_path(name: str, archive_name: str) -> PurePosixPath:
    if not name or "\\" in name or name.startswith("/"):
        raise PackageError(f"{archive_name}: bad member path {name!r}")
    parts = name.split("/")
    if parts and parts[-1] == "":
        parts = parts[:-1]
    if not parts or any(p in ("", ".", "..") for p in parts):
        raise PackageError(f"{archive_name}: non-canonical member path {name!r}")
    return PurePosixPath(name)


def _archive_members(archive: Path) -> tuple[list[tuple[str, bytes]], list[str]]:
    members: list[tuple[str, bytes]] = []
    dirs: list[str] = []
    seen: set[str] = set()
    total = 0

    def admit(name: str, is_dir: bool, size: int, data: bytes | None) -> None:
        nonlocal total
        _check_member_path(name, archive.name)
        norm = name.rstrip("/") if is_dir else name
        if norm in seen:
            raise PackageError(f"{archive.name}: duplicate member {norm}")
        seen.add(norm)
        if is_dir:
            dirs.append(norm)
            return
        rel = name.partition("/")[2]
        if size > file_cap(rel):
            raise PackageError(f"{archive.name}: {name} exceeds {file_cap(rel)}")
        total += size
        if total > MAX_APP_BYTES or len(members) + 1 > MAX_FILES:
            raise PackageError(f"{archive.name}: archive exceeds bounds")
        members.append((name, data if data is not None else b""))

    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                mode = (info.external_attr >> 16) & 0xFFFF
                ftype = stat.S_IFMT(mode)
                if ftype == stat.S_IFDIR or info.is_dir():
                    admit(info.filename, True, 0, None)
                    continue
                if ftype not in (0, stat.S_IFREG):
                    raise PackageError(f"{archive.name}: non-regular member {info.filename}")
                admit(info.filename, False, info.file_size, zf.read(info))
        return members, dirs

    with tarfile.open(archive, mode="r:*") as tf:
        for info in tf:
            if info.isdir():
                admit(info.name, True, 0, None)
                continue
            if not info.isreg():
                raise PackageError(f"{archive.name}: non-regular member {info.name}")
            fh = tf.extractfile(info)
            if fh is None:
                raise PackageError(f"{archive.name}: cannot read {info.name}")
            admit(info.name, False, info.size, fh.read())
    return members, dirs


def _check_member_tree(rels: list[str], archive_name: str) -> None:
    files = []
    dirs = set()
    manifest = False
    for rel in rels:
        if rel == MANIFEST:
            manifest = True
            files.append(rel)
            continue
        if rel in ROOT_DESCRIPTORS:
            files.append(rel)
            continue
        parts = PurePosixPath(rel).parts
        if len(parts) == 3 and parts[:2] == ("screens", "minutes") and screen_leaf(parts[2]):
            files.append(rel)
            dirs.add("screens")
            continue
        if parts[0] == SKILL_DIR and 3 <= len(parts) <= 4 and not rel.endswith("/"):
            if any(part.startswith(".") for part in parts):
                raise PackageError(f"{archive_name}: dotfile {rel}")
            files.append(rel)
            dirs.add(SKILL_DIR)
            continue
        if len(parts) != 2 or rel.endswith("/"):
            raise PackageError(f"{archive_name}: member {rel} — app dirs are flat")
        top, name = parts
        if top == "screens":
            raise PackageError(f"{archive_name}: screen files belong under {SCREEN_DIR}/")
        if top not in TOP_DIRS:
            raise PackageError(f"{archive_name}: unknown top dir {top}")
        if name.startswith("."):
            raise PackageError(f"{archive_name}: dotfile {rel}")
        dirs.add(top)
        if top == "workflows":
            if not name.endswith(".md"):
                raise PackageError(f"{archive_name}: workflow {rel} must end in .md")
            _check_tag(name[: -len(".md")], "workflow name")
        if top == "assets":
            _check_asset_leaf(name, f"{archive_name}: {rel}")
        if top == "views" and name != VIEWS_FILE:
            raise PackageError(f"{archive_name}: views/ holds {VIEWS_FILE}")
        if top == "bindings" and name != BINDINGS_FILE:
            raise PackageError(f"{archive_name}: bindings/ holds {BINDINGS_FILE}")
        if top == "storage" and (not name.endswith(".json") or not STORAGE_PATH_RE.fullmatch(rel)):
            raise PackageError(f"{archive_name}: invalid storage member {rel}")
        files.append(rel)
    if not manifest or "workflows" not in dirs or len(files) > MAX_FILES:
        raise PackageError(f"{archive_name}: incomplete or oversized bundle")


def _check_member_dir(drel: str, archive_name: str, prefix: str, full: str) -> None:
    if not full.startswith(prefix):
        raise PackageError(f"{archive_name}: directory {full} outside {prefix}")
    if drel.rstrip("/") == SCREEN_DIR:
        return
    skill_parts = drel.rstrip("/").split("/")
    if skill_parts[0] == SKILL_DIR and 2 <= len(skill_parts) <= 3:
        if skill_parts[1].startswith(".") or (
            len(skill_parts) == 3 and skill_parts[2] not in SKILL_NESTED_EXTS
        ):
            raise PackageError(f"{archive_name}: invalid skill directory {full}")
        return
    if not drel or "/" in drel.rstrip("/"):
        raise PackageError(f"{archive_name}: nested directory {full} refuses")
    top = drel.rstrip("/")
    if top.startswith(".") or top not in TOP_DIRS:
        raise PackageError(f"{archive_name}: invalid directory {full}")


def verify_archive(archive: Path) -> dict:
    expected = read_sidecar(archive)
    actual = sha256_hex(archive.read_bytes())
    if actual != expected:
        raise PackageError(f"{archive.name}: SHA256 mismatch")

    members, dirs = _archive_members(archive)
    if not members:
        raise PackageError(f"{archive.name}: empty archive")
    manifest_members = [n for n, _ in members if PurePosixPath(n).name == MANIFEST]
    if len(manifest_members) != 1:
        raise PackageError(f"{archive.name}: expected one {MANIFEST}")
    manifest_member = manifest_members[0]
    prefix = manifest_member[: -len(MANIFEST)]
    if not prefix or not prefix.endswith("/") or prefix.count("/") != 1:
        raise PackageError(f"{archive.name}: invalid archive root prefix")
    rels = []
    rel_bytes: list[tuple[str, bytes]] = []
    for name, data in members:
        if not name.startswith(prefix):
            raise PackageError(f"{archive.name}: member {name} outside {prefix}")
        rel = name[len(prefix) :]
        rels.append(rel)
        rel_bytes.append((rel, data))
    rels.sort()
    for d in dirs:
        drel = d[len(prefix) :] if d.startswith(prefix) else d
        _check_member_dir(drel, archive.name, prefix, d)
    _check_member_tree(rels, archive.name)

    manifest = parse_manifest(dict(members)[manifest_member].decode("utf-8"))
    _check_version_semver(manifest.version)
    check_file_bytes(rel_bytes, archive.name, manifest.app)
    check_pairing(manifest, rels, archive.name)

    base = archive.name
    for suffix in (".tar.gz", ".zip"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    if base != f"{manifest.app}-{manifest.version}":
        raise PackageError(f"{archive.name}: archive name mismatch")
    return {
        "archive": archive.name,
        "sha256": actual,
        "files": len(rels),
        "app": manifest.app,
        "version": manifest.version,
        "integrity": "archive sha256 matches sidecar (integrity only)",
    }


def default_source() -> Path:
    return Path(__file__).resolve().parent.parent / "app"


def cmd_build(args: argparse.Namespace) -> int:
    source: Path = args.source
    files = bundle_files(source)
    manifest = read_manifest(source, files)
    _check_version_semver(manifest.version)
    contents = read_contents(source, files, manifest.app)

    archive_name = f"{manifest.app}-{manifest.version}.{args.format}"
    prefix = f"{manifest.app}-{manifest.version}/"
    args.outdir.mkdir(parents=True, exist_ok=True)
    archive = args.outdir / archive_name
    if args.format == "tar.gz":
        write_tar_gz(archive, prefix, contents)
    else:
        write_zip(archive, prefix, contents)
    sidecar = write_sidecar(archive)
    print(
        json.dumps(
            {
                "archive": str(archive),
                "sidecar": str(sidecar),
                "sha256": sha256_hex(archive.read_bytes()),
                "files": len(files),
                "app": manifest.app,
                "version": manifest.version,
                "note": "archive sha256 is integrity evidence only",
            },
            indent=2,
        )
    )
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    print(json.dumps(verify_archive(args.archive), indent=2))
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    files = bundle_files(args.source)
    manifest = read_manifest(args.source, files)
    read_contents(args.source, files, manifest.app)
    print(
        json.dumps(
            {
                "source": str(args.source),
                "app": manifest.app,
                "version": manifest.version,
                "files": files,
                "note": "offline shape check only",
            },
            indent=2,
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="package_app.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build")
    p_build.add_argument("--source", type=Path, default=None)
    p_build.add_argument("--outdir", type=Path, default=None)
    p_build.add_argument("--format", choices=ALLOWED_FORMATS, default="tar.gz")
    p_build.set_defaults(fn=cmd_build)

    p_verify = sub.add_parser("verify")
    p_verify.add_argument("archive", type=Path)
    p_verify.set_defaults(fn=cmd_verify)

    p_check = sub.add_parser("check")
    p_check.add_argument("--source", type=Path, default=None)
    p_check.set_defaults(fn=cmd_check)

    args = parser.parse_args(argv)
    if getattr(args, "source", None) is None and args.cmd in ("build", "check"):
        args.source = default_source()
    if getattr(args, "outdir", None) is None and args.cmd == "build":
        args.outdir = Path(__file__).resolve().parent.parent / "dist"
    try:
        return args.fn(args)
    except PackageError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
