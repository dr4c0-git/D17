"use client";

// Simple view of a launch: one column, plain language, one action at a time.
// The full terminal (charts, every transaction, contract addresses) stays one
// click away behind "Expert view". This file only presents data computed by
// ParticipantsTerminal; it reads nothing from the chain itself.

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type SimplePhase =
  | "not-started"
  | "round"
  | "refund"
  | "finalize"
  | "settle"
  | "pool-ready"
  | "trading"
  | "failed"
  | "unknown";

export type SimpleRound = {
  startAt: number;
  endAt: number;
  refundEndAt: number;
  takeBackFeePct: number;
  hasTakeBack: boolean;
};

export type SimpleModel = {
  chainName: string;
  isMainnet: boolean;
  hasLaunch: boolean;
  loaded: boolean;
  phase: SimplePhase;
  roundIndex: number; // current round (0-based) for "round" and "refund"
  startsAt: number;
  endsAt: number;
  rounds: SimpleRound[];
  nowSeconds: number;
  launch: {
    name: string;
    symbol: string;
    description: string;
    logoSrc: string;
    links: { label: string; url: string }[];
    verified: boolean;
  } | null;
  rulesMismatch: boolean;
  rules: {
    creatorEthPct: number;
    feePct: number;
    laterTakeBackFeePct: number;
    supply: number;
    salePct: number;
    poolPct: number;
    creatorTokenPct: number;
    burnedPct: number;
  } | null;
  raisedEth: number;
  participants: number;
  minimumEth: number; // round 1 minimum
  minimumReached: boolean;
  roundOneRaisedEth: number;
  roundOneTokens: number; // tokens sold in round 1 (all of them, once the minimum is reached)
  roundMarket: { priceEth: number | null; raisedEth: number }[]; // per round, price = ETH per token
  priceEthPerToken: number | null;
  wallet: { connected: boolean; hasVault: boolean; findingVault: boolean };
  mine: {
    totalEth: number;
    totalTokens: number;
    rows: { round: number; eth: number; tokens: number; takenBack: boolean; collected: boolean }[];
    collected: boolean;
    tokensToSend: number;
    ethToRecover: number;
    ethWaiting: number; // refunded ETH sitting in the vault for this launch
  };
  takeBack: { eth: number; feePct: number };
  amount: string;
  setAmount: (value: string) => void;
  estimateTokens: number | null;
  pending: string;
  pendingSeconds: number;
  canCommit: boolean;
  canTakeBack: boolean;
  canClose: boolean;
  canCollect: boolean;
  canOpenTrading: boolean;
  canSend: boolean;
  canRecover: boolean;
  tokenAddress: string;
  creatorVesting: { total: number; unlocked: number; sent: number; fullyUnlockedAt: number; canSend: boolean } | null;
  otherLaunches: { address: string; label: string; status: string; current: boolean }[];
  actions: {
    connect: () => void;
    createVault: () => void;
    commit: () => void;
    takeBack: () => void;
    close: () => void;
    collect: () => void;
    openTrading: () => void;
    send: () => void;
    recover: () => void;
    sendEth: () => void;
    releaseCreator: () => void;
    selectLaunch: (address: string) => void;
    expertView: () => void;
  };
};

const card = "border border-hairline bg-panel/40 px-5 py-5 sm:px-6";
const bigButton = "mt-4 h-12 w-full font-sans text-[15px] font-semibold normal-case tracking-normal";

export function SimpleView({ m }: { m: SimpleModel }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6 sm:px-6">
      {m.launch && <LaunchHeader m={m} />}
      {m.rulesMismatch && (
        <p className="border border-alert px-5 py-4 text-[15px] leading-relaxed text-alert" role="alert">
          Warning: the link you opened describes different rules than this launch actually has. Do not put in ETH from
          this link.
        </p>
      )}
      {!m.hasLaunch ? (
        <section className={card}>
          <h2 className="text-[20px] font-semibold text-ink">Pick a launch</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-dim">Choose one of the launches below to see it here.</p>
        </section>
      ) : !m.loaded ? (
        <section className={card}>
          <p className="text-[15px] text-dim">Loading the launch from {m.chainName}…</p>
        </section>
      ) : (
        <>
          <StatusCard m={m} />
          <ActionCard m={m} />
          {m.mine.ethWaiting > 0 && m.wallet.hasVault && <EthWaiting m={m} />}
          <Numbers m={m} />
          {!["not-started", "failed", "unknown"].includes(m.phase) && <RoundPriceChart m={m} />}
          {(m.mine.totalEth > 0 || m.mine.rows.length > 0) && <Participation m={m} />}
          {m.phase === "trading" && m.creatorVesting && m.creatorVesting.total > 0 && <CreatorTokens m={m} />}
          {m.rules && <HowItWorks m={m} />}
        </>
      )}
      {m.otherLaunches.length > 1 && <OtherLaunches m={m} />}
      <p className="pt-2 text-center text-[14px] text-dim">
        Want every detail: charts, every transaction, contract addresses?{" "}
        <button type="button" onClick={m.actions.expertView} className="text-electric underline underline-offset-2 hover:text-ink">
          Switch to expert view
        </button>
      </p>
    </div>
  );
}

