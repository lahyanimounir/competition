import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Host allowlist for `vite dev` / `vite preview`. It accepts the platform's public domain
// AND the internal routing hostname the reverse proxy may send (WS_INTERNAL_HOST),
// so these modes never answer 403 on the platform. Production does not use either:
// the Dockerfile serves the built bundle with nginx.
const allowedHosts = [
  'localhost',
  '.__WS_BASE_DOMAIN__',
  process.env.WS_BASE_DOMAIN && `.${process.env.WS_BASE_DOMAIN}`,
  process.env.WS_INTERNAL_HOST,
].filter(Boolean)

const port = Number(process.env.PORT) || undefined

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port, allowedHosts },
  preview: { host: '0.0.0.0', port, allowedHosts },
  build: { outDir: 'dist', sourcemap: false },
})
