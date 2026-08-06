import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Binds to every interface, so a phone on the same Wi-Fi can reach the dev server at
    // http://<this-machine's-LAN-IP>:5173 without a tunnel in between.
    host: true,
    // Lets tunnels through Vite's Host-header check, which otherwise rejects any host it does
    // not recognise. Each of these hands out a random subdomain per run, so they are matched
    // by suffix rather than listed individually.
    allowedHosts: [
      '.ngrok-free.dev', '.ngrok-free.app', '.ngrok.io', '.ngrok.app',
      '.trycloudflare.com',
    ],
    proxy: {
      '/api': {
        // Configurable so the Playwright suite can point the app at an API instance running
        // against `medcrm_test` instead of the development database. Without this, every
        // end-to-end test would write into real data — which is exactly what the isolated
        // test database exists to prevent. Unset in normal development, so nothing changes.
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
