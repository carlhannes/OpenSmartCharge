import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const projectDir = dirname(fileURLToPath(import.meta.url));

// Plain TanStack Start config, hand-written to replace the generated build-config
// wrapper this project originally shipped with — reproducing only its standard plugins
// and dropping the editor-only ones (component tagger, HMR gate, dev-server bridge,
// SSR/build error loggers, sandbox detection, asset proxy).
// `server.entry: "server"` routes SSR through src/server.ts (the SSR error fallback).
export default defineConfig({
  // Fixed port so ui2 coexists with the existing UI (5173) and backend (8080).
  // Proxy /api + /events to the backend (no CORS on the server → same-origin via proxy).
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
      // SSE: http-proxy streams by default (no buffering).
      "/events": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
  resolve: {
    alias: { "@": resolve(projectDir, "src") },
    // Prevent duplicate React / Query copies (which crash hooks) across SSR + client.
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
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
    }),
    viteReact(),
  ],
});