function LaunchHeader({ m }: { m: SimpleModel }) {
  const launch = m.launch!;
  const initials = (launch.symbol || launch.name || "?").slice(0, 3).toUpperCase();
  return (
    <section className="flex items-start gap-4">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden border border-hairline bg-panel">
        {launch.logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={launch.logoSrc} alt="" className="h-full w-full object-contain" />
        ) : (
          <span className="text-[13px] font-semibold text-dim">{initials}</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="text-[24px] font-semibold leading-tight text-ink">
          {launch.name || "Untitled launch"}{" "}
          {launch.symbol && <span className="text-[16px] font-normal text-dim">({launch.symbol})</span>}
        </h1>
        {launch.verified && (
          <p className="mt-1 text-[13px] text-live">✓ Official D17 launch: rules checked and locked</p>
        )}
        {launch.description && <p className="mt-2 text-[15px] leading-relaxed text-dim">{launch.description}</p>}
        {launch.links.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
            {launch.links.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="text-electric underline underline-offset-2 hover:text-ink">
                {link.label} ↗
              </a>
            ))}
          </p>
        )}
      </div>
    </section>
  );
}

function statusText(m: SimpleModel): { title: string; detail: string } {
  const round = m.roundIndex + 1;
  const total = m.rounds.length || 5;
  switch (m.phase) {
    case "not-started":
      return {
        title: "Starting soon",
        detail: m.startsAt > m.nowSeconds ? `The sale opens in ${duration(m.startsAt - m.nowSeconds)}.` : "The sale is opening…",
      };
    case "round":
      return {
        title: `Round ${round} of ${total} is open`,
        detail: `${duration(Math.max(0, m.endsAt - m.nowSeconds))} left to join this round.`,
      };
    case "refund":
      if (m.roundIndex === 0 && m.minimumEth > 0 && !m.minimumReached) {
        return {
          title: "Round 1 did not reach its minimum",
          detail: `It raised ${eth(m.roundOneRaisedEth)} of the ${eth(m.minimumEth)} ETH it needed. In ${duration(
            Math.max(0, m.endsAt - m.nowSeconds)
          )} the launch will be cancelled and everyone gets all of their ETH back, with no fee.`,
        };
      }
      return {
        title: `Round ${round} is over`,
        detail: `If you changed your mind, you can take your round ${round} ETH back for the next ${duration(
          Math.max(0, m.endsAt - m.nowSeconds)
        )}. Then round ${round + 1} opens.`,
      };
    case "finalize":
      return { title: "The sale is over", detail: "One last step closes it. Anyone can do it, in one click." };
    case "settle":
      return {
        title: "Time to collect your tokens",
        detail:
          m.endsAt > m.nowSeconds
            ? `The sale is closed. Trading opens in ${duration(m.endsAt - m.nowSeconds)}.`
            : "The sale is closed. Trading can open now.",
      };
    case "pool-ready":
      return {
        title: "Ready to open trading",
        detail: "Anyone can now open trading. The raised ETH and the tokens go into a trading pool that stays locked forever.",
      };
    case "trading":
      return { title: "Trading is open", detail: "The sale is finished and the token can now be bought and sold." };
    case "failed":
      return {
        title: "This launch was cancelled",
        detail: "Round 1 did not reach its minimum. Everyone can take back all of their ETH, with no fee.",
      };
    default:
      return { title: "Loading…", detail: "" };
  }
}

