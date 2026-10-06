import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const projectDir = dirname(fileURLToPath(import.meta.url));

// Single-source the displayed app version from the ROOT package.json (baked in at build time), so the
// UI can never drift from the real product version again. Exposed to the app as __APP_VERSION__.
const rootPkg = JSON.parse(readFileSync(resolve(projectDir, "../../package.json"), "utf8")) as {
  version: string;
};

// Backend the dev proxy targets. Override to point ui2 at another backend (e.g. the mock):
//   OSC_BACKEND=http://localhost:9099 npm run dev:ui2   (or: npm run dev:ui2:mock)
const backend = process.env.OSC_BACKEND ?? "http://localhost:8080";

// Plain TanStack Start config, hand-written to replace the generated build-config
// wrapper this project originally shipped with — reproducing only its standard plugins
// and dropping the editor-only ones (component tagger, HMR gate, dev-server bridge,
// SSR/build error loggers, sandbox detection, asset proxy).
// `server.entry: "server"` routes SSR through src/server.ts (the SSR error fallback).
export default defineConfig({
  // App version, baked in from the root package.json (see rootPkg) → available as __APP_VERSION__.
  define: { __APP_VERSION__: JSON.stringify(rootPkg.version) },
  // Fixed port so the UI dev server never collides with the backend (8080).
  // Proxy /api + /events to the backend (no CORS on the server → same-origin via proxy).
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      // SSE: http-proxy streams by default (no buffering).
      "/events": { target: backend, changeOrigin: true },
    },
  },
  resolve: {
    // `@/*` resolves through tsConfigPaths() below (one source: tsconfig paths).
    // Prevent duplicate React copies (which crash hooks) across the prerender + client builds.
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
      server: { entry: "server" },
      // Build a static SPA (client shell + hydrate) instead of a runtime SSR server, so the
      // existing Express backend serves ui2 from dist/ui on :8080 — no second Node process.
      // `server.entry` above is now only used at build time to prerender the shell; dist/server
      // is not deployed. See docs/raspberry-pi.md + the root `build` script.
      spa: { enabled: true },
    }),
    viteReact(),
  ],
});
