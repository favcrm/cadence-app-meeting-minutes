import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolve, join, relative, sep } from "node:path";

export const root = resolve(import.meta.dirname, "..");
export const hash = (v) => createHash("sha256").update(v).digest("hex");

export function safePath(base, name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("\\") ||
    name.split("/").some((p) => !p || p === "." || p === "..") ||
    name.startsWith("/")
  ) {
    throw new Error(`Noncanonical input path: ${name}`);
  }
  let path = base;
  for (const part of name.split("/")) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Symlink input: ${path}`);
  }
  return path;
}

export function files(dir) {
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
    throw new Error(`Not a real directory: ${dir}`);
  }
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((e) => {
      const path = safePath(dir, e.name);
      if (e.isDirectory()) return files(path);
      if (!e.isFile()) throw new Error(`Not a regular input: ${path}`);
      return [path];
    });
}

// JSON.parse alone hides duplicate fields. Scan object keys before decoding.
export function parseJson(raw, cap = 786432) {
  if (Buffer.byteLength(raw) > cap) throw new Error("JSON input exceeds byte budget");
  const stack = [];
  let nodes = 0;
  for (const token of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)) {
    const value = token[0];
    if (++nodes > 65536) throw new Error("JSON token budget exceeded");
    if (value === "{" || value === "[") {
      stack.push({ object: value === "{", keys: new Set(), key: value === "{" });
      if (stack.length > 32) throw new Error("JSON depth exceeds 32");
    } else if (value === "}" || value === "]") stack.pop();
    else if (value === ",") {
      if (stack.at(-1)?.object) stack.at(-1).key = true;
    } else if (value === ":") {
      if (stack.at(-1)) stack.at(-1).key = false;
    } else if (stack.at(-1)?.object && stack.at(-1).key && value.startsWith('"')) {
      const key = JSON.parse(value);
      const frame = stack.at(-1);
      if (frame.keys.has(key)) throw new Error(`Duplicate JSON field: ${key}`);
      frame.keys.add(key);
      frame.key = false;
    }
  }
  return JSON.parse(raw);
}

export function operationInventory() {
  const service = readFileSync(safePath(root, "src/bridge/services.ts"), "utf8");
  const table = service.slice(
    service.indexOf("export const CALL_FIELDS"),
    service.indexOf("export const OPERATIONS"),
  );
  const operations = [...table.matchAll(/"([a-z][a-z.-]+)":/g)].map((m) => m[1]);
  if (operations.length !== 5 || new Set(operations).size !== operations.length) {
    throw new Error("Closed operation inventory must contain 5 distinct operations");
  }
  return operations;
}

export function inputs(args) {
  const at = args.indexOf("--toolchain-root");
  if (at >= 0 && (!args[at + 1] || args[at + 1].startsWith("--"))) {
    throw new Error("Missing --toolchain-root value");
  }
  const toolchain = at < 0 ? root : resolve(args[at + 1]);
  const pin = parseJson(readFileSync(safePath(root, "screen-ui.lock.json"), "utf8"));
  const dev = args.includes("--development");
  if (
    !["commit", "working-tree"].includes(pin.source.kind) ||
    (pin.source.kind === "commit" && !/^[0-9a-f]{40}$/.test(pin.source.sourceSha))
  ) {
    throw new Error("Invalid SDK source provenance");
  }
  if (pin.source.kind !== "commit" && !dev) {
    throw new Error("Release refuses working-tree SDK provenance; --development is local-only");
  }
  if (!/^[a-z0-9][a-z0-9.-]*\.tgz$/.test(pin.archive.filename)) {
    throw new Error("Invalid SDK archive filename");
  }
  const archive = safePath(root, `.cadence-ui/${pin.archive.filename}`);
  const archiveBytes = readFileSync(archive);
  if (archiveBytes.length !== pin.archive.bytes || hash(archiveBytes) !== pin.archive.sha256) {
    throw new Error("Shared UI archive integrity mismatch");
  }
  // Verify the archive itself (and extract `.cadence-ui/package` on fresh checkouts if absent).
  const sdkRoot = safePath(root, ".cadence-ui");
  const extract = !existsSync(join(sdkRoot, "package")) ? "1" : "0";
  const check = spawnSync(
    "python3",
    [
      "-c",
      `