function StatusCard({ m }: { m: SimpleModel }) {
  const { title, detail } = statusText(m);
  const live = m.phase === "round" || m.phase === "refund";
  const span = m.endsAt - m.startsAt;
  const progress = live && span > 0 ? Math.min(100, Math.max(0, ((m.nowSeconds - m.startsAt) / span) * 100)) : null;
  const steps: { label: string; state: "done" | "now" | "next" }[] = [
    {
      label: "Sale",
      state: ["not-started", "round", "refund"].includes(m.phase) ? "now" : m.phase === "failed" ? "now" : "done",
    },
    {
      label: "Collect tokens",
      state: ["finalize", "settle", "pool-ready"].includes(m.phase) ? "now" : m.phase === "trading" ? "done" : "next",
    },
    { label: "Trading", state: m.phase === "trading" ? "now" : "next" },
  ];
  return (
    <section className={card} aria-live="polite">
      <ol className="flex items-center gap-2 text-[13px]">
        {steps.map((step, index) => (
          <li key={step.label} className="flex items-center gap-2">
            {index > 0 && <span aria-hidden className="text-quiet">→</span>}
            <span
              className={
                step.state === "now"
                  ? m.phase === "failed"
                    ? "font-semibold text-alert"
                    : "font-semibold text-ink"
                  : step.state === "done"
                    ? "text-live"
                    : "text-quiet"
              }
            >
              {step.state === "done" ? "✓ " : ""}
              {step.label}
            </span>
          </li>
        ))}
      </ol>
      <h2 className={`mt-4 text-[22px] font-semibold leading-snug ${m.phase === "failed" ? "text-alert" : "text-ink"}`}>
        {live && <span aria-hidden className="mr-2 inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-live align-middle" />}
        {title}
      </h2>
      {detail && <p className="mt-1.5 text-[16px] leading-relaxed text-dim">{detail}</p>}
      {progress !== null && (
        <div className="mt-4 h-1.5 w-full bg-faint" aria-hidden>
          <div className="h-full bg-ink transition-[width] duration-1000" style={{ width: `${progress}%` }} />
        </div>
      )}
    </section>
  );
}

function Steps({ m, verb }: { m: SimpleModel; verb: string }) {
  const items = [
    { label: "Connect your wallet", done: m.wallet.connected },
    { label: "Create your personal vault", done: m.wallet.hasVault },
    { label: verb, done: false },
  ];
  return (
    <ol className="flex flex-col gap-1 text-[14px] sm:flex-row sm:flex-wrap sm:gap-x-5">
      {items.map((item, index) => {
        const current = !item.done && items.slice(0, index).every((previous) => previous.done);
        return (
          <li key={item.label} className={item.done ? "text-live" : current ? "font-semibold text-ink" : "text-quiet"}>
            {item.done ? "✓" : `${index + 1}.`} {item.label}
          </li>
        );
      })}
    </ol>
  );
}

/** One button that walks the user through wallet → vault → the action. */
function Cta({
  m,
  label,
  onClick,
  disabled,
  needsVault = true,
}: {
  m: SimpleModel;
  label: string;
  onClick: () => void;
  disabled: boolean;
  needsVault?: boolean;
}) {
  if (m.pending) {
    return (
      <Button className={`${bigButton} tx-pending`} aria-busy="true" disabled>
        Waiting for confirmation… {m.pendingSeconds}s
      </Button>
    );
  }
  if (!m.wallet.connected) {
    return (
      <Button className={bigButton} onClick={m.actions.connect}>
        Connect my wallet
      </Button>
    );
  }
  if (needsVault && !m.wallet.hasVault) {
    if (m.wallet.findingVault) {
      return (
        <Button className={bigButton} variant="secondary" disabled>
          Looking for your vault…
        </Button>
      );
    }
    return (
      <>
        <Button className={bigButton} onClick={m.actions.createVault}>
          Create my personal vault (one time)
        </Button>
        <p className="mt-2 text-[13px] leading-relaxed text-dim">
          Your vault is a small contract that only you control. Your ETH waits there, never with the creator.
        </p>
      </>
    );
  }
  return (
    <Button className={bigButton} onClick={onClick} disabled={disabled}>
      {label}
    </Button>
  );
}

