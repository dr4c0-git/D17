import { ACTIVE_NETWORK } from "@/lib/d17Network";

/**
 * D17 read client - direct RPC by default, optional HTTP + WebSocket API.
 *
 * API mode reads indexed display data from a compatible API. RPC mode reads
 * directly from the configured endpoint. Wallet writes always go through the
 * connected browser wallet.
 *
 * Everything here is read-only and safe to call from the browser.
 */

export type DataMode = "api" | "rpc";

/** API reads are opt-in. The public application defaults to direct RPC reads. */
export function dataMode(): DataMode {
  return process.env.NEXT_PUBLIC_D17_DATA_MODE === "api" ? "api" : "rpc";
}

/** Trailing slash trimmed so `${apiBase()}/api/...` never doubles up. */
export function apiBase(): string {
  return ACTIVE_NETWORK.apiBase.replace(/\/+$/, "");
}

export function wsUrl(): string {
  const explicit = ACTIVE_NETWORK.wsUrl;
  if (explicit) return explicit;
  const base = apiBase();
  if (!base) return "";
  return `${base.replace(/^http/, "ws")}/api/ws`;
}

export const CHAIN_ID = ACTIVE_NETWORK.chainId;

// ── Chain identity (env-driven: one codebase serves testnet AND mainnet
//    builds - no chain literals in page code) ──────────────────────────

export const IS_MAINNET = ACTIVE_NETWORK.key === "mainnet";
/** Human chain name; error messages and dialog copy derive from this. */
export const CHAIN_NAME = ACTIVE_NETWORK.chainName;
/** Header/status label - mainnet stands alone, testnets carry the suffix. */
export const NETWORK_LABEL = ACTIVE_NETWORK.networkLabel;

export const EXPLORER_BASE = ACTIVE_NETWORK.explorerBase;

/** full = participant + deploy; the other modes produce a single-purpose site. */
export type SiteMode = "full" | "participant" | "deploy";
export const SITE_MODE: SiteMode =
  process.env.NEXT_PUBLIC_SITE_MODE === "participant" || process.env.NEXT_PUBLIC_SITE_MODE === "deploy"
    ? process.env.NEXT_PUBLIC_SITE_MODE
    : "full";

/** Deploy-page kill switch. */
export const DEPLOY_ENABLED = process.env.NEXT_PUBLIC_ENABLE_DEPLOY !== "false";

/** User-supplied read RPC. API mode uses it only for deploy simulation; RPC
 * mode uses it for display reads as well. */
export const READ_RPC_URL = ACTIVE_NETWORK.rpcUrl;

export const READ_WS_URL = ACTIVE_NETWORK.rpcWsUrl;

// ── Envelope ──────────────────────────────────────────────────────────

export type Meta = {
  chainId: number;
  latestBlock?: number;
  indexedToBlock?: number;
  stale: boolean;
  generatedAt: string;
};

export type Envelope<T> = {
  ok: boolean;
  data: T;
  error?: { code: string; message: string };
  meta: Meta;
};

/** Result carries meta alongside data so callers can surface `stale`. */
export type ApiResult<T> = { data: T; meta: Meta };

