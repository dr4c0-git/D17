"use client";

import dynamic from "next/dynamic";

const LaunchTerminal = dynamic(() => import("../terminal-client"), {
  ssr: false,
  loading: () => <main className="min-h-dvh bg-paper" aria-label="Loading D17 launch terminal" />,
});

export default function Page() {
  return <LaunchTerminal />;
}