function ActionCard({ m }: { m: SimpleModel }) {
  const symbol = m.launch?.symbol || "tokens";
  const round = m.roundIndex + 1;
  const current = m.rounds[m.roundIndex];
  // Round 1 missed its minimum: the launch will be cancelled, so taking ETH back now only costs a fee.
  const roundOneMissed = m.roundIndex === 0 && m.minimumEth > 0 && !m.minimumReached;
  let body: ReactNode = null;

  if (m.phase === "not-started") {
    body = (
      <>
        <Steps m={m} verb="Put in ETH when it opens" />
        <p className="mt-3 text-[15px] leading-relaxed text-dim">
          Get ready before it opens: connect your wallet and create your personal vault. It only takes a minute.
        </p>
        {m.wallet.connected && m.wallet.hasVault ? (
          <p className="mt-3 text-[15px] font-semibold text-live">You are ready ✓ Come back when round 1 opens.</p>
        ) : (
          <Cta m={m} label="" onClick={() => undefined} disabled />
        )}
      </>
    );
  } else if (m.phase === "round") {
    const amount = Number(m.amount);
    body = (
      <>
        <Steps m={m} verb="Put in ETH" />
        <label htmlFor="simple-amount" className="mt-4 block text-[15px] font-semibold text-ink">
          How much ETH do you want to put in?
        </label>
        <div className="mt-2 flex items-center gap-2">
          <Input
            id="simple-amount"
            inputMode="decimal"
            value={m.amount}
            onChange={(event) => m.setAmount(event.target.value)}
            aria-label="Amount of ETH to put in"
            disabled={Boolean(m.pending)}
            className="h-12 px-3 font-sans text-[18px] tabular-nums md:text-[18px]"
          />
          <span className="text-[15px] text-dim">ETH</span>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-dim">
          {m.estimateTokens
            ? `At the current price you would get about ${tokens(m.estimateTokens)} ${symbol}.`
            : round === 1
              ? "Round 1 sets the price: the more ETH comes in, the higher the price."
              : "The price is set by how much ETH comes in."}{" "}
          Everyone in this round pays the same price, set when the round ends.
        </p>
        <Cta
          m={m}
          label={amount > 0 ? `Put in ${m.amount} ETH` : "Put in ETH"}
          onClick={m.actions.commit}
          disabled={!m.canCommit || !(amount > 0)}
        />
        <p className="mt-3 text-[13px] leading-relaxed text-dim">
          {current?.hasTakeBack
            ? `Changed your mind? Right after this round you can take your ETH back (${current.takeBackFeePct}% fee).`
            : "This is the last round: after it, ETH can no longer be taken back."}
        </p>
      </>
    );
  } else if (m.phase === "refund") {
    body = (
      <>
        <Steps m={m} verb={roundOneMissed ? "Wait for the cancellation" : "Take back my ETH (optional)"} />
        {roundOneMissed ? (
          <p className="mt-3 text-[15px] leading-relaxed text-dim">
            Nothing to do. <span className="font-semibold text-ink">Do not take your ETH back now</span>: it would cost
            {" "}{m.takeBack.feePct}%, while the cancellation gives everything back, with no fee.
          </p>
        ) : m.mine.rows.some((row) => row.round === m.roundIndex && row.takenBack) ? (
          <p className="mt-3 text-[15px] font-semibold leading-relaxed text-live">
            ✓ You took back your round {round} ETH.{m.mine.ethWaiting > 0 ? " Last step below: send it to your wallet." : ""}
          </p>
        ) : m.takeBack.eth > 0 ? (
          <>
            <p className="mt-3 text-[15px] leading-relaxed text-dim">
              You put {eth(m.takeBack.eth)} ETH in round {round}. If you take it back now, you receive{" "}
              <span className="font-semibold text-ink">{eth(m.takeBack.eth * (1 - m.takeBack.feePct / 100))} ETH</span>. The{" "}
              {m.takeBack.feePct}% fee goes into the trading pool, not to anyone. If you keep it, there is nothing to do.
            </p>
            <Cta m={m} label="Take back my ETH" onClick={m.actions.takeBack} disabled={!m.canTakeBack} />
          </>
        ) : (
          <p className="mt-3 text-[15px] leading-relaxed text-dim">
            {m.wallet.connected
              ? `You have nothing to take back from round ${round}. The next round opens soon.`
              : `Connect your wallet to check whether you have ETH to take back from round ${round}.`}
          </p>
        )}
        {!m.wallet.connected && <Cta m={m} label="" onClick={() => undefined} disabled />}
      </>
    );
  } else if (m.phase === "finalize") {
    body = (
      <>
        <p className="text-[15px] leading-relaxed text-dim">
          The 5 rounds are over. Closing the sale counts the results, destroys the tokens nobody bought and lets everyone
          collect their tokens. Anyone can click: it only costs the network fee.
        </p>
        <Cta m={m} label="Close the sale" onClick={m.actions.close} disabled={!m.canClose} needsVault={false} />
      </>
    );
  } else if (m.phase === "settle" || m.phase === "pool-ready") {
    body = (
      <>
        {m.mine.collected ? (
          <p className="text-[15px] font-semibold text-live">Your tokens are collected ✓</p>
        ) : m.mine.totalEth > 0 ? (
          <>
            <p className="text-[15px] leading-relaxed text-dim">
              You get about <span className="font-semibold text-ink">{tokens(m.mine.totalTokens)} {symbol}</span>. Collect them
              now: they go into your vault, and you can send them to your wallet once trading opens.
            </p>
            <Cta m={m} label="Collect my tokens" onClick={m.actions.collect} disabled={!m.canCollect} />
          </>
        ) : (
          <p className="text-[15px] leading-relaxed text-dim">
            {m.wallet.connected ? "You did not take part in this sale." : "Connect your wallet to see your tokens."}
          </p>
        )}
        {!m.wallet.connected && !m.mine.collected && m.mine.totalEth === 0 && (
          <Cta m={m} label="" onClick={() => undefined} disabled />
        )}
        {m.phase === "pool-ready" && (
          <div className="mt-5 border-t border-faint pt-4">
            <p className="text-[15px] leading-relaxed text-dim">
              Everything is ready: anyone can open trading now.
            </p>
            <Cta m={m} label="Open trading" onClick={m.actions.openTrading} disabled={!m.canOpenTrading} needsVault={false} />
          </div>
        )}
      </>
    );
  } else if (m.phase === "trading") {
    body = (
      <>
        {m.mine.tokensToSend > 0 ? (
          <>
            <p className="text-[15px] leading-relaxed text-dim">
              You have <span className="font-semibold text-ink">{tokens(m.mine.tokensToSend)} {symbol}</span> waiting in your
              vault.
            </p>
            <Cta m={m} label="Send my tokens to my wallet" onClick={m.actions.send} disabled={!m.canSend} />
          </>
        ) : (
          <>
            <p className={`text-[15px] leading-relaxed ${m.mine.collected && m.mine.totalEth > 0 ? "font-semibold text-live" : "text-dim"}`}>
              {!m.wallet.connected
                ? "Connect your wallet to see whether you have tokens waiting."
                : m.mine.collected && m.mine.totalEth > 0
                  ? `Your ${symbol} are in your wallet ✓`
                  : "You have no tokens waiting in your vault."}
            </p>
            {!m.wallet.connected && <Cta m={m} label="" onClick={() => undefined} disabled />}
          </>
        )}
        {m.isMainnet && m.tokenAddress && (
          <p className="mt-4 text-[15px]">
            <a
              href={`https://app.uniswap.org/swap?outputCurrency=${m.tokenAddress}`}
              target="_blank"
              rel="noreferrer"
              className="text-electric underline underline-offset-2 hover:text-ink"
            >
              Buy or sell {symbol} on Uniswap ↗
            </a>
          </p>
        )}
      </>
    );
  } else if (m.phase === "failed") {
    body =
      m.mine.ethToRecover > 0 ? (
        <>
          <p className="text-[15px] leading-relaxed text-dim">
            You get back all of your <span className="font-semibold text-ink">{eth(m.mine.ethToRecover)} ETH</span>.
          </p>
          <Cta m={m} label="Get my ETH back" onClick={m.actions.recover} disabled={!m.canRecover} />
        </>
      ) : (
        <>
          <p className="text-[15px] leading-relaxed text-dim">
            {!m.wallet.connected
              ? "Connect your wallet to get your ETH back."
              : m.mine.ethWaiting > 0 || m.mine.rows.some((row) => row.takenBack)
                ? m.mine.ethWaiting > 0
                  ? "✓ Your ETH is out of the launch. Last step below: send it to your wallet."
                  : "✓ Your ETH is back in your wallet."
                : "You have no ETH in this launch."}
          </p>
          {!m.wallet.connected && <Cta m={m} label="" onClick={() => undefined} disabled />}
        </>
      );
  }

  if (!body) return null;
  return (
    <section className={card}>
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.04em] text-quiet">What you can do now</h2>
      {body}
    </section>
  );
}

