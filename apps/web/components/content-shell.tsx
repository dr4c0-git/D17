import type { ReactNode } from "react";

// Frame of the documentation pages (/docs, /blog, /progress): the site's header with
// links back to the launches, then one readable column.
const SECTIONS = [
  { key: "docs", href: "/docs", label: "Docs" },
  { key: "blog", href: "/blog", label: "Blog" },
  { key: "progress", href: "/progress", label: "Progress" },
] as const;

export type Section = (typeof SECTIONS)[number]["key"];

export function ContentShell({ section, aside, children }: { section: Section; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="border-b border-hairline">
        <nav className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.04em] sm:px-6">
          <a href="/" className="font-semibold text-ink hover:underline">
            D17
          </a>
          <a href="/" className="text-quiet transition-colors hover:text-ink">
            Launches
          </a>
          {SECTIONS.map((item) => (
            <a
              key={item.key}
              href={item.href}
              aria-current={item.key === section ? "page" : undefined}
              className={item.key === section ? "text-ink underline underline-offset-4" : "text-quiet transition-colors hover:text-ink"}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 lg:flex-row lg:gap-12">
        {aside && <aside className="order-last shrink-0 border-t border-hairline pt-6 lg:order-none lg:w-52 lg:border-0 lg:pt-0">{aside}</aside>}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <footer className="mx-auto w-full max-w-5xl border-t border-hairline px-4 py-6 text-[13px] text-quiet sm:px-6">
        D17 V15 runs on Sepolia (testnet), not on mainnet yet. Open source under the MIT license:{" "}
        <a href="https://github.com/dr4c0-git/D17" rel="noopener noreferrer" target="_blank" className="underline underline-offset-2 hover:text-ink">
          source code
        </a>
        .
      </footer>
    </div>
  );
}

/** Side list of pages; the current one is marked. */
export function PageList({ title, pages, current }: { title: string; pages: { route: string; nav: string }[]; current?: string }) {
  return (
    <nav aria-label={title}>
      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.04em] text-quiet">{title}</p>
      <ul className="flex flex-col gap-1 text-[14px]">
        {pages.map((page) => (
          <li key={page.route}>
            <a
              href={page.route}
              aria-current={page.route === current ? "page" : undefined}
              className={page.route === current ? "font-semibold text-ink" : "text-dim transition-colors hover:text-ink"}
            >
              {page.nav}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Markdown({ html }: { html: string }) {
  // The HTML comes from the repository's own documentation, rendered at build time.
  return <article className="d17-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
