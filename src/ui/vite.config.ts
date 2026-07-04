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
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      // SSE: do not buffer — http-proxy streams correctly by default
      '/events': { target: 'http://localhost:8080', changeOrigin: true },
      // OCPP-J uses WebSocket
      '/ocpp': { target: 'http://localhost:8080', ws: true },
    },
  },
})