function EthWaiting({ m }: { m: SimpleModel }) {
  return (
    <section className={card}>
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.04em] text-quiet">ETH waiting for you</h2>
      <p className="text-[15px] leading-relaxed text-dim">
        <span className="font-semibold text-ink">{eth(m.mine.ethWaiting)} ETH</span> you took back is waiting in your
        personal vault. Send it back to your wallet whenever you like: your wallet asks you to confirm twice (once to leave
        the vault, once to turn WETH back into ETH).
      </p>
      <Cta m={m} label={`Send ${eth(m.mine.ethWaiting)} ETH to my wallet`} onClick={m.actions.sendEth} disabled={Boolean(m.pending)} />
    </section>
  );
}

function CreatorTokens({ m }: { m: SimpleModel }) {
  const v = m.creatorVesting!;
  const symbol = m.launch?.symbol || "tokens";
  const pct = v.total > 0 ? Math.min(100, (v.unlocked / v.total) * 100) : 0;
  const waiting = Math.max(0, v.unlocked - v.sent);
  return (
    <section className={card}>
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.04em] text-quiet">The creator&apos;s tokens</h2>
      <p className="text-[15px] leading-relaxed text-dim">
        The creator gets <span className="font-semibold text-ink">{tokens(v.total)} {symbol}</span>, unlocked little by little until{" "}
        {new Date(v.fullyUnlockedAt * 1000).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}, so they
        cannot sell everything at once.
      </p>
      <div className="mt-3 h-1.5 w-full bg-faint" aria-hidden>
        <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-[14px] text-dim tabular-nums">
        Unlocked so far: {tokens(v.unlocked)} ({pct < 1 ? "less than 1" : pct.toFixed(0)}%) · already sent to the creator:{" "}
        {tokens(v.sent)}
      </p>
      {waiting > 0 && (
        <>
          <Cta
            m={m}
            label={`Send the unlocked ${tokens(waiting)} ${symbol} to the creator`}
            onClick={m.actions.releaseCreator}
            disabled={!v.canSend}
            needsVault={false}
          />
          <p className="mt-2 text-[13px] text-dim">Anyone can click this. The tokens always go to the creator written in the rules.</p>
        </>
      )}
    </section>
  );
}

