import type { Metadata } from 'next'
import { IBM_Plex_Mono } from 'next/font/google'
import { Toaster } from 'sonner'
import './globals.css'

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
})

/*
 * Wallet extensions (e.g. Phantom's evmAsk.js vs MetaMask) race to define
 * window.ethereum and the loser throws "Cannot redefine property: ethereum".
 * That error comes from the extensions, not this app - the app connects via
 * EIP-6963 announcements and never redefines window.ethereum. This guard
 * runs before hydration and stops extension-origin errors from surfacing
 * as app errors (e.g. in the Next.js dev overlay).
 */
const extensionErrorGuard = `
window.addEventListener('error', function (event) {
  var src = event && event.filename;
  if (typeof src === 'string' && src.indexOf('chrome-extension://') === 0) {
    event.stopImmediatePropagation();
    event.preventDefault();
  }
}, true);
try {
  // Light is the default; dark is opt-in. data-theme='light' selects the
  // light tokens, the 'dark' class drives dark-only utility variants.
  if (localStorage.getItem('d17-theme') === 'dark') {
    document.documentElement.classList.add('dark');
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.classList.remove('dark');
  }
} catch (e) {
  document.documentElement.dataset.theme = 'light';
}
`

export const metadata: Metadata = {
  title: 'D17 Launch Terminal',
  description: 'A participant and deploy interface for D17 launches on Sepolia and Ethereum mainnet.',
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      {
        url: '/favicon.ico',
        sizes: 'any',
      },
      {
        url: '/favicon-16x16.png',
        sizes: '16x16',
        type: 'image/png',
      },
      {
        url: '/favicon-32x32.png',
        sizes: '32x32',
        type: 'image/png',
      },
      {
        url: '/favicon-48x48.png',
        sizes: '48x48',
        type: 'image/png',
      },
      {
        url: '/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        url: '/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
    shortcut: '/favicon.ico',
    apple: [
      {
        url: '/apple-touch-icon.png',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    // suppressHydrationWarning: the pre-paint theme script in extensionErrorGuard
    // sets data-theme="light" on <html> before React hydrates, so the server
    // markup (no data-theme) and the client DOM intentionally differ here.
    <html lang="en" data-theme="light" className={plexMono.variable} suppressHydrationWarning>
      <body className="font-sans antialiased">
        <script id="extension-error-guard" dangerouslySetInnerHTML={{ __html: extensionErrorGuard }} />
        {children}
        <Toaster
          position="bottom-left"
          theme="light"
          expand={false}
          gap={6}
          toastOptions={{
            style: {
              background: 'var(--panel)',
              border: '1px solid var(--hairline)',
              color: 'var(--ink)',
              borderRadius: '0',
            },
            classNames: {
              title:
                'font-mono uppercase tracking-[0.02em] text-[11px] text-ink',
              description: 'text-[13px] leading-relaxed text-dim',
            },
          }}
        />
      </body>
    </html>
  )
}
