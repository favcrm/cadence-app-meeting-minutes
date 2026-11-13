import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  root,
  hash,
  files,
  safePath,
  parseJson,
  inputs,
  sourceDigest,
  operationInventory,
} from "./screen_inputs.mjs";

const env = inputs(process.argv.slice(2));
const fail = (message) => {
  throw new Error(message);
};
const exact = (value, required, optional = []) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => ![...required, ...optional].includes(k))
  ) {
    fail("Closed declaration field mismatch");
  }
};
const decoder = new TextDecoder("utf-8", { fatal: true });
const out = safePath(root, "app/screens/minutes");
const SCREEN_ASSET_CAP = 2097152;
const SCREEN_TOTAL_CAP = 2097152;
const SCREEN_MANIFEST_CAP = 32768;

const decl = parseJson(decoder.decode(readFileSync(safePath(out, "screens.json"))), SCREEN_MANIFEST_CAP);
exact(
  decl,
  [
    "contract",
    "app",
    "entry",
    "assets",
    "provenance",
    "may",
    "host_contract",
    "tools",
    "operations",
    "navigation",
  ],
  ["remote_images", "startup"],
);
if (
  decl.contract !== "app-screens/v2" ||
  decl.app !== "meeting-minutes" ||
  decl.entry !== "client.js" ||
  decl.host_contract !== "screen-records.v1"
) {
  fail("Meeting minutes screen contract mismatch");
}
if (
  JSON.stringify(decl.may) !== JSON.stringify(["records.call"]) ||
  Object.keys(decl.tools ?? {}).length ||
  !decl.tools ||
  Array.isArray(decl.tools) ||
  typeof decl.tools !== "object" ||
  (decl.remote_images !== undefined && JSON.stringify(decl.remote_images) !== "[]")
) {
  fail("Unexpected bridge authority");
}
if (JSON.stringify(decl.operations) !== JSON.stringify(operationInventory())) {
  fail("Operations differ from the source inventory");
}
exact(decl.provenance, ["source_digest", "sdk_digest", "toolchain_digest"]);
const expected = {
  source_digest: `sha256:${sourceDigest()}`,
  sdk_digest: `sha256:${env.pin.archive.sha256}`,
  toolchain_digest: `sha256:${hash(JSON.stringify(env.pin.toolchain))}`,
};
if (Object.keys(expected).some((k) => decl.provenance[k] !== expected[k])) {
  fail("Source/SDK/toolchain provenance mismatch");
}
exact(decl.navigation, ["section_query", "default_section", "sections"]);
const navigation = {
  section_query: "minutes",
  default_section: "all",
  sections: [
    { id: "all", label: "All meetings" },
    { id: "followups", label: "Follow-ups" },
  ],
};
if (JSON.stringify(decl.navigation) !== JSON.stringify(navigation)) {
  fail("Meeting minutes navigation mismatch");
}

const media = {
  js: "text/javascript",
  css: "text/css",
  svg: "image/svg+xml",
  json: "application/json",
};
if (!Array.isArray(decl.assets) || !decl.assets.length || decl.assets.length > 32) {
  fail("Asset count exceeds bounds");
}
let total = 0;
const names = new Set();
for (const asset of decl.assets) {
  exact(asset, ["name", "media_type", "sha256", "size"]);
  if (
    typeof asset.name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,31}\.(js|css|svg|json)$/.test(asset.name) ||
    names.has(asset.name) ||
    asset.name === "screens.json"
  ) {
    fail("Invalid/duplicate asset name");
  }
  names.add(asset.name);
  const ext = asset.name.split(".").at(-1);
  const cap = SCREEN_ASSET_CAP;
  const body = readFileSync(safePath(out, asset.name));
  const text = decoder.decode(body);
  if (ext === "js" && /<\/script|<!--|-->/i.test(text)) {
    fail(`Unsafe inline script text: ${asset.name}`);
  }
  if (
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0 ||
    body.length > cap ||
    body.length !== asset.size ||
    asset.media_type !== media[ext] ||
    asset.sha256 !== `sha256:${hash(body)}`
  ) {
    fail(`Asset integrity/bounds mismatch: ${asset.name}`);
  }
  total += body.length;
}
if (total > SCREEN_TOTAL_CAP || !names.has("client.js") || !names.has("minutes.css")) {
  fail("Missing entry/styles or total exceeds bounds");
}
const scripts = decl.assets.filter((a) => a.media_type === "text/javascript").map((a) => a.name);
if (
  decl.startup !== undefined &&
  (!Array.isArray(decl.startup) ||
    decl.startup.length < 2 ||
    decl.startup.length > 32 ||
    decl.startup.some((name) => typeof name !== "string") ||
    new Set(decl.startup).size !== decl.startup.length ||
    decl.startup.at(-1) !== decl.entry ||
    decl.startup.length !== scripts.length ||
    decl.startup.some((name) => !scripts.includes(name)))
) {
  fail("Startup must name every declared JavaScript asset once, entry last");
}
if (JSON.stringify(decl.startup) !== JSON.stringify(["runtime.js", "client.js"])) {
  fail("Meeting minutes requires the ordered static framework/client partition");
}

