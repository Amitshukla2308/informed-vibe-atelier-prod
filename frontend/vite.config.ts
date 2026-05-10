import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,            // listen on 0.0.0.0 so LAN devices can reach Landing
    port: 5174,
    strictPort: true,
    // Add your tunnel / production hostname here (or via env at boot).
    // Example: ['atelier.example.com']
    allowedHosts: (process.env.VITE_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    proxy: {
      // Backend listens on :3001 (canonical per ~/informed-vibes/PORTS.md).
      // /api/* is rewritten to bare paths because handleAuthRoutes etc.
      // match on "/me", "/logout", "/auth/...", not "/api/me".
      '/api': {
        // ws:true is required because the terminal-v2 reverse proxy upgrades
        // WebSocket connections on /api/terminal-v2/proxy/<sid>/ws — without
        // this, the browser's upgrade request hangs forever and ttyd's iframe
        // shows a black screen with no editable cursor.
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        rewrite: (p: string) => p.replace(/^\/api/, ''),
        // Swallow upstream errors so a backend restart (or a flaky WS bridge)
        // doesn't kill the entire vite dev server. http-proxy-middleware emits
        // 'error' on both the proxy instance and per-request socket; without
        // these handlers a single EPIPE bubbles up as uncaughtException →
        // node crashes → frontend "site can't be reached".
        // Param is typed `any` because http-proxy's ProxyServer type is generic
        // over IncomingMessage/ServerResponse and vite's expected callback shape
        // doesn't satisfy the narrow `{ on: ... }` literal we used to declare.
        // The runtime contract is just `proxy.on('error', cb)` which works.
        configure: (proxy: any) => {
          proxy.on('error', (err: Error) => { console.warn('[vite proxy] error:', err.message); });
        },
      },
      '/ws': { target: 'ws://localhost:3001', ws: true, changeOrigin: true },
    },
  },
})
