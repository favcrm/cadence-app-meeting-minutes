#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = process.env.CADENCE_APP_HOST ?? "localhost";
const portText = process.env.CADENCE_APP_PORT ?? "3187";

if (host !== "localhost" && !host.endsWith(".localhost")) {
  throw new Error(
    "Meeting minutes preview requires localhost or *.localhost; app-kit rejects HTTP IP literals.",
  );
}
if (!/^\d+$/.test(portText) || Number(portText) < 3110 || Number(portText) > 3199) {
  throw new Error("Meeting minutes preview port must be 3110–3199.");
}

const server = await createServer({
  root,
  configFile: false,
  envDir: false,
  envPrefix: "MINUTES_PREVIEW_PUBLIC_",
  publicDir: false,
  resolve: {
    alias: {
      "@cadence/app-kit": resolve(root, "app-kit/src/index.mjs"),
    },
  },
  plugins: [
    react(),
    {
      name: "offline-preview",
      configureServer(viteServer) {
        viteServer.middlewares.use((req, res, next) => {
          if (/^\/(api|__platform)(\/|\?|$)/.test(req.url ?? "")) {
            res.statusCode = 403;
            res.end("Synthetic Meeting minutes preview: live APIs are unavailable.");
          } else {
            next();
          }
        });
      },
    },
  ],
  server: { host, port: Number(portText), strictPort: true, fs: { strict: true } },
});

await server.listen();
const address = server.httpServer.address();
console.log(
  `MEETING MINUTES · SYNTHETIC FIXTURES · http://${host === "::1" ? "[::1]" : host}:${address.port}/dev/preview/`,
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
