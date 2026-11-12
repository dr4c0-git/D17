import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// `npm run build:ipfs` exports the whole site as static files (apps/web/out) for an IPFS
// mirror served through an ENS name and eth.limo. The Vercel build is unchanged.
const staticExport = process.env.D17_STATIC_EXPORT === '1'

// Keep in sync with public/_headers, which static hosts such as Cloudflare Pages read.
async function securityHeaders() {
  return [
    {
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'" },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    },
  ]
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  turbopack: {
    root: __dirname,
  },
  images: {
    unoptimized: true,
  },
  // Static hosts serve folders: /docs/guide/ maps to docs/guide/index.html.
  ...(staticExport ? { output: 'export', trailingSlash: true } : {}),
  // Response headers need a server; an IPFS gateway sets its own.
  ...(staticExport ? {} : { headers: securityHeaders }),
}

export default nextConfig
