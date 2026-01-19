import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import { execSync } from 'child_process'

// Get Tailscale FQDN (e.g., "primer.tail8bd569.ts.net")
const getTailscaleHostname = (): string | null => {
  try {
    const status = execSync('tailscale status --json', { encoding: 'utf-8' })
    const parsed = JSON.parse(status)
    return parsed.Self.DNSName.replace(/\.$/, '') // strip trailing dot
  } catch {
    return null
  }
}

// Load TLS certs if available for this host
const getCertConfig = () => {
  const hostname = getTailscaleHostname()
  if (!hostname) {
    console.log('[vite] No Tailscale hostname found, running HTTP-only')
    return undefined
  }

  const certDir = '/Pondside/Basement/Files/certs'
  const certPath = `${certDir}/${hostname}.crt`
  const keyPath = `${certDir}/${hostname}.key`

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.log(`[vite] No certs found for ${hostname}, running HTTP-only`)
    return undefined
  }

  console.log(`[vite] Loading TLS certs for ${hostname}`)
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 8766,
    host: '0.0.0.0',
    https: getCertConfig(),
    // Disable HMR for stability during instrumentation/debugging
    // Remove this line to re-enable hot module replacement
    hmr: false,
    proxy: {
      '/api': {
        target: 'http://localhost:8765',
        changeOrigin: true,
      },
    },
    // Allow both short names and Tailscale FQDNs
    allowedHosts: [
      'alpha-pi',
      'primer',
      '.tail8bd569.ts.net',  // wildcard for all Tailscale hosts
    ]
  },
})
