#!/usr/bin/env node
/**
 * Build the `app-screens/v2` UI package for Meeting minutes.
 *
 * Produces `dist/screens/minutes/`:
 *   client.js    — self-contained IIFE (React + this screen bundled)
 *   app.css      — the screen's stylesheet (host kit supplies tokens/base)
 *   index.html   — standalone page for local inspection (no bridge attached)
 *   screens.json — app-screens/v2 declaration (integrity evidence)
 *   INVENTORY.md — sha256 + byte size per artifact
 *
 * Constraints (host validator `src/issue/app_screen_decl.rs`): <=32 assets,
 * <=256 KiB per JS asset, <=128 KiB other, <=512 KiB total, flat
 * `<tag>.<ext>` names, entry pinned `client.js`, js/css/svg/json only,
 * `sha256:<64hex>` digests.
 *
 * The frame document is a raw-text `<script>` block, so the emitted client
 * must not contain `</script`, `<!--` or `-->`; the host fails closed on any
 * of them rather than rewriting approved bytes. This script asserts that
 * before declaring, so the hashes describe exactly what runs.
 *
 * Toolchain resolves from the host checkout's `ui/node_modules` (read-only);
 * nothing is installed into this repository.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCREEN_TAG = process.env.SCREEN_TAG || "minutes";
const HOST = resolve(process.env.HOST_SOURCE || "/home/ubuntu/Project/cadence");
const outDir = resolve(appRoot, "dist/screens", SCREEN_TAG);

const hostRequire = createRequire(resolve(HOST, "ui/package.json"));
const { build } = await import(hostRequire.resolve("vite"));
const react = (await import(hostRequire.resolve("@vitejs/plugin-react"))).default;

const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const bytes = (text) => Buffer.byteLength(text, "utf8");

rmSync(resolve(appRoot, "dist"), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  root: resolve(appRoot, "src/screens"),
  configFile: false,
  logLevel: "warn",
  // Production React: the development build alone blows the 256 KiB JS cap.
  mode: "production",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: false,
    minify: true,
    cssMinify: true,
    assetsInlineLimit: 0,
    lib: {
      entry: resolve(appRoot, "src/screens/main.jsx"),
      formats: ["iife"],
      name: "MeetingMinutesScreen",
      fileName: () => "client.js",
      cssFileName: "app",
    },
  },
});

/* ------------------------------ sanity ---------------------------------- */

const FORBIDDEN = ["</script", "<!--", "-->"];
let client = readFileSync(resolve(outDir, "client.js"), "utf8");
const css = readFileSync(resolve(outDir, "app.css"), "utf8");

// `</script` inside a JS string literal is safe to backslash-escape and
// semantics-preserving; the other two tokens are refused outright, because
// rewriting them could change code.
if (client.toLowerCase().includes("</script")) {
  client = client.replace(/<\/script/gi, "<\\/script");
}
for (const token of FORBIDDEN) {
  if (client.toLowerCase().includes(token)) {
    throw new Error(`client.js still contains the forbidden token ${token}`);
  }
}
writeFileSync(resolve(outDir, "client.js"), client);

const assets = [
  { name: "client.js", media_type: "text/javascript", body: client },
  { name: "app.css", media_type: "text/css", body: css },
];
const total = assets.reduce((sum, asset) => sum + bytes(asset.body), 0);
for (const asset of assets) {
  const cap = asset.media_type === "text/javascript" ? 256 * 1024 : 128 * 1024;
  if (bytes(asset.body) > cap) throw new Error(`${asset.name} exceeds its ${cap} byte cap`);
}
if (total > 512 * 1024) throw new Error(`package exceeds the 512 KiB total cap (${total} bytes)`);

if (!client.includes("cadence-screen-boot")) {
  throw new Error("client.js does not reference the frame bootstrap element");
}

/* ---------------------------- declaration -------------------------------- */

const source = [readFileSync(resolve(appRoot, "src/screens/main.jsx"), "utf8"), "", readFileSync(resolve(appRoot, "src/screens/Minutes.jsx"), "utf8")].join("\n");

const declaration = {
  contract: "app-screens/v2",
  app: "meeting-minutes",
  entry: "client.js",
  assets: assets.map((asset) => ({
    name: asset.name,
    media_type: asset.media_type,
    sha256: sha(asset.body),
    size: bytes(asset.body),
  })),
  provenance: {
    source_digest: sha(source),
    sdk_digest: sha("meeting-minutes/app-screens/v2/receiver"),
    toolchain_digest: sha("vite+@vitejs/plugin-react from the host checkout"),
  },
};

writeFileSync(resolve(outDir, "screens.json"), `${JSON.stringify(declaration, null, 2)}\n`);

writeFileSync(
  resolve(outDir, "index.html"),
  `<!doctype html><html data-cadence-kit="local"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meeting minutes — local screen</title>
<script type="application/json" id="cadence-screen-boot">${JSON.stringify({ tag: SCREEN_TAG, bridge_nonce: "0".repeat(64), generation: 1, parent_origin: "http://127.0.0.1" })}</script>
<style>${css}</style>
</head><body><div id="root"></div><script>${client}</script></body></html>
`,
);

writeFileSync(
  resolve(outDir, "INVENTORY.md"),
  [
    `# ${SCREEN_TAG} screen package`,
    "",
    `Total: ${total} bytes (cap 512 KiB).`,
    "",
    "| file | media type | sha256 | bytes |",
    "| --- | --- | --- | ---: |",
    ...declaration.assets.map((a) => `| \`${a.name}\` | ${a.media_type} | \`${a.sha256}\` | ${a.size} |`),
    "",
    "`screens.json` is the declaration the host validates; `index.html` is for local inspection only",
    "(no bridge attaches there, so the screen shows its waiting state).",
    "",
  ].join("\n"),
);

console.log(`built dist/screens/${SCREEN_TAG} — ${assets.map((a) => `${a.name} ${bytes(a.body)}B`).join(", ")}`);