import sys, json, tarfile, hashlib
from pathlib import Path
pin = json.load(sys.stdin); seen = set(); total = 0
archive = Path(sys.argv[1]); sdk_root = Path(sys.argv[2]); do_extract = sys.argv[3] == "1"
expected = {"package/" + a["path"]: a["sha256"] for a in pin["artifacts"]}
with tarfile.open(archive, "r:gz") as tf:
  members = tf.getmembers()
  for member in members:
    name = member.name.rstrip("/")
    if not name or "\\\\" in name or any(p in ("", ".", "..") for p in name.split("/")) or name in seen:
      raise ValueError("invalid/duplicate SDK archive path")
    seen.add(name)
    if member.isdir():
      if name != "package" and not any(p.startswith(name + "/") for p in expected):
        raise ValueError("undeclared SDK directory")
      continue
    if not member.isreg() or name not in expected or member.size > 2097152:
      raise ValueError("invalid SDK archive member")
    total += member.size
    payload = tf.extractfile(member).read()
    if total > 4194304 or hashlib.sha256(payload).hexdigest() != expected[name]:
      raise ValueError("SDK archive integrity mismatch")
    if do_extract:
      target = sdk_root / name
      target.parent.mkdir(parents=True, exist_ok=True)
      with target.open("xb") as out:
        out.write(payload)
if not set(expected).issubset(seen):
  raise ValueError("missing SDK archive member")
`,
      archive,
      sdkRoot,
      extract,
    ],
    { input: JSON.stringify(pin), encoding: "utf8", maxBuffer: 16384 },
  );
  if (check.status !== 0) {
    throw new Error(`SDK archive refused: ${check.stderr || check.error}`);
  }
  const kit = safePath(root, ".cadence-ui/package");
  const members = new Set();
  for (const item of pin.artifacts) {
    if (members.has(item.path)) throw new Error(`Duplicate SDK member: ${item.path}`);
    members.add(item.path);
    if (hash(readFileSync(safePath(kit, item.path))) !== item.sha256) {
      throw new Error(`Shared UI member mismatch: ${item.path}`);
    }
  }
  if (
    files(kit).length !== members.size ||
    files(kit).some((p) => !members.has(relative(kit, p).split(sep).join("/")))
  ) {
    throw new Error("Undeclared SDK files");
  }
  const manifest = parseJson(readFileSync(safePath(kit, "build-manifest.json"), "utf8"));
  const sourceNames = new Set();
  for (const item of pin.files) {
    if (
      !/^ui\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(item.path) ||
      sourceNames.has(item.path) ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    ) {
      throw new Error("Invalid/duplicate SDK source member");
    }
    sourceNames.add(item.path);
  }
  const closure = hash(JSON.stringify(pin.files));
  if (
    closure !== pin.closureSha256 ||
    manifest.closureSha256 !== closure ||
    JSON.stringify(manifest.files) !== JSON.stringify(pin.files) ||
    manifest.package !== pin.package ||
    JSON.stringify(manifest.toolchain) !== JSON.stringify(pin.toolchain)
  ) {
    throw new Error("SDK source/toolchain pin mismatch");
  }
  const require = createRequire(join(toolchain, "package.json"));
  const packages = {
    react: "19.2.8",
    "react-dom": "19.2.8",
    "@types/react": "19.2.9",
    "@types/react-dom": "19.2.7",
    typescript: "5.9.3",
    vite: "8.2.2",
    "@vitejs/plugin-react": "6.1.1",
    "@hugeicons/react": "1.1.10",
    "@hugeicons/core-free-icons": "4.3.0",
  };
  for (const [name, version] of Object.entries(packages)) {
    if (
      pin.toolchain.packages[name] !== version ||
      !existsSync(join(toolchain, "node_modules", name, "package.json")) ||
      parseJson(readFileSync(join(toolchain, "node_modules", name, "package.json"), "utf8"))
        .version !== version
    ) {
      throw new Error(`Missing pinned toolchain: ${name}@${version}`);
    }
  }
  if (process.version !== pin.toolchain.node) {
    throw new Error("Node differs from SDK toolchain pin");
  }
  return { pin, toolchain, require, kit, packages, dev };
}

export function sourceDigest() {
  const names = [
    ...files(join(root, "src")),
    ...files(join(root, "scripts")).filter((p) => p.endsWith(".mjs") || p.endsWith(".py")),
    ...files(join(root, "app-kit")),
    ...[
      "app/app.md",
      "app-kit.lock.json",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "screen-ui.lock.json",
    ].map((p) => safePath(root, p)),
  ];
  return hash(
    JSON.stringify(
      names.sort().map((p) => ({ path: relative(root, p), sha256: hash(readFileSync(p)) })),
    ),
  );
}
