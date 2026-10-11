"use client";

import { useEffect } from "react";
import { ACTIVE_NETWORK_KEY, LOCAL_NETWORK_ENABLED, networkSwitchHref, type D17NetworkKey } from "@/lib/d17Network";

const OPTIONS: { key: D17NetworkKey; label: string }[] = [
  { key: "sepolia", label: "Testnet" },
  { key: "mainnet", label: "Mainnet" },
  ...(LOCAL_NETWORK_ENABLED ? [{ key: "local" as const, label: "Local" }] : []),
];

export function NetworkSwitch({ disabled = false }: { disabled?: boolean }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("network") === ACTIVE_NETWORK_KEY) return;
    url.searchParams.set("network", ACTIVE_NETWORK_KEY);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  return (
    <nav className="inline-flex border border-hairline" aria-label="D17 network">
      {OPTIONS.map((option) => {
        const active = option.key === ACTIVE_NETWORK_KEY;
        const className = `px-2 py-1 font-mono text-[9px] uppercase tracking-[0.02em] transition-colors ${
          active ? "bg-ink text-paper" : "text-quiet hover:text-ink"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`;
        if (disabled) {
          return (
            <span key={option.key} aria-current={active ? "page" : undefined} aria-disabled="true" className={className}>
              {option.label}
            </span>
          );
        }
        if (active) {
          return (
            <span key={option.key} aria-current="page" className={className}>
              {option.label}
            </span>
          );
        }
        return (
          <a
            key={option.key}
            href={networkSwitchHref(option.key)}
            aria-current={active ? "page" : undefined}
            className={className}
          >
            {option.label}
          </a>
        );
      })}
    </nav>
  );
}