export class ApiHttpError extends Error {
  constructor(public readonly status: number, public readonly path: string) {
    super(`API ${status} for ${path}`);
    this.name = "ApiHttpError";
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<ApiResult<T>> {
  const base = apiBase();
  if (!base) throw new Error(`No API base is configured for ${CHAIN_NAME}`);
  const response = await fetch(`${base}${path}`, { signal, headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new ApiHttpError(response.status, path);
  }
  const body = (await response.json()) as Envelope<T>;
  if (!body.ok) {
    throw new Error(body.error?.message || `API returned ok=false for ${path}`);
  }
  if (!body.meta || Number(body.meta.chainId) !== CHAIN_ID) {
    throw new Error(`API chain mismatch for ${path}: expected ${CHAIN_ID}, received ${body.meta?.chainId ?? "none"}`);
  }
  return { data: body.data, meta: body.meta };
}

// ── Response types (only fields the frontend consumes) ─────────────────

export type HealthSummary = {
  chainId: number;
  startBlock: number;
  latestBlock: number;
  indexedToBlock: number;
  watchedAddresses: number;
  launches: number;
  lockers: number;
  events: number;
};

export type Health = {
  status: string;
  summary: HealthSummary;
  ws: boolean;
  wsStatus?: { configured: boolean; live: boolean; fallbackPolling: boolean; sourceMode: string };
  storage?: { mode: string; writable?: boolean };
};

export type LaunchLink = { linkType: string; url: string };

export type LaunchMetadata = {
  launchId?: string;
  launchIdString?: string;
  verified: boolean;
  tokenName?: string;
  tokenSymbol?: string;
  description?: string;
  logoSvgUri?: string;
  links?: LaunchLink[];
  logo?: { svgUrl?: string; svgBytes?: number; dataUriBytes?: number };
};

export type ApiPhase = {
  kind: number;
  label: string;
  roundIndex: number;
  /** [kind, roundIndex, startsAt, endsAt] as strings. */
  raw: string[];
  refreshQueued?: boolean;
};

export type ApiActivityItem = {
  id: string;
  eventName: string;
  sourceKind?: string;
  address?: string;
  locker?: string | null;
  owner?: string | null;
  roundIndex?: string | null;
  amountWeth?: string | null;
  amountToken?: string | null;
  amountNative?: string | null;
  penaltyWeth?: string | null;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp?: number;
  args?: Record<string, unknown>;
};

// The API exposes more launch and locker fields than this client renders.
// Call sites validate and bind the fields they consume.
export type ApiLaunch = Record<string, unknown> & { launch?: string; address?: string };
export type ApiLocker = Record<string, unknown> & { locker?: string };

// ── Fetchers ──────────────────────────────────────────────────────────

export const getHealth = (signal?: AbortSignal) => getJson<Health>("/api/health", signal);
export const getLaunches = (signal?: AbortSignal) =>
  getJson<{ launches?: ApiLaunch[] } | ApiLaunch[]>("/api/launches", signal);
export const getLaunch = (launch: string, signal?: AbortSignal) =>
  getJson<ApiLaunch>(`/api/launches/${launch}`, signal);
export const getLaunchMetadata = (launch: string, signal?: AbortSignal) =>
  getJson<LaunchMetadata>(`/api/launches/${launch}/metadata`, signal);
export const getPhase = (launch: string, signal?: AbortSignal) =>
  getJson<ApiPhase>(`/api/launches/${launch}/phase`, signal);

/** ETH/USD reference (Chainlink mainnet, read once/min by the backend - the
 *  browser never touches an oracle or RPC). `price` is an exact decimal
 *  string; USD is display-only, so we only ever multiply it for display. */
export type EthUsd = {
  pair?: string;
  price?: string;
  decimals?: number;
  source?: string;
  referenceNetwork?: string;
  stale?: boolean;
  observedAt?: number;
};
/** PriceProvider boundary. USD display is optional and explicit:
 *  - api mode defaults to the indexed API's /api/prices/eth-usd;
 *  - rpc mode has NO default - it stays off unless the deployment configures
 *    a standalone price endpoint (same envelope), keeping direct-RPC display
 *    free of any D17 indexed-API call.
 *  An explicitly configured per-network priceUrl always wins. */
export const PRICE_URL: string =
  ACTIVE_NETWORK.priceUrl || (dataMode() === "api" && apiBase() ? `${apiBase()}/api/prices/eth-usd` : "");

export const getEthUsd = async (signal?: AbortSignal): Promise<ApiResult<EthUsd>> => {
  if (!PRICE_URL) throw new Error("No price provider configured");
  const response = await fetch(PRICE_URL, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Price provider ${response.status}`);
  const body = (await response.json()) as Envelope<EthUsd>;
  if (!body.ok) throw new Error(body.error?.message || "Price provider returned ok=false");
  return { data: body.data, meta: body.meta };
};

/** The deployed contract suite (factories) - available before any launch
 *  exists, so the participant "Contracts" panel can show them on a fresh
 *  network. Wallet/RPC never reads these; they come from the indexed API. */
export type DeployerContracts = {
  d17Factory?: string;
  tokenFactory?: string;
  launchFactory?: string;
  liquidityVaultFactory?: string;
  lockerFactory?: string;
};
export const getDeployerSchema = (signal?: AbortSignal) =>
  getJson<{ contracts?: DeployerContracts }>("/api/deployer/schema", signal);

export function getActivity(
  launch: string,
  opts: { limit?: number; cursor?: string; locker?: string } = {},
  signal?: AbortSignal
) {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.locker) params.set("locker", opts.locker);
  const qs = params.toString();
  return getJson<{ items?: ApiActivityItem[]; nextCursor?: string | null } | ApiActivityItem[]>(
    `/api/launches/${launch}/activity${qs ? `?${qs}` : ""}`,
    signal
  );
}

export const getLockers = (launch: string, signal?: AbortSignal) =>
  getJson<{ lockers?: ApiLocker[] } | ApiLocker[]>(`/api/launches/${launch}/lockers`, signal);
export const getLocker = (launch: string, locker: string, signal?: AbortSignal) =>
  getJson<{ locker?: ApiLocker; activity?: ApiActivityItem[] }>(
    `/api/launches/${launch}/lockers/${locker}`,
    signal
  );

/** Normalize the two shapes the list endpoints may return (array vs {items}). */
export function unwrapList<T>(data: { items?: T[]; launches?: T[]; lockers?: T[] } | T[]): T[] {
  if (Array.isArray(data)) return data;
  return data.items ?? data.launches ?? data.lockers ?? [];
}

// ── WebSocket ─────────────────────────────────────────────────────────

export type WsMessage =
  | { type: "snapshot"; data: unknown; meta?: Meta }
  | { type: "activity"; data: { event: ApiActivityItem | { eventName: string }; meta?: Meta } }
  | { type: string; data?: unknown; meta?: Meta };

export type WsHandlers = {
  onSnapshot?: (data: unknown, meta?: Meta) => void;
  onActivity?: (data: { event: ApiActivityItem | { eventName: string }; meta?: Meta }) => void;
  onMessage?: (message: WsMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

/**
 * Subscribe to the backend WebSocket with exponential backoff reconnect.
 * Returns a cleanup function. Handlers survive reconnects. Pass a `launch`
 * to scope the stream to one launch, or omit for all launches.
 *
 * WS is the realtime notification path. Clients re-fetch REST state after a
 * reconnect because the socket is not a durable replay log.
 */
export function subscribeWs(launch: string | null, handlers: WsHandlers): () => void {
  const base = wsUrl();
  if (!base || typeof WebSocket === "undefined") return () => {};
  const url = launch ? `${base}?launch=${launch}` : base;

  let socket: WebSocket | null = null;
  let closedByCaller = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    socket = new WebSocket(url);
    socket.onopen = () => {
      attempt = 0;
      handlers.onOpen?.();
    };
    socket.onmessage = (event) => {
      let message: WsMessage;
      try {
        message = JSON.parse(event.data as string) as WsMessage;
      } catch {
        return;
      }
      const messageMeta = (message as { meta?: Meta }).meta
        ?? (message.type === "activity" ? (message.data as { meta?: Meta })?.meta : undefined);
      if (messageMeta && Number(messageMeta.chainId) !== CHAIN_ID) {
        closedByCaller = true;
        // Browser clients may only send 1000 or application codes 3000-4999.
        // The server can use 1008 when rejecting a client; the browser uses a
        // private code so a wrong-chain stream closes cleanly and stays closed.
        socket?.close(4001, "D17 chain mismatch");
        return;
      }
      handlers.onMessage?.(message);
      if (message.type === "snapshot") handlers.onSnapshot?.(message.data, message.meta);
      else if (message.type === "activity")
        handlers.onActivity?.(message.data as { event: ApiActivityItem; meta?: Meta });
    };
    socket.onclose = () => {
      handlers.onClose?.();
      if (closedByCaller) return;
      // Backoff: 1s, 2s, 4s … capped at 15s.
      const delay = Math.min(15000, 1000 * 2 ** attempt);
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
    socket.onerror = () => {
      socket?.close();
    };
  };

  connect();

  return () => {
    closedByCaller = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
