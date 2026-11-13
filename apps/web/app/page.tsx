import type { Metadata } from "next";

// Welcome page. The launch terminal lives at /launches. Old links such as
// /?launch=0x... or /?network=mainnet are forwarded there before the page paints.
export const metadata: Metadata = {
  title: "Godspel",
  description: "Godspel builds open-source protocols whose rules are public, verifiable on-chain and enforced by code. D17, fair token launches on Ethereum, is the first.",
};

const forwardLegacyLinks = `
(function () {
  var params = new URLSearchParams(window.location.search);
  if (params.has('launch') || params.has('view') || params.has('network')) {
    window.location.replace('/launches' + window.location.search + window.location.hash);
  }
})();
`;

const D17_FACTS = [
  "Rules are published and frozen before anyone commits.",
  "Your ETH stays in your own locker contract, never with the creator.",
  "Refund windows between rounds let you change your mind.",
  "Pool liquidity is locked forever.",
];

export default function Welcome() {
  return (
    <div className="flex min-h-dvh flex-col bg-paper text-ink">
      <script dangerouslySetInnerHTML={{ __html: forwardLegacyLinks }} />

      <header className="border-b border-hairline">
        <nav className="mx-auto flex w-full max-w-4xl items-center gap-5 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.04em] sm:px-6">
          <a href="/" className="font-semibold text-ink">
            Godspel
          </a>
          <span className="flex-1" />
          <a href="/launches" className="text-quiet transition-colors hover:text-ink">
            Launches
          </a>
          <a href="/docs" className="text-quiet transition-colors hover:text-ink">
            Docs
          </a>
          <a href="https://x.com/godspelxyz" rel="noopener noreferrer" target="_blank" className="text-quiet transition-colors hover:text-ink">
            X
          </a>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 sm:px-6">
        <section className="py-20 sm:py-28">
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-quiet">Godspel: Old English for good news</p>
          <h1 className="mt-5 max-w-2xl text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[52px]">
            Good news, enforced by code.
          </h1>
          <p className="mt-6 max-w-xl text-[16px] leading-relaxed text-dim">
            Godspel builds open-source protocols whose rules are public, verifiable on-chain and enforced by contracts, not by
            promises.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <a
              href="/launches"
              className="inline-flex items-center rounded-md bg-ink px-5 py-2.5 text-[14px] font-semibold text-paper transition-opacity hover:opacity-85"
            >
              Open D17
            </a>
            <a
              href="/docs/guide"
              className="inline-flex items-center rounded-md border border-hairline px-5 py-2.5 text-[14px] text-ink transition-colors hover:bg-faint"
            >
              How it works
            </a>
          </div>
        </section>

        <section className="border-t border-hairline py-14">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.08em] text-quiet">Projects</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-[2fr_1fr]">
            <a href="/launches" className="group rounded-lg border border-hairline p-6 transition-colors hover:border-dim">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-[22px] font-semibold">D17</h3>
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-live">
                  <span className="h-1.5 w-1.5 rounded-full bg-live" aria-hidden="true" />
                  Live on mainnet
                </span>
              </div>
              <p className="mt-2 text-[15px] text-dim">Fair token launches on Ethereum.</p>
              <ul className="mt-5 flex flex-col gap-2 text-[14px] text-dim">
                {D17_FACTS.map((fact) => (
                  <li key={fact} className="flex gap-2.5">
                    <span className="text-quiet" aria-hidden="true">
                      -
                    </span>
                    {fact}
                  </li>
                ))}
              </ul>
              <p className="mt-6 text-[14px] font-semibold text-ink">
                Open launches <span className="inline-block transition-transform group-hover:translate-x-0.5">→</span>
              </p>
            </a>
            <div className="flex flex-col justify-center rounded-lg border border-dashed border-hairline p-6 text-[14px] text-quiet">
              More projects to come.
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2 px-4 py-6 text-[13px] text-quiet sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>Open source (MIT). No formal third-party audit: use at your own risk.</p>
          <p className="flex gap-4">
            <a href="https://github.com/dr4c0-git/D17" rel="noopener noreferrer" target="_blank" className="underline-offset-2 hover:text-ink hover:underline">
              Source code
            </a>
            <a href="/progress" className="underline-offset-2 hover:text-ink hover:underline">
              Progress
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