function Numbers({ m }: { m: SimpleModel }) {
  const symbol = m.launch?.symbol || "tokens";
  const items: { label: string; value: string }[] = [
    { label: m.phase === "trading" ? "Total raised" : "Raised so far", value: `${eth(m.raisedEth)} ETH` },
    { label: "Participants", value: String(m.participants) },
  ];
  if (m.priceEthPerToken && m.priceEthPerToken > 0) {
    items.push({
      label: m.phase === "trading" ? "Sale price" : "Current price",
      value: `1 ETH ≈ ${tokens(1 / m.priceEthPerToken)} ${symbol}`,
    });
  }
  const showMinimum =
    m.minimumEth > 0 && ["not-started", "round", "refund"].includes(m.phase) && m.roundIndex === 0 && !m.minimumReached;
  return (
    <section className={card}>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {items.map((item) => (
          <div key={item.label}>
            <dt className="text-[13px] text-quiet">{item.label}</dt>
            <dd className="mt-0.5 text-[18px] font-semibold text-ink tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
      {showMinimum && (
        <div className="mt-4 border-t border-faint pt-4">
          <p className="text-[14px] leading-relaxed text-dim">
            Round 1 needs at least <span className="font-semibold text-ink">{eth(m.minimumEth)} ETH</span> (
            {eth(m.roundOneRaisedEth)} ETH so far). If it is not reached, the launch is cancelled and everyone gets all of
            their ETH back.
          </p>
          <div className="mt-2 h-1.5 w-full bg-faint" aria-hidden>
            <div className="h-full bg-live" style={{ width: `${Math.min(100, (m.roundOneRaisedEth / m.minimumEth) * 100)}%` }} />
          </div>
        </div>
      )}
    </section>
  );
}

/** Price paid in each round, against the round-1 price that no round can go below. */
function RoundPriceChart({ m }: { m: SimpleModel }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const symbol = m.launch?.symbol || "tokens";
  const rounds = m.roundMarket.slice(0, 5);
  const floor = rounds[0]?.priceEth ?? null;
  const prices = rounds.map((round) => round.priceEth ?? 0);
  const max = Math.max(...prices, floor ?? 0);
  if (!floor || max <= 0) return null;

  const current = ["round", "refund"].includes(m.phase) ? m.roundIndex : -1;
  const pct = (price: number) => `${(price / max) * 100}%`;
  const perEth = (price: number) => `1 ETH ≈ ${tokens(1 / price)} ${symbol}`;
  const focus = hovered ?? (current >= 0 ? current : null);
  const focusRound = focus !== null ? rounds[focus] : null;

  // Plain HTML bars (not an SVG) so labels keep their size on every screen width.
  return (
    <section className={card}>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-quiet">Price per round</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-dim">
        No round can sell cheaper than round 1 (dashed line). A busy round pays more.
      </p>
      <p className="mt-3 min-h-[20px] text-[14px] text-ink tabular-nums" aria-live="polite">
        {focusRound
          ? focusRound.priceEth
            ? `Round ${focus! + 1}: ${perEth(focusRound.priceEth)} · ${eth(focusRound.raisedEth)} ETH raised`
            : `Round ${focus! + 1}: no price yet`
          : "Hover or tap a round to see its price."}
      </p>
      <div className="relative mt-6 h-36 border-b border-hairline" aria-hidden>
        <div className="absolute inset-x-0 border-t-[1.5px] border-dashed border-ink" style={{ bottom: pct(floor) }}>
          <span className="absolute -top-5 right-0 text-[12px] text-dim">Round 1 price (the floor)</span>
        </div>
        <div className="flex h-full items-end gap-2 sm:gap-4">
          {rounds.map((round, index) => {
            const active = index === focus;
            return (
              <button
                key={index}
                type="button"
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered(null)}
                onClick={() => setHovered(index)}
                className="flex h-full flex-1 items-end"
                tabIndex={-1}
              >
                {round.priceEth ? (
                  <span
                    className={`block w-full rounded-t ${index === current ? "bg-ink" : active ? "bg-dim" : "bg-quiet"}`}
                    style={{ height: pct(round.priceEth) }}
                  />
                ) : (
                  <span className="block w-full rounded-t border border-b-0 border-dashed border-hairline" style={{ height: pct(floor) }} />
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex gap-2 text-center sm:gap-4">
        {rounds.map((_, index) => (
          <div key={index} className="flex-1">
            <p className={`text-[13px] ${index === focus ? "font-semibold text-ink" : "text-dim"}`}>
              <span className="sm:hidden">R{index + 1}</span>
              <span className="hidden sm:inline">Round {index + 1}</span>
            </p>
            {index === current && <p className="text-[11.5px] text-quiet">{m.phase === "round" ? "now" : "take-back"}</p>}
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>Price per round</caption>
        <thead>
          <tr>
            <th>Round</th>
            <th>Price</th>
            <th>ETH raised</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((round, index) => (
            <tr key={index}>
              <td>{index + 1}</td>
              <td>{round.priceEth ? perEth(round.priceEth) : "no price yet"}</td>
              <td>{eth(round.raisedEth)} ETH</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Participation({ m }: { m: SimpleModel }) {
  const symbol = m.launch?.symbol || "tokens";
  const failed = m.phase === "failed";
  // Before round 1 reaches its minimum the contract counts no tokens yet: estimate what the
  // round-1 share would be if it closed now (or at the minimum, whichever is higher).
  const roundOnePending = !m.minimumReached && m.minimumEth > 0;
  const rowTokens = (row: SimpleModel["mine"]["rows"][number]) =>
    row.round === 0 && roundOnePending && row.tokens === 0
      ? (row.eth * m.roundOneTokens) / Math.max(m.roundOneRaisedEth, m.minimumEth)
      : row.tokens;
  const total = m.mine.rows.filter((row) => !row.takenBack).reduce((sum, row) => sum + rowTokens(row), 0);
  return (
    <section className={card}>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-quiet">Your participation</h2>
      {m.mine.totalEth > 0 &&
        (failed ? (
          <p className="mt-2 text-[18px] text-ink">
            You put in <span className="font-semibold">{eth(m.mine.totalEth)} ETH</span>: all of it comes back to you.
          </p>
        ) : (
          <p className="mt-2 text-[18px] text-ink">
            You put in <span className="font-semibold">{eth(m.mine.totalEth)} ETH</span> → about{" "}
            <span className="font-semibold">
              {tokens(total)} {symbol}
            </span>
            {roundOnePending && m.mine.rows.some((row) => row.round === 0 && !row.takenBack) && (
              <span className="block text-[13px] text-dim">if round 1 reaches its minimum</span>
            )}
          </p>
        ))}
      <ul className="mt-3 flex flex-col gap-1.5 text-[14px] text-dim">
        {m.mine.rows.map((row) => (
          <li key={row.round} className="flex flex-wrap justify-between gap-x-4 border-b border-faint pb-1.5 last:border-b-0">
            <span>Round {row.round + 1}</span>
            <span className="tabular-nums">
              {row.takenBack
                ? "Taken back"
                : failed
                  ? `${eth(row.eth)} ETH · to get back`
                  : `${eth(row.eth)} ETH → ~${tokens(rowTokens(row))} ${symbol}${row.collected ? " · collected ✓" : ""}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HowItWorks({ m }: { m: SimpleModel }) {
  const r = m.rules!;
  const poolEthPct = Math.max(0, 100 - r.creatorEthPct - r.feePct);
  const lastTakeBackRound = m.rounds.filter((round) => round.hasTakeBack).length;
  const items: ReactNode[] = [
    <>
      The sale has <b>{m.rounds.length || 5} short rounds</b>. In each round, everyone pays the same price, set by how much ETH
      comes in. No round can sell cheaper than round 1.
    </>,
    m.minimumEth > 0 ? (
      <>
        If round 1 raises less than <b>{eth(m.minimumEth)} ETH</b>, the launch is cancelled and everyone gets all of their ETH
        back.
      </>
    ) : null,
    <>
      Changed your mind? After rounds 1 and 2 you can take your ETH back for <b>1%</b>
      {lastTakeBackRound > 2 ? (
        <>
          , after rounds 3{lastTakeBackRound === 4 ? " and 4" : ` to ${lastTakeBackRound}`} for <b>{r.laterTakeBackFeePct}%</b>
        </>
      ) : null}
      . The fee goes into the trading pool, not to anyone.
    </>,
    <>
      Of every 1 ETH that stays in: <b>{poolEthPct}%</b> is locked forever in the trading pool, <b>{r.creatorEthPct}%</b> goes to
      the creator{r.feePct > 0 ? <>, <b>{r.feePct}%</b> is the D17 fee</> : null}.
    </>,
    r.supply > 0 ? (
      <>
        Of the {tokens(r.supply)} {m.launch?.symbol || "tokens"}: <b>{r.salePct}%</b> for buyers, <b>{r.poolPct}%</b> locked in the
        trading pool
        {r.creatorTokenPct > 0 ? (
          <>
            , <b>{r.creatorTokenPct}%</b> to the creator, unlocked little by little over 6 months
          </>
        ) : null}
        {r.burnedPct > 0 ? (
          <>
            , <b>{r.burnedPct}%</b> destroyed
          </>
        ) : null}
        . Tokens nobody buys are destroyed.
      </>
    ) : null,
    <>
      Nobody, not the creator and not D17, can change these rules, touch your ETH or take the liquidity out of the pool.
    </>,
  ].filter(Boolean);
  return (
    <section className={card}>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-quiet">How this launch works</h2>
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-[15px] leading-relaxed text-dim [&_b]:font-semibold [&_b]:text-ink">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function OtherLaunches({ m }: { m: SimpleModel }) {
  return (
    <section className={card}>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-quiet">Launches</h2>
      <ul className="mt-2 flex flex-col">
        {m.otherLaunches.map((launch) => (
          <li key={launch.address} className="border-b border-faint last:border-b-0">
            <button
              type="button"
              onClick={() => m.actions.selectLaunch(launch.address)}
              aria-current={launch.current ? "page" : undefined}
              className={`flex w-full items-center justify-between gap-4 py-2.5 text-left text-[15px] hover:text-ink ${
                launch.current ? "font-semibold text-ink" : "text-dim"
              }`}
            >
              <span>{launch.label}</span>
              <span className="text-[13px] text-quiet">{plainStatus(launch.status)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Turns the terminal's phase labels into plain words for the launch list. */
function plainStatus(label: string): string {
  const round = /^Round (\d+) open$/i.exec(label);
  if (round) return `Round ${round[1]} open`;
  const takeBack = /^Round (\d+) refund$/i.exec(label);
  if (takeBack) return `Round ${takeBack[1]} · take-back time`;
  const map: Record<string, string> = {
    "Not started": "Starting soon",
    "Ready to finalize": "Sale over",
    "Settlement · claim window open": "Collecting tokens",
    "Pool ready": "Opening trading",
    "Trading open": "Trading open",
    "Launch failed": "Cancelled",
  };
  return map[label] ?? label;
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} day${days > 1 ? "s" : ""}${hours ? ` ${hours} h` : ""}`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${s % 60} s`;
  return `${s} s`;
}

function eth(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  if (value < 0.0001) return "< 0.0001";
  return value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 4 : 3 });
}

function tokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const short = (scaled: number) => scaled.toFixed(2).replace(/\.?0+$/, "");
  if (value >= 1e9) return `${short(value / 1e9)} billion`;
  if (value >= 1e6) return `${short(value / 1e6)} million`;
  return value.toLocaleString("en-US", { maximumFractionDigits: value < 10 ? 2 : 0 });
}
