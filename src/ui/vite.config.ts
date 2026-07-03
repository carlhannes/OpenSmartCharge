import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  build: {
    outDir: path.resolve(__dirname, '../../dist/ui'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 800, // recharts adds ~600 kB; acceptable for a self-hosted LAN tool
  },
  resolve: {
    alias: {
      '@sdk': path.resolve(__dirname, '../sdk'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // The UI has a `src/ui/api/` source folder; with root=src/ui, Vite serves it at
        // `/api/*.ts`, which collides with this `/api` backend proxy. Don't proxy Vite's own
        // source-module requests (they end in .ts/.tsx/.js) — only real API calls (which never
        // end in a module extension) should reach the backend. See ROADMAP known-issues.
        bypass: (req) => (req.url && /\.[tj]sx?(\?|$)/.test(req.url) ? req.url : undefined),
      },
      // SSE: do not buffer — http-proxy streams correctly by default
      '/events': { target: 'http://localhost:8080', changeOrigin: true },
      // OCPP-J uses WebSocket
      '/ocpp': { target: 'http://localhost:8080', ws: true },
    },
  },
})