const manifest = decoder.decode(readFileSync(safePath(root, "app/app.md"))).split("\n---\n")[0];
if (
  !/^    contracts: \{app-screens: \[1\], screen-records: \[1\], screen-startup: \[1\], app-storage: \[1\]\}$/m.test(
    manifest,
  )
) {
  fail("Meeting minutes manifest must demand app-screens, screen-records, screen-startup and app-storage v1");
}
const actual = files(out).map((p) => relative(out, p));
if (actual.length !== names.size + 1 || actual.some((p) => p !== "screens.json" && !names.has(p))) {
  fail("Unspecified screen assets");
}

// The vendored receiver is the released app-toolchain app-kit, not a fork.
const kitLock = parseJson(decoder.decode(readFileSync(safePath(root, "app-kit.lock.json"))), 65536);
exact(kitLock, ["schema", "source", "version", "files"]);
exact(kitLock.source, ["kind", "repo", "source_sha"]);
if (
  kitLock.schema !== "cadence-app-kit-lock/1" ||
  kitLock.source.kind !== "commit" ||
  kitLock.source.repo !== "favcrm/cadence" ||
  kitLock.source.source_sha !== "68cbc763a0d5bb3363ff9e9c9d6a090da3bf2ffb" ||
  kitLock.version !== "0.4.0"
) {
  fail("app-kit lock identity mismatch");
}
const kitDir = safePath(root, "app-kit");
const kitFiles = Object.keys(kitLock.files).sort();
const actualKit = files(kitDir)
  .map((p) => relative(kitDir, p))
  .sort();
if (JSON.stringify(actualKit) !== JSON.stringify(kitFiles)) {
  fail("app-kit file set differs from its lock");
}
for (const rel of kitFiles) {
  if (kitLock.files[rel] !== hash(readFileSync(safePath(kitDir, rel)))) {
    fail(`app-kit integrity mismatch: ${rel}`);
  }
}
const kitPackage = parseJson(decoder.decode(readFileSync(safePath(kitDir, "package.json"))), 65536);
if (kitPackage.name !== "@cadence/app-kit" || kitPackage.version !== kitLock.version) {
  fail("app-kit package identity/version mismatch");
}

// Offline source audit, not a replacement for the real sandbox/CSP guard.
const ts = env.require("typescript");
const allowed = new Set([
  "@cadence/app-kit",
  "@cadence/screen-ui",
  "@cadence/screen-ui/styles.css",
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "@hugeicons/react",
  "@hugeicons/core-free-icons",
]);
const network = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "sendBeacon",
  "Worker",
  "SharedWorker",
  "importScripts",
]);
for (const path of files(join(root, "src"))) {
  const raw = decoder.decode(readFileSync(path));
  if (path.endsWith(".css")) {
    if (/(?:@import\s+|url\(\s*)["']?\s*(?:https?:|\/\/)/i.test(raw)) {
      fail(`Network CSS input: ${path}`);
    }
    continue;
  }
  if (!/\.tsx?$/.test(path)) fail(`Unexpected source member: ${path}`);
  const ast = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const name = node.moduleSpecifier.text;
      if (!allowed.has(name)) {
        if (!name.startsWith(".")) fail(`Host-private/unlisted import: ${name}`);
        const target = resolve(path, "..", name);
        if (!target.startsWith(join(root, "src") + "/")) {
          fail(`Import escapes app source: ${name}`);
        }
      }
    }
    if (
      (ts.isIdentifier(node) && network.has(node.text)) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        network.has(node.argumentExpression.text))
    ) {
      fail(`Network runtime source member: ${path}`);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && ["require", "eval", "Function"].includes(node.expression.text)))
    ) {
      fail(`Dynamic runtime source: ${path}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

console.log(
  JSON.stringify(
    {
      development: env.dev,
      provenance: decl.provenance,
      assets: decl.assets,
      total,
      note: "Offline integrity/source checks only; no host activation or product acceptance",
    },
    null,
    2,
  ),
);
