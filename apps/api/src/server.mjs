import { createServer } from "node:http";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { WebSocketServer } from "ws";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = backendRoot;
const dotenvFile = process.env.LOAD_DOTENV === "0"
  ? ""
  : process.env.DOTENV_FILE
    ? resolvePath(process.env.DOTENV_FILE, backendRoot)
    : path.join(backendRoot, ".env");
if (dotenvFile) loadDotEnv(dotenvFile);

const PORT = envInteger("PORT", 8787, 1, 65_535);
const HOST = process.env.HOST || "127.0.0.1";
const CHAIN_ID = envInteger("CHAIN_ID", 11155111, 1);
const WS_URL = process.env.WS_URL || "";
const INDEX_SOURCE_MODE = process.env.INDEX_SOURCE_MODE || (WS_URL ? "ws-logs" : "http-poll");
const INDEX_DISABLED = process.env.INDEX_DISABLED === "1" || process.env.DISABLE_INDEXER === "1";
// Chain websocket messages are notifications, never finality evidence. Logs
// are always reread through the confirmed HTTP range before they reach state.
const WS_RPC_FALLBACK_ENABLED = process.env.WS_RPC_FALLBACK_ENABLED !== "0";
const RPC_URL = INDEX_DISABLED ? (process.env.RPC_URL || "") : required("RPC_URL");
const CONFIRMATIONS = envInteger("CONFIRMATIONS", 2, 0, 256);
const LOG_CHUNK_SIZE = envInteger("LOG_CHUNK_SIZE", 1500, 1, 50_000);
const STATE_FILE = process.env.STATE_FILE ? resolveMaybe(process.env.STATE_FILE) : path.join(backendRoot, "data/state.json");
const LOGO_DIR = process.env.LOGO_DIR ? resolveMaybe(process.env.LOGO_DIR) : path.join(backendRoot, "data/logos");
const STATE_RELOAD_ON_REQUEST = process.env.STATE_RELOAD_ON_REQUEST === "1" || INDEX_DISABLED;
const INDEX_POLL_MS = envInteger("INDEX_POLL_MS", 12_000, 250);
const RPC_CALL_TIMEOUT_MS = envInteger("RPC_CALL_TIMEOUT_MS", 8_000, 250);
const RPC_RETRY_ATTEMPTS = envInteger("RPC_RETRY_ATTEMPTS", 3, 1, 20);
const WS_GAP_BACKFILL_BLOCKS = envInteger("WS_GAP_BACKFILL_BLOCKS", 25, 1, 10_000);
const WS_SAFETY_BACKFILL_MS = envInteger("WS_SAFETY_BACKFILL_MS", 120_000, 0);
const REORG_LOOKBACK_BLOCKS = envInteger("REORG_LOOKBACK_BLOCKS", 24, 1, 10_000);
const REFRESH_SNAPSHOTS_ON_INDEX = process.env.REFRESH_SNAPSHOTS_ON_INDEX === "1";
const RPC_PROVIDER_NAME = process.env.RPC_PROVIDER_NAME || "unknown";
const RPC_MAX_REQUESTS_PER_SECOND = Number(process.env.RPC_MAX_REQUESTS_PER_SECOND || 0);
const RPC_DAILY_REQUEST_LIMIT = Number(process.env.RPC_DAILY_REQUEST_LIMIT || 0);
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ALLOW_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const HTTP_RATE_LIMIT_WINDOW_MS = Math.max(1_000, Number(process.env.HTTP_RATE_LIMIT_WINDOW_MS || 60_000));
const HTTP_RATE_LIMIT_MAX = Math.max(0, Number(process.env.HTTP_RATE_LIMIT_MAX || 240));
const HTTP_RATE_LIMIT_CLEANUP_MS = Math.max(HTTP_RATE_LIMIT_WINDOW_MS, Number(process.env.HTTP_RATE_LIMIT_CLEANUP_MS || 60_000));
const MAX_SSE_CLIENTS = Math.max(0, Number(process.env.MAX_SSE_CLIENTS || 100));
const MAX_WS_CLIENTS = Math.max(0, Number(process.env.MAX_WS_CLIENTS || 100));
const WS_MAX_PAYLOAD_BYTES = Math.max(256, Number(process.env.WS_MAX_PAYLOAD_BYTES || 1024));
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === "1";
const HEALTH_VERBOSE = process.env.HEALTH_VERBOSE === "1";
const MAX_LOGO_SVG_BYTES = Math.max(1_024, Number(process.env.MAX_LOGO_SVG_BYTES || 64_000));
const USD_PRICING_ENABLED = process.env.USD_PRICING_ENABLED === "1";
const USD_PRICE_SERVICE_URL = String(process.env.USD_PRICE_SERVICE_URL || "").replace(/\/+$/, "");
const USD_PRICE_RPC_URL = String(process.env.USD_PRICE_RPC_URL || (CHAIN_ID === 1 ? RPC_URL : ""));
const USD_PRICE_SERVICE_TIMEOUT_MS = Math.max(500, Number(process.env.USD_PRICE_SERVICE_TIMEOUT_MS || 3_000));
const USD_PRICE_CACHE_MS = Math.max(10_000, Number(process.env.USD_PRICE_CACHE_MS || 60_000));
const USD_PRICE_STALE_SECONDS = Math.max(60, Number(process.env.USD_PRICE_STALE_SECONDS || 3_600));
const ETH_USD_FEED_ADDRESS = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const ETH_USD_FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)"
];
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};
const SVG_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"
};
const ROUND_COUNT = 5;
const REFUND_STAGE_COUNT = 4;
const FINAL_ROUND = ROUND_COUNT - 1;
const NO_ROUND = 255;
const BPS = 10_000n;
const WAD = 1_000_000_000_000_000_000n;
const MAX_UINT256_STRING = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const PHASE_LABELS = ["not-started", "round", "refund", "ready-to-finalize", "settlement-open", "pool-ready", "trading-open", "failed"];
const DEFAULT_SILENT_REALTIME_EVENTS = "Swap,Sync,Transfer,Approval";
const SILENT_REALTIME_EVENTS = new Set((process.env.SILENT_REALTIME_EVENTS || DEFAULT_SILENT_REALTIME_EVENTS)
  .split(",")
  .map((eventName) => eventName.trim())
  .filter(Boolean));
const DEFAULT_EXCLUDED_INGEST_EVENTS = "Swap,Sync,Transfer,Approval";
const EXCLUDED_INGEST_EVENT_NAMES = new Set((process.env.EXCLUDED_INGEST_EVENTS || DEFAULT_EXCLUDED_INGEST_EVENTS)
  .split(",")
  .map((eventName) => eventName.trim())
  .filter(Boolean));
const ALLOW_NOISY_API_EVENTS = process.env.ALLOW_NOISY_API_EVENTS === "1";
const WATCH_PAIR_EVENTS = process.env.WATCH_PAIR_EVENTS === "1";
const MIRRORED_EVENT_FAMILIES = new Map([
  ["RoundCommitted", "RoundCommitted"],
  ["RoundRefunded", "RoundRefunded"],
  ["VaultSettlementClaimed", "VaultSettlementClaimed"],
  ["LateVaultSettlementClaimed", "VaultSettlementClaimed"],
  ["VaultSettlementCompleted", "VaultSettlementClaimed"],
  ["LaunchFailedRefunded", "LaunchFailedRefunded"],
  ["FailedLaunchRefunded", "LaunchFailedRefunded"],
  ["OfficialPoolCreated", "OfficialPoolCreated"],
  ["LiquidityPoolCreated", "OfficialPoolCreated"]
]);
const GENERIC_TOKEN_AMOUNT_EVENT_NAMES = new Set([
  "ClaimedTokensWithdrawn",
  "ManualDistributionConfigured",
  "UnsoldSaleTokensBurned",
  "UnsoldSaleTokensPaid",
  "UnsupportedTokenRecovered"
]);
const GENERIC_WETH_AMOUNT_EVENT_NAMES = new Set([
  "ExcessWethRecovered",
  "ExcessWethSwept",
  "RoundCommitted",
  "WethWithdrawn"
]);
const GENERIC_NATIVE_AMOUNT_EVENT_NAMES = new Set([
  "NativeEthRecovered",
  "UnexpectedEthSwept"
]);
const LOCKER_BALANCE_REFRESH_MS = Number(process.env.LOCKER_BALANCE_REFRESH_MS || 30_000);
const LOCKER_BALANCE_REFRESH_CONCURRENCY = Number(process.env.LOCKER_BALANCE_REFRESH_CONCURRENCY || 4);
const LAUNCH_SNAPSHOT_REFRESH_MS = Number(process.env.LAUNCH_SNAPSHOT_REFRESH_MS || 15_000);
const REFRESH_SNAPSHOTS_ON_REQUEST = process.env.REFRESH_SNAPSHOTS_ON_REQUEST === "1";
const REFRESH_LOCKER_BALANCES_ON_REQUEST = process.env.REFRESH_LOCKER_BALANCES_ON_REQUEST === "1";

// This exact string is the immutable identity of the deployed contract family.
const CURRENT_LAUNCH_ID = ethers.keccak256(ethers.toUtf8Bytes("D17_LAUNCH_V15_HARDENED"));

const ABI_DIR = path.join(root, "abi");
const ABI = {
  d17Factory: readAbi("D17Factory.abi.json"),
  tokenFactory: readAbi("D17TokenFactory.abi.json"),
  launchFactory: readAbi("D17LaunchFactory.abi.json"),
  vaultFactory: readAbi("D17LiquidityVaultFactory.abi.json"),
  lockerFactory: readAbi("D17LockerFactory.abi.json"),
  launch: readAbi("D17Launch.abi.json"),
  token: readAbi("D17Token.abi.json"),
  locker: readAbi("D17Locker.abi.json"),
  vault: readAbi("D17LiquidityVault.abi.json"),
  pair: [
    "event Mint(address indexed sender,uint256 amount0,uint256 amount1)",
    "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
    "event Sync(uint112 reserve0,uint112 reserve1)",
    "event Transfer(address indexed from,address indexed to,uint256 value)",
    "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function totalSupply() view returns (uint256)"
  ]
};

const ifaceByKind = Object.fromEntries(Object.entries(ABI).map(([kind, abi]) => [kind, new ethers.Interface(abi)]));
const INGEST_TOPIC0S = allowedIngestTopic0s();
const provider = RPC_URL ? new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {
  batchMaxCount: Number(process.env.RPC_BATCH_MAX_COUNT || 1)
}) : null;
let wsProvider = null;
let wsLive = false;
let indexing = false;
let pollTimer = null;
let wsReconnectTimer = null;
let wsSafetyTimer = null;
let wsLogFilter = null;
let wsLogListener = null;
let wsHeadListener = null;
let wsSubscriptionKey = "";
let shuttingDown = false;
let rpcThrottleQueue = Promise.resolve();
let rpcNextRequestAt = 0;
let usdPriceProvider = null;
let usdPriceCache = null;
let usdPricePromise = null;
const clients = new Set();
const wsClients = new Set();
const launchHydrationPromises = new Map();
const lockerBalanceHydrationPromises = new Map();
let state = loadState();
let stateLoadedMtimeMs = stateMtimeMs();
const runtimeStats = {
  startedAt: new Date().toISOString(),
  sourceMode: INDEX_SOURCE_MODE,
  provider: RPC_PROVIDER_NAME,
  httpRequests: 0,
  httpByMethod: {},
  wsHeads: 0,
  wsLogs: 0,
  backfills: 0,
  retryCount: 0,
  lastBackfillAt: null,
  lastWsHeadAt: null,
  lastWsLogAt: null,
  lastHeadAt: null,
  lastError: null
};
const rateLimitBuckets = new Map();
const rateLimitCleanupTimer = setInterval(cleanupRateLimitBuckets, HTTP_RATE_LIMIT_CLEANUP_MS);
rateLimitCleanupTimer.unref?.();

process.on("unhandledRejection", (error) => {
  console.error(`Unhandled background error: ${humanError(error)}`);
  if (!INDEX_DISABLED) startRpcPoller("unhandled-rejection");
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

bootstrapConfiguredAddresses();
assertConfiguredState();
if (!INDEX_DISABLED) await assertNetwork();
if (process.env.INDEX_ONCE === "1") {
  if (INDEX_DISABLED) {
    console.log("INDEX_ONCE ignored because INDEX_DISABLED=1.");
    console.log(summary());
    process.exit(0);
  }
  await indexToSafeHead("boot");
  saveState();
  console.log(summary());
  provider?.destroy?.();
  process.exit(0);
}

startServer();
if (INDEX_DISABLED) {
  console.log(`Indexer disabled; serving external state from ${STATE_FILE}.`);
} else {
  startLiveListener();
  indexToSafeHead("boot").catch((error) => {
    console.error(`Boot catch-up failed: ${humanError(error)}`);
    startRpcPoller("boot-catch-up-error");
  });
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      sendInternalError(req, res, error);
    }
  });
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
  wsServer.on("connection", (socket, req) => {
    const url = requestUrl(req, "/api/ws");
    if (!url) {
      socket.close(1008, "Malformed request URL");
      return;
    }
    const launchParam = url.searchParams.get("launch");
    const launch = optionalAddress(launchParam);
    if (launchParam && !launch) {
      socket.close(1008, "Invalid launch address");
      return;
    }
    const includeNoisyEvents = truthyParam(url.searchParams.get("includeNoisyEvents") || url.searchParams.get("includeMarketEvents"));
    const client = { socket, launch, includeNoisyEvents, alive: true };
    wsClients.add(client);
    socket.on("pong", () => {
      client.alive = true;
    });
    const cleanup = once(() => {
      wsClients.delete(client);
    });
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("message", () => socket.close(1003, "Client messages are not supported"));
    socket.send(JSON.stringify({
      type: "snapshot",
      data: { summary: summaryObject(), launch },
      meta: meta()
    }));
  });
  const pingTimer = setInterval(() => {
    for (const client of wsClients) {
      if (!client.alive) {
        wsClients.delete(client);
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, 25_000);
  pingTimer.unref?.();
  server.on("upgrade", (req, socket, head) => {
    const url = requestUrl(req, "/");
    if (!url) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }
    if (!originAllowed(req.headers.origin || "")) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const limited = rateLimitRequest(req);
    if (limited) {
      rejectUpgrade(socket, 429, "Too Many Requests", { "Retry-After": String(limited.retryAfterSeconds) });
      return;
    }
    if (MAX_WS_CLIENTS > 0 && wsClients.size >= MAX_WS_CLIENTS) {
      rejectUpgrade(socket, 503, "Service Unavailable", { "Retry-After": "30" });
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (websocket) => {
      wsServer.emit("connection", websocket, req);
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`D17 backend listening on http://${HOST}:${PORT}`);
    console.log(summary());
  });
}

function startLiveListener() {
  if (INDEX_SOURCE_MODE === "http-poll" || !WS_URL) {
    console.log(`${!WS_URL ? "WS_URL not set" : "INDEX_SOURCE_MODE=http-poll"}; using RPC catch-up polling.`);
    startRpcPoller("no-ws-url");
    return;
  }
  wsLive = false;
  wsSubscriptionKey = "";
  wsLogFilter = null;
  wsLogListener = null;
  if (wsProvider) {
    try {
      wsProvider.destroy?.();
    } catch {
      // Best-effort cleanup before reconnecting.
    }
  }
  wsProvider = new ethers.WebSocketProvider(WS_URL, CHAIN_ID);
  wsHeadListener = async (blockNumber) => {
    wsLive = true;
    stopRpcPoller("websocket restored");
    runtimeStats.wsHeads += 1;
    runtimeStats.lastWsHeadAt = new Date().toISOString();
    runtimeStats.lastHeadAt = runtimeStats.lastWsHeadAt;
    runtimeStats.lastError = null;
    state.latestBlock = Math.max(state.latestBlock || 0, Number(blockNumber));
    saveState();
    indexToSafeHead("ws-head").catch((error) => {
        console.error(`WS head catch-up failed: ${humanError(error)}`);
        runtimeStats.lastError = humanError(error);
        startRpcPoller("ws-head-error");
    });
  };
  wsProvider.on("block", wsHeadListener);
  refreshWsLogSubscription("ws-start");
  startWsSafetyBackfill();
  wsProvider.on("error", (error) => {
    handleWsFailure("ws-provider-error", `Chain websocket provider error: ${humanError(error)}`);
  });
  wsProvider.websocket?.addEventListener?.("error", (error) => {
    handleWsFailure("ws-error", `Chain websocket error: ${humanError(error)}`);
  });
  wsProvider.websocket?.addEventListener?.("close", () => {
    handleWsFailure("ws-close", WS_RPC_FALLBACK_ENABLED
      ? "Chain websocket closed; falling back to RPC catch-up polling."
      : "Chain websocket closed; RPC polling fallback is disabled.");
  });
}

function handleWsFailure(reason, message) {
  console.error(message);
  wsLive = false;
  wsSubscriptionKey = "";
  wsLogFilter = null;
  wsLogListener = null;
  if (WS_RPC_FALLBACK_ENABLED) startRpcPoller(reason);
  scheduleWsReconnect(reason);
}

function stopRpcPoller(reason) {
  if (!pollTimer || INDEX_SOURCE_MODE === "http-poll") return;
  clearInterval(pollTimer);
  pollTimer = null;
  console.log(`Stopped RPC fallback poller (${reason}).`);
}

function scheduleWsReconnect(reason) {
  if (!WS_URL || shuttingDown || wsReconnectTimer) return;
  const delayMs = Number(process.env.WS_RECONNECT_MS || 60_000);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    if (shuttingDown) return;
    console.log(`Retrying chain websocket connection after ${reason}.`);
    startLiveListener();
  }, delayMs);
  wsReconnectTimer.unref?.();
}

function startRpcPoller(reason) {
  const explicitHttpPolling = INDEX_SOURCE_MODE === "http-poll";
  if ((!explicitHttpPolling && !WS_RPC_FALLBACK_ENABLED) || !Number.isFinite(INDEX_POLL_MS) || INDEX_POLL_MS <= 0) {
    const message = `RPC catch-up poller refused (${reason}); sourceMode=${INDEX_SOURCE_MODE}, fallbackEnabled=${WS_RPC_FALLBACK_ENABLED}, intervalMs=${INDEX_POLL_MS}.`;
    runtimeStats.lastError = message;
    console.error(message);
    return;
  }
  if (pollTimer) return;
  console.log(`Starting RPC catch-up poller (${reason}) every ${INDEX_POLL_MS}ms.`);
  pollTimer = setInterval(() => {
    indexToSafeHead("rpc-poll").catch((error) => {
      console.error(`RPC poll failed: ${humanError(error)}`);
    });
  }, INDEX_POLL_MS);
  pollTimer.unref?.();
}

function startWsSafetyBackfill() {
  if (wsSafetyTimer || WS_SAFETY_BACKFILL_MS <= 0) return;
  wsSafetyTimer = setInterval(() => {
    if (!wsLive) return;
    indexToSafeHead("ws-safety-backfill").catch((error) => {
      console.error(`WS safety backfill failed: ${humanError(error)}`);
      runtimeStats.lastError = humanError(error);
    });
  }, WS_SAFETY_BACKFILL_MS);
  wsSafetyTimer.unref?.();
}

function refreshWsLogSubscription(reason) {
  if (!wsProvider || !WS_URL || INDEX_SOURCE_MODE === "http-poll") return;
  const addresses = watchAddresses().sort();
  const key = `${addresses.join(",")}|${INGEST_TOPIC0S.join(",")}`;
  if (!addresses.length || key === wsSubscriptionKey) return;
  if (wsLogFilter && wsLogListener) {
    try {
      wsProvider.off(wsLogFilter, wsLogListener);
    } catch {
      // Provider cleanup is best effort across reconnects.
    }
  }
  wsSubscriptionKey = key;
  wsLogFilter = ingestLogFilter({ address: addresses });
  wsLogListener = async (log) => {
    wsLive = true;
    stopRpcPoller("websocket log restored");
    runtimeStats.wsLogs += 1;
    runtimeStats.lastWsLogAt = new Date().toISOString();
    runtimeStats.lastHeadAt = runtimeStats.lastWsLogAt;
    state.latestBlock = Math.max(state.latestBlock || 0, Number(log.blockNumber || 0));
    await indexToSafeHead("ws-log-notice").catch((error) => {
      console.error(`WS-confirmed catch-up failed: ${humanError(error)}`);
      runtimeStats.lastError = humanError(error);
    });
    saveState();
  };
  wsProvider.on(wsLogFilter, wsLogListener);
  console.log(`Subscribed to ${addresses.length} watched address(es), ${INGEST_TOPIC0S.length} event topic(s), over WSS logs (${reason}).`);
}

async function handleRequest(req, res) {
  const url = requestUrl(req, "/");
  if (!url) return sendJson(req, res, 400, { ok: false, error: "Malformed request URL" });
  if (!originAllowed(req.headers.origin || "")) {
    return sendJson(req, res, 403, { ok: false, error: "Origin not allowed" });
  }
  if (req.method === "OPTIONS") return sendOptions(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return sendJson(req, res, 405, { ok: false, error: "Method not allowed" });
  }
  const limited = rateLimitRequest(req);
  if (limited) return sendRateLimited(req, res, limited);
  maybeReloadState();
  if (url.pathname === "/api/stream") return handleStream(req, url, res);
  const logoMatch = /^\/api\/assets\/logos\/(0x[a-fA-F0-9]{40})\.svg$/.exec(url.pathname);
  if (logoMatch) return sendLogoSvg(req, res, ethers.getAddress(logoMatch[1]));
  if (url.pathname === "/api/health") return sendData(req, res, {
    status: healthReady() ? "ok" : "degraded",
    summary: summaryObject(),
    ws: wsLive,
    wsStatus: {
      configured: Boolean(WS_URL),
      live: wsLive,
      fallbackPolling: Boolean(pollTimer),
      reconnectScheduled: Boolean(wsReconnectTimer),
      sourceMode: INDEX_SOURCE_MODE,
      indexDisabled: INDEX_DISABLED,
      trustedHeads: false,
      rpcFallbackEnabled: WS_RPC_FALLBACK_ENABLED,
      logSubscriptionAddresses: wsSubscriptionKey ? watchAddresses().length : 0,
      safetyBackfillMs: WS_SAFETY_BACKFILL_MS,
      gapBackfillBlocks: WS_GAP_BACKFILL_BLOCKS,
    },
    rpcUsage: HEALTH_VERBOSE ? rpcUsageSummary() : publicRpcUsageSummary(),
    storage: {
      mode: "json-file",
      writable: storageWritable()
    },
    ...(HEALTH_VERBOSE ? { diagnostics: { stateFile: path.basename(STATE_FILE) } } : {})
  });
  if (url.pathname === "/api/prices/eth-usd") return handleEthUsdPrice(req, res);
  if (url.pathname === "/api/deployer/schema" || url.pathname === "/api/deploy/schema") {
    return sendData(req, res, deployerSchema());
  }
  if (url.pathname === "/api/launches") {
    return sendData(req, res, Object.values(state.launches)
      .sort((a, b) => a.createdBlock - b.createdBlock)
      .map((launch) => launchDto(launch)));
  }

  const launchMatch = /^\/api\/launches\/(0x[a-fA-F0-9]{40})(?:\/([^/]+)(?:\/(0x[a-fA-F0-9]{40}))?)?$/.exec(url.pathname);
  if (!launchMatch) return sendJson(req, res, 404, { ok: false, error: "Not found" });
  const launchAddress = ethers.getAddress(launchMatch[1]);
  let launch = state.launches[launchAddress];
  if (!launch) return sendJson(req, res, 404, { ok: false, error: "Unknown launch" });
  const resource = launchMatch[2] || "";
  const addressParam = launchMatch[3] ? ethers.getAddress(launchMatch[3]) : "";
  launch = await ensureLaunchApiState(launchAddress);

  if (!resource) return sendData(req, res, launchDto(launch));
  if (resource === "metadata") return sendData(req, res, launch.metadata || null);
  if (resource === "phase") return sendData(req, res, phaseForLaunch(launch));
  if (resource === "activity") {
    const requestedLimit = Number(url.searchParams.get("limit") || 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(500, Math.max(1, Math.trunc(requestedLimit)))
      : 100;
    const cursor = url.searchParams.get("cursor") || "";
    const lockerParam = url.searchParams.get("locker") || "";
    const locker = optionalAddress(lockerParam);
    if (lockerParam && !locker) return sendJson(req, res, 400, { ok: false, error: "Invalid locker address" });
    const includeTypes = parseCsvSet(url.searchParams.get("include") || url.searchParams.get("eventTypes"));
    const excludeTypes = parseCsvSet(url.searchParams.get("exclude") || url.searchParams.get("excludeTypes"));
    return sendData(req, res, activityForLaunch(launchAddress, { limit, cursor, locker, includeTypes, excludeTypes }));
  }
  if (resource === "lockers") {
    if (addressParam) {
      if (!(state.launchLockers[launchAddress] || []).includes(addressParam)) {
        return sendJson(req, res, 404, { ok: false, error: "Locker not found for this launch" });
      }
      return sendData(req, res, lockerDto(addressParam, launchAddress));
    }
    return sendData(req, res, lockersForLaunch(launchAddress));
  }
  return sendJson(req, res, 404, { ok: false, error: "Not found" });
}

function handleStream(req, url, res) {
  if (MAX_SSE_CLIENTS > 0 && clients.size >= MAX_SSE_CLIENTS) {
    return sendJson(req, res, 503, {
      ok: false,
      error: "Stream client limit reached",
      retryAfterSeconds: 30
    });
  }
  const launchParam = url.searchParams.get("launch");
  const launch = optionalAddress(launchParam);
  if (launchParam && !launch) {
    return sendJson(req, res, 400, { ok: false, error: "Invalid launch address" });
  }
  const includeNoisyEvents = truthyParam(url.searchParams.get("includeNoisyEvents") || url.searchParams.get("includeMarketEvents"));
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(req)
  });
  res.flushHeaders?.();
  const client = { res, launch, includeNoisyEvents };
  clients.add(client);
  res.write(`: ${" ".repeat(2048)}\n\n`);
  res.write(`: connected ${new Date().toISOString()}\n\n`);
  res.write(`event: snapshot\ndata: ${JSON.stringify({ summary: summaryObject(), launch })}\n\n`);
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, 25_000);
  reqOnClose(res, () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

async function indexToSafeHead(reason) {
  if (indexing) return;
  indexing = true;
  try {
    const head = await withRetry(() => rpcGetBlock("latest"), "latest block");
    if (!head) return;
    runtimeStats.lastHeadAt = new Date().toISOString();
    state.latestBlock = Number(head.number);
    const target = Math.max(0, Number(head.number) - CONFIRMATIONS);
    const from = Math.max(Number(state.indexedToBlock || state.startBlock || target) + 1, Number(state.startBlock || 0));
    if (from > target) {
      state.updatedAt = new Date().toISOString();
      runtimeStats.lastError = null;
      saveState();
      return;
    }
    await reorgCheck(from);
    for (let start = from; start <= target; start += LOG_CHUNK_SIZE) {
      const end = Math.min(target, start + LOG_CHUNK_SIZE - 1);
      await indexRange(start, end, reason);
      state.indexedToBlock = end;
      saveState();
    }
    if (REFRESH_SNAPSHOTS_ON_INDEX) {
      refreshAllLaunchSnapshots().then(() => saveState()).catch((error) => {
        console.error(`Background launch snapshot refresh failed: ${humanError(error)}`);
      });
    }
    runtimeStats.lastError = null;
    saveState();
  } finally {
    indexing = false;
  }
}

async function reorgCheck(nextFrom) {
  const previous = state.blocks[String(nextFrom - 1)];
  if (!previous) return;
  const block = await withRetry(() => rpcGetBlock(nextFrom - 1), "reorg block");
  if (!block || block.hash === previous.hash) return;
  const rollbackTo = Math.max(Number(state.startBlock || 0), nextFrom - REORG_LOOKBACK_BLOCKS);
  state.events = state.events.filter((event) => event.blockNumber < rollbackTo);
  state.blocks = Object.fromEntries(Object.entries(state.blocks).filter(([height]) => Number(height) < rollbackTo));
  state.indexedToBlock = rollbackTo - 1;
  await rebuildDerivedState();
}

async function indexRange(fromBlock, toBlock, reason) {
  const addresses = watchAddresses();
  if (addresses.length === 0) return;
  runtimeStats.backfills += 1;
  runtimeStats.lastBackfillAt = new Date().toISOString();
  const logs = await withRetry(() => rpcGetLogs(ingestLogFilter({ address: addresses, fromBlock, toBlock })), `logs ${fromBlock}-${toBlock}`);
  const blockNumbers = [...new Set(logs.map((log) => Number(log.blockNumber)))];
  for (const blockNumber of blockNumbers) {
    const block = await withRetry(() => rpcGetBlock(blockNumber), `block ${blockNumber}`);
    if (block) state.blocks[String(blockNumber)] = {
      number: Number(block.number),
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: Number(block.timestamp)
    };
  }
  const newEvents = [];
  for (const log of logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || Number(a.index - b.index))) {
    const beforeKey = addressKey();
    const event = await ingestLog(log, reason);
    if (event) newEvents.push(event);
    if (event && addressKey() !== beforeKey) {
      await indexRange(event.blockNumber, toBlock, "address-discovery-backfill").catch((error) => {
        console.error(`Discovery block backfill failed: ${humanError(error)}`);
        runtimeStats.lastError = humanError(error);
      });
    }
  }
  refreshWsLogSubscription("backfill-address-refresh");
}

async function ingestLog(log, reason) {
  const address = ethers.getAddress(log.address);
  const kinds = state.addressKinds[address] || [];
  let parsed = null;
  let kind = "";
  for (const candidate of kinds) {
    try {
      parsed = ifaceByKind[candidate].parseLog(log);
      kind = candidate;
      break;
    } catch {
      continue;
    }
  }
  if (!parsed) return;
  if (EXCLUDED_INGEST_EVENT_NAMES.has(parsed.name)) return null;
  const block = state.blocks[String(Number(log.blockNumber))] || await withRetry(() => rpcGetBlock(log.blockNumber), `log block ${log.blockNumber}`);
  const event = {
    id: `${log.transactionHash}:${Number(log.index)}`,
    chainId: CHAIN_ID,
    sourceKind: kind,
    address,
    eventName: parsed.name,
    args: decodedArgs(parsed),
    txHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
    logIndex: Number(log.index),
    blockHash: log.blockHash || block?.hash || "",
    topic0: log.topics?.[0] || "",
    topics: Array.from(log.topics || []),
    dataHex: log.data || "0x",
    timestamp: Number(block?.timestamp || 0),
    reason
  };
  event.semanticId = eventSemanticKey(event);
  if (state.events.some((item) => item.id === event.id || eventSemanticKey(item) === event.semanticId)) return null;
  await applyEvent(event);
  state.events.push(event);
  if (!isMirroredLockerEvent(event)) broadcast(event);
  return event;
}

async function applyEvent(event) {
  const args = event.args;
  if (event.eventName === "LaunchCreated") {
    const launch = ethers.getAddress(args.launch);
    const token = ethers.getAddress(args.token);
    const liquidityVault = ethers.getAddress(args.liquidityVault);
    state.launches[launch] = {
      ...(state.launches[launch] || {}),
      launch,
      token,
      liquidityVault,
      factory: event.address,
      creator: args.creator,
      rulesHash: args.rulesHash,
      createdBlock: event.blockNumber,
      createdTx: event.txHash
    };
    addAddress(launch, "launch");
    addAddress(token, "token");
    addAddress(liquidityVault, "vault");
    await refreshLaunchSnapshot(launch).catch((error) => {
      console.warn(`Launch snapshot refresh skipped for ${launch}: ${humanError(error)}`);
    });
    await refreshMetadata(launch).catch((error) => {
      console.warn(`Metadata refresh skipped for ${launch}: ${humanError(error)}`);
    });
  }
  if (event.eventName === "LaunchMetadataPublished") {
    const launch = ethers.getAddress(args.launch);
    state.metadataEvents[launch] = {
      launch,
      metadataHash: args.metadataHash,
      description: args.description,
      logoSvgUri: args.logoSvgUri,
      linkTypes: args.linkTypes || [],
      linkUrls: args.linkUrls || [],
      blockNumber: event.blockNumber,
      txHash: event.txHash
    };
    await refreshMetadata(launch).catch((error) => {
      console.warn(`Metadata refresh skipped for ${launch}: ${humanError(error)}`);
    });
  }
  if (event.eventName === "ManualDistributionConfigured") {
    const launch = ethers.getAddress(args.launch);
    state.launches[launch] = {
      ...(state.launches[launch] || {}),
      launch,
      manualDistributionRecipient: normalizeOptionalAddress(args.recipient),
      manualDistributionTokens: decimalString(args.amount)
    };
  }
  if (event.eventName === "Finalized") {
    state.launches[event.address] = {
      ...(state.launches[event.address] || {}),
      launch: event.address,
      finalized: true,
      finalizedAt: Number(args.finalizedAt || event.timestamp || 0)
    };
  }
  if (event.eventName === "LockerCreated") {
    const owner = ethers.getAddress(args.owner);
    const locker = ethers.getAddress(args.locker);
    state.lockers[locker] = { ...(state.lockers[locker] || {}), locker, owner, createdBlock: event.blockNumber, createdTx: event.txHash };
    addAddress(locker, "locker");
  }
  if (event.eventName === "LockerRegistered") {
    const owner = ethers.getAddress(args.owner);
    const locker = ethers.getAddress(args.locker);
    state.lockers[locker] = { ...(state.lockers[locker] || {}), locker, owner, manager: args.manager, registeredBlock: event.blockNumber };
    addAddress(locker, "locker");
  }
  if (event.eventName === "RoundCommitted" || event.eventName === "RoundRefunded" || event.eventName === "VaultSettlementClaimed" || event.eventName === "LateVaultSettlementClaimed" || event.eventName === "LaunchFailedRefunded") {
    const locker = args.locker ? ethers.getAddress(args.locker) : null;
    const launch = event.sourceKind === "launch" ? event.address : args.launch ? ethers.getAddress(args.launch) : null;
    if (locker && launch) {
      const current = state.launchLockers[launch] || [];
      if (!current.includes(locker)) state.launchLockers[launch] = [...current, locker];
      state.lockers[locker] = { ...(state.lockers[locker] || {}), locker };
      addAddress(locker, "locker");
    }
  }
  if (event.eventName === "LateVaultSettlementClaimed") {
    const totals = lateEventTotals(event.address, event);
    state.launches[event.address] = {
      ...(state.launches[event.address] || {}),
      launch: event.address,
      lateSettledCommittedWeth: maxDecimalString(state.launches[event.address]?.lateSettledCommittedWeth, totals.lateSettledCommittedWeth),
      lateSettledLiquidityWeth: maxDecimalString(state.launches[event.address]?.lateSettledLiquidityWeth, totals.lateSettledLiquidityWeth),
      lateLpTokensReleased: maxDecimalString(state.launches[event.address]?.lateLpTokensReleased, totals.lateLpTokensReleased)
    };
  }
  if (event.eventName === "LiquidityPoolCreated" || event.eventName === "OfficialPoolCreated") {
    const launch = event.sourceKind === "launch" ? event.address : findLaunchByVault(event.address);
    const pair = args.pair ? ethers.getAddress(args.pair) : null;
    if (launch && pair) {
      state.launches[launch] = {
        ...(state.launches[launch] || {}),
        officialPair: pair,
        liquidityPoolCreated: true,
        tradingOpen: true,
        poolCreatedAt: event.timestamp || state.launches[launch]?.poolCreatedAt || 0,
        poolCreatedBlock: event.blockNumber,
        officialTokenUsedForLp: args.tokenUsed || state.launches[launch]?.officialTokenUsedForLp || "0",
        officialWethUsedForLp: args.wethUsed || state.launches[launch]?.officialWethUsedForLp || "0",
        officialLpMinted: args.lpMinted || state.launches[launch]?.officialLpMinted || "0",
        preseededTokenReserve: args.preseededTokenReserve || state.launches[launch]?.preseededTokenReserve || "0",
        preseededWethReserve: args.preseededWethReserve || state.launches[launch]?.preseededWethReserve || "0"
      };
      addAddress(pair, "pair");
    }
  }
  if (event.eventName === "LateLiquidityAdded") {
    const launch = findLaunchByVault(event.address);
    const pair = args.pair ? ethers.getAddress(args.pair) : state.launches[launch]?.officialPair || "";
    if (launch) {
      const totals = lateEventTotals(launch, event);
      state.launches[launch] = {
        ...(state.launches[launch] || {}),
        launch,
        officialPair: pair,
        lateTokenUsedForLp: maxDecimalString(state.launches[launch]?.lateTokenUsedForLp, totals.lateTokenUsedForLp),
        lateWethUsedForLp: maxDecimalString(state.launches[launch]?.lateWethUsedForLp, totals.lateWethUsedForLp),
        lateLpMinted: maxDecimalString(state.launches[launch]?.lateLpMinted, totals.lateLpMinted)
      };
      if (pair) addAddress(pair, "pair");
    }
  }
  if (event.eventName === "TokenMetadataConfigured") {
    const launch = findLaunchByToken(event.address);
    if (launch) await refreshMetadata(launch).catch((error) => {
      console.warn(`Token metadata refresh skipped for ${launch}: ${humanError(error)}`);
    });
  }
  if (event.eventName === "ContractURIUpdated") {
    const launch = findLaunchByToken(event.address);
    if (launch) await refreshMetadata(launch).catch((error) => {
      console.warn(`Contract URI refresh skipped for ${launch}: ${humanError(error)}`);
    });
  }
  if (provider && !isMirroredLockerEvent(event)) {
    const balanceLaunch = normalizeOptionalAddress(args.launch)
      || (event.sourceKind === "launch" ? event.address : "");
    const balanceLocker = normalizeOptionalAddress(args.locker)
      || (event.sourceKind === "locker" ? event.address : "");
    if (balanceLaunch && balanceLocker && state.launches[balanceLaunch]) {
      await refreshLockerBalance(balanceLaunch, balanceLocker, event.blockNumber).catch((error) => {
        console.warn(`Locker balance refresh skipped for ${balanceLocker}: ${humanError(error)}`);
      });
    }
  }
}

async function refreshAllLaunchSnapshots() {
  for (const launch of Object.keys(state.launches)) {
    await refreshLaunchSnapshot(launch).catch(() => null);
    await refreshMetadata(launch).catch(() => null);
  }
}

async function refreshLaunchSnapshot(launchAddress) {
  if (!provider) throw new Error("RPC provider is not configured");
  const launch = state.launches[launchAddress];
  if (!launch) return null;
  const contract = new ethers.Contract(launchAddress, ABI.launch, provider);
  const [
    launchId,
    rulesHash,
    metadataHash,
    token,
    weth,
    treasury,
    liquidityVault,
    startTime,
    refundSeconds,
    settlementSeconds,
    tradingOpenAt,
    settlementStartsAt,
    poolCreationOpensAt,
    tradingOpen,
    liquidityPoolCreated,
    allFinalCommitmentsSettled,
    finalized,
    finalizedAt,
    poolCreatedAt,
    totalCommittedWeth,
    totalLiquidityWeth,
    anchorPriceWad,
    minCommitWeth,
    minPhase1Weth,
    minAnchorPriceWad,
    treasuryBps,
    refundPenaltyBps,
    saleTokens,
    lpTokens,
    deadTokens,
    deadRecipient,
    burnUnsoldSaleTokens,
    officialPair,
    officialTokenUsedForLp,
    officialWethUsedForLp,
    officialLpMinted,
    finalCommittedWeth,
    settledCommittedWeth,
    treasuryWethPaid,
    retainedPenaltyWeth,
    penaltyWethPaid,
    unsoldSaleTokensSettled,
    vaultLiquidityClaimed,
    vaultLiquidityTokensClaimed,
    manualDistributionTokensFromContract,
    manualDistributionRecipientFromContract,
    settledLiquidityWeth,
    poolSettledCommittedWeth,
    poolSettledLiquidityWeth,
    lateSettledCommittedWeth,
    lateSettledLiquidityWeth,
    lateLpTokensReleased,
    rounds,
  ] = await runLimited([
    () => safeCall(contract, "D17_LAUNCH_ID"),
    () => withRetry(() => contract.rulesHash(), "rulesHash"),
    () => withRetry(() => contract.metadataHash(), "metadataHash"),
    () => withRetry(() => contract.token(), "token"),
    () => safeCall(contract, "weth"),
    () => withRetry(() => contract.treasury(), "treasury"),
    () => withRetry(() => contract.liquidityVault(), "liquidityVault"),
    () => withRetry(() => contract.startTime(), "startTime"),
    () => withRetry(() => contract.refundSeconds(), "refundSeconds"),
    () => withRetry(() => contract.settlementSeconds(), "settlementSeconds"),
    () => withRetry(() => contract.tradingOpenAt(), "tradingOpenAt"),
    () => withRetry(() => contract.settlementStartsAt(), "settlementStartsAt"),
    () => withRetry(() => contract.poolCreationOpensAt(), "poolCreationOpensAt"),
    () => withRetry(() => contract.tradingOpen(), "tradingOpen"),
    () => withRetry(() => contract.liquidityPoolCreated(), "liquidityPoolCreated"),
    () => withRetry(() => contract.allFinalCommitmentsSettled(), "allFinalCommitmentsSettled"),
    () => withRetry(() => contract.finalized(), "finalized"),
    () => safeCall(contract, "finalizedAt", 0n),
    () => safeCall(contract, "poolCreatedAt", 0n),
    () => withRetry(() => contract.totalCommittedWeth(), "totalCommittedWeth"),
    () => withRetry(() => contract.totalLiquidityWeth(), "totalLiquidityWeth"),
    () => withRetry(() => contract.anchorPriceWad(), "anchorPriceWad"),
    () => withRetry(() => contract.minCommitWeth(), "minCommitWeth"),
    () => withRetry(() => contract.minPhase1Weth(), "minPhase1Weth"),
    () => withRetry(() => contract.minAnchorPriceWad(), "minAnchorPriceWad"),
    () => withRetry(() => contract.treasuryBps(), "treasuryBps"),
    () => withRetry(() => contract.refundPenaltyBps(), "refundPenaltyBps"),
    () => withRetry(() => contract.saleTokens(), "saleTokens"),
    () => withRetry(() => contract.lpTokens(), "lpTokens"),
    () => withRetry(() => contract.deadTokens(), "deadTokens"),
    () => safeCall(contract, "deadRecipient"),
    // V15 has no unsold-token option: unsold sale tokens are always burned.
    () => Promise.resolve(true),
    () => safeCall(contract, "officialPair"),
    () => safeCall(contract, "officialTokenUsedForLp", 0n),
    () => safeCall(contract, "officialWethUsedForLp", 0n),
    () => safeCall(contract, "officialLpMinted", 0n),
    () => safeCall(contract, "finalCommittedWeth", 0n),
    () => safeCall(contract, "settledCommittedWeth", 0n),
    () => safeCall(contract, "treasuryWethPaid", 0n),
    () => safeCall(contract, "retainedPenaltyWeth", 0n),
    () => safeCall(contract, "penaltyWethPaid", 0n),
    () => safeCall(contract, "unsoldSaleTokensSettled", 0n),
    () => safeCall(contract, "vaultLiquidityClaimed", false),
    () => safeCall(contract, "vaultLiquidityTokensClaimed", 0n),
    () => safeCall(contract, "manualDistributionTokens", null),
    () => safeCall(contract, "manualDistributionRecipient", null),
    () => safeCall(contract, "settledLiquidityWeth", 0n),
    () => safeCall(contract, "poolSettledCommittedWeth", 0n),
    () => safeCall(contract, "poolSettledLiquidityWeth", 0n),
    () => safeCall(contract, "lateSettledCommittedWeth", 0n),
    () => safeCall(contract, "lateSettledLiquidityWeth", 0n),
    () => safeCall(contract, "lateLpTokensReleased", 0n),
    () => runLimited(Array.from({ length: ROUND_COUNT }, (_, round) => async () => {
      const [
        start,
        end,
        seconds,
        shareBps,
        baseTokenAllocation,
        tokenAllocation,
        soldTokens,
        raisedWeth,
        anchorTargetWeth,
        underfillRemainingWeth,
        discoveredPriceWad,
        claimTime,
      ] = await runLimited([
        () => withRetry(() => contract.roundStart(round), `roundStart ${round}`),
        () => withRetry(() => contract.roundEnd(round), `roundEnd ${round}`),
        () => withRetry(() => contract.roundSeconds(round), `roundSeconds ${round}`),
        () => withRetry(() => contract.roundSharesBps(round), `roundSharesBps ${round}`),
        () => withRetry(() => contract.roundBaseTokenAllocation(round), `roundBaseTokenAllocation ${round}`),
        () => withRetry(() => contract.roundTokenAllocation(round), `roundTokenAllocation ${round}`),
        () => withRetry(() => contract.roundSoldTokens(round), `roundSoldTokens ${round}`),
        () => withRetry(() => contract.roundRaised(round), `roundRaised ${round}`),
        () => withRetry(() => contract.roundAnchorTargetWeth(round), `roundAnchorTargetWeth ${round}`),
        () => withRetry(() => contract.roundAnchorUnderfillRemainingWeth(round), `roundAnchorUnderfillRemainingWeth ${round}`),
        () => withRetry(() => contract.roundDiscoveredPriceWad(round), `roundDiscoveredPriceWad ${round}`),
        () => withRetry(() => contract.roundClaimTime(round), `roundClaimTime ${round}`),
      ], 2);
      return {
        round,
        displayRound: round + 1,
        start: Number(start),
        end: Number(end),
        seconds: Number(seconds),
        shareBps: Number(shareBps),
        baseTokenAllocation: baseTokenAllocation.toString(),
        tokenAllocation: tokenAllocation.toString(),
        soldTokens: soldTokens.toString(),
        raisedWeth: raisedWeth.toString(),
        anchorTargetWeth: anchorTargetWeth.toString(),
        underfillRemainingWeth: underfillRemainingWeth.toString(),
        discoveredPriceWad: discoveredPriceWad.toString(),
        claimTime: Number(claimTime)
      };
    }), 1),
  ], 3);
  const tokenAddress = ethers.getAddress(token);
  const tokenContract = new ethers.Contract(tokenAddress, ABI.token, provider);
  const liquidityVaultAddress = ethers.getAddress(liquidityVault);
  const vaultContract = new ethers.Contract(liquidityVaultAddress, ABI.vault, provider);
  const [tokenMaxSupply, tokenTotalSupply] = await Promise.all([
    safeCall(tokenContract, "maxSupply", null),
    safeCall(tokenContract, "totalSupply", null)
  ]);
  const [lateTokenUsedForLp, lateWethUsedForLp, lateLpMinted] = await runLimited([
    () => safeCall(vaultContract, "lateTokenUsedForLp", 0n),
    () => safeCall(vaultContract, "lateWethUsedForLp", 0n),
    () => safeCall(vaultContract, "lateLpMinted", 0n)
  ], 3);
  const manualDistributionTokens = manualDistributionAmount({
    manualDistributionTokensFromContract,
    tokenMaxSupply,
    saleTokens,
    lpTokens,
    deadTokens
  });
  // V15 fields, read separately so the long positional list above stays unchanged.
  const [protocolFeeBps, protocolFeeRecipient, protocolFeeWethPaid, effectiveLpTokens, unusedLpTokensBurned] = await runLimited([
    () => safeCall(contract, "protocolFeeBps", 0n),
    () => safeCall(contract, "protocolFeeRecipient"),
    () => safeCall(contract, "protocolFeeWethPaid", 0n),
    () => safeCall(contract, "effectiveLpTokens", 0n),
    () => safeCall(contract, "unusedLpTokensBurned", 0n),
  ]);
  const finalizedFlag = Boolean(finalized);

  const updatedLaunch = {
    ...launch,
    launchId,
    rulesHash,
    metadataHash,
    token: tokenAddress,
    weth: normalizeOptionalAddress(weth),
    treasury: normalizeOptionalAddress(treasury),
    liquidityVault: liquidityVaultAddress,
    startTime: Number(startTime),
    refundSeconds: Number(refundSeconds),
    settlementSeconds: Number(settlementSeconds),
    tradingOpenAt: Number(tradingOpenAt),
    settlementStartsAt: Number(settlementStartsAt),
    poolCreationOpensAt: Number(poolCreationOpensAt),
    tradingOpen: Boolean(tradingOpen),
    liquidityPoolCreated: Boolean(liquidityPoolCreated),
    allFinalCommitmentsSettled: Boolean(allFinalCommitmentsSettled),
    finalized: Boolean(finalized),
    finalizedAt: Number(finalizedAt || 0),
    poolCreatedAt: Number(poolCreatedAt || launch.poolCreatedAt || 0),
    totalCommittedWeth: totalCommittedWeth.toString(),
    totalLiquidityWeth: totalLiquidityWeth.toString(),
    anchorPriceWad: anchorPriceWad.toString(),
    minCommitWeth: minCommitWeth.toString(),
    minPhase1Weth: minPhase1Weth.toString(),
    minAnchorPriceWad: minAnchorPriceWad.toString(),
    treasuryBps: Number(treasuryBps),
    refundPenaltyBps: Number(refundPenaltyBps),
    saleTokens: saleTokens.toString(),
    lpTokens: lpTokens.toString(),
    deadTokens: deadTokens.toString(),
    deadRecipient: normalizeOptionalAddress(deadRecipient),
    burnUnsoldSaleTokens: Boolean(burnUnsoldSaleTokens),
    manualDistributionTokens,
    manualDistributionRecipient: normalizeOptionalAddress(manualDistributionRecipientFromContract) || launch.manualDistributionRecipient || launch.creator || "",
    deployerAirdropTokens: manualDistributionTokens,
    tokenSupply: tokenMaxSupply ? tokenMaxSupply.toString() : tokenSupplyFromParts(saleTokens, lpTokens, deadTokens, manualDistributionTokens),
    tokenMaxSupply: tokenMaxSupply ? tokenMaxSupply.toString() : null,
    tokenTotalSupply: tokenTotalSupply ? tokenTotalSupply.toString() : null,
    officialPair: normalizeOptionalAddress(officialPair) || launch.officialPair || "",
    officialTokenUsedForLp: officialTokenUsedForLp.toString(),
    officialWethUsedForLp: officialWethUsedForLp.toString(),
    officialLpMinted: officialLpMinted.toString(),
    finalCommittedWeth: finalCommittedWeth.toString(),
    settledCommittedWeth: settledCommittedWeth.toString(),
    settledLiquidityWeth: settledLiquidityWeth.toString(),
    poolSettledCommittedWeth: poolSettledCommittedWeth.toString(),
    poolSettledLiquidityWeth: poolSettledLiquidityWeth.toString(),
    lateSettledCommittedWeth: lateSettledCommittedWeth.toString(),
    lateSettledLiquidityWeth: lateSettledLiquidityWeth.toString(),
    lateLpTokensReleased: lateLpTokensReleased.toString(),
    treasuryWethPaid: treasuryWethPaid.toString(),
    retainedPenaltyWeth: retainedPenaltyWeth.toString(),
    penaltyWethPaid: penaltyWethPaid.toString(),
    unsoldSaleTokensSettled: unsoldSaleTokensSettled.toString(),
    vaultLiquidityClaimed: Boolean(vaultLiquidityClaimed),
    vaultLiquidityTokensClaimed: vaultLiquidityTokensClaimed.toString(),
    lateTokenUsedForLp: lateTokenUsedForLp.toString(),
    lateWethUsedForLp: lateWethUsedForLp.toString(),
    lateLpMinted: lateLpMinted.toString(),
    reservedLpTokensRemaining: reservedLpTokens(
      finalizedFlag && effectiveLpTokens > 0n ? effectiveLpTokens : lpTokens,
      vaultLiquidityTokensClaimed,
      lateLpTokensReleased
    ),
    protocolFeeBps: Number(protocolFeeBps),
    protocolFeeRecipient: normalizeOptionalAddress(protocolFeeRecipient),
    protocolFeeWethPaid: protocolFeeWethPaid.toString(),
    effectiveLpTokens: effectiveLpTokens.toString(),
    unusedLpTokensBurned: unusedLpTokensBurned.toString(),
    creatorVestingSeconds: 180 * 24 * 60 * 60,
    rounds,
    apiSnapshotRefreshedAt: new Date().toISOString(),
  };
  updatedLaunch.config = launchConfigDto(updatedLaunch);
  updatedLaunch.tokenomics = tokenomicsDto(updatedLaunch);
  updatedLaunch.poolComposition = poolCompositionDto(updatedLaunch);
  updatedLaunch.rounds = rounds.map((round) => roundDto(updatedLaunch, round));
  updatedLaunch.phase = phaseForLaunch(updatedLaunch);
  state.launches[launchAddress] = updatedLaunch;
  addAddress(state.launches[launchAddress].token, "token");
  addAddress(state.launches[launchAddress].liquidityVault, "vault");
  if (state.launches[launchAddress].officialPair) addAddress(state.launches[launchAddress].officialPair, "pair");
  return state.launches[launchAddress];
}

async function refreshLaunchPhaseOnly(launchAddress) {
  if (!provider) throw new Error("RPC provider is not configured");
  const launch = state.launches[launchAddress];
  if (!launch) return null;
  const contract = new ethers.Contract(launchAddress, ABI.launch, provider);
  const phase = await withRetry(() => contract.launchPhase(), "launchPhase", 2);
  state.launches[launchAddress] = {
    ...launch,
    phase: phaseDto(phase)
  };
  return state.launches[launchAddress].phase;
}

async function refreshMetadata(launchAddress) {
  if (!provider) throw new Error("RPC provider is not configured");
  const launch = state.launches[launchAddress];
  if (!launch?.token) return null;
  const launchContract = new ethers.Contract(launchAddress, ABI.launch, provider);
  const token = new ethers.Contract(launch.token, ABI.token, provider);
  const [launchId, tokenName, tokenSymbol, description, logoSvgUri, tokenMetadataHash, launchMetadataHash, contractUri] = await Promise.all([
    safeCall(launchContract, "D17_LAUNCH_ID", null),
    safeCall(token, "name", ""),
    safeCall(token, "symbol", ""),
    safeCall(token, "description", ""),
    safeCall(token, "logoSvgUri", ""),
    safeCall(token, "metadataHash", null),
    safeCall(launchContract, "metadataHash", null),
    safeCall(token, "contractURI", "")
  ]);
  const links = [];
  const count = Number(await safeCall(token, "linkCount", 0));
  for (let index = 0; index < count; index++) {
    const item = await safeCallArgs(token, "links", [index], null);
    if (!item) continue;
    links.push({ linkType: item[0], url: item[1] });
  }
  const computedHash = metadataHashForLaunch(launchId, { tokenName, tokenSymbol, description, logoSvgUri, links });
  const event = state.metadataEvents[launchAddress] || null;
  const parsedContractUri = parseContractUriJson(contractUri);
  const contractUriMatches = Boolean(parsedContractUri
    && parsedContractUri.name === tokenName
    && parsedContractUri.symbol === tokenSymbol
    && parsedContractUri.description === description
    && parsedContractUri.image === logoSvgUri
    && JSON.stringify((parsedContractUri.links || []).map((link) => ({ linkType: link.type, url: link.url }))) === JSON.stringify(links));
  const verified = Boolean(
    computedHash
    && tokenMetadataHash === computedHash
    && launchMetadataHash === computedHash
    && Boolean(event)
    && event.metadataHash === computedHash
    && contractUriMatches
  );
  const logo = writeLogoFile(launch.token, logoSvgUri);
  const metadata = {
    launchId,
    hashRecipe: launchId ? recipeName(launchId) : "unknown",
    tokenName,
    tokenSymbol,
    description,
    logoSvgUri,
    logo,
    links,
    tokenMetadataHash,
    launchMetadataHash,
    computedHash,
    eventMetadataHash: event?.metadataHash || null,
    contractUri: {
      byteLength: Buffer.byteLength(contractUri || "", "utf8"),
      parseOk: Boolean(parsedContractUri),
      matchesStorage: contractUriMatches,
      parsed: parsedContractUri
    },
    verified
  };
  state.launches[launchAddress] = { ...state.launches[launchAddress], metadataHash: launchMetadataHash, metadata };
  return metadata;
}

function metadataHashForLaunch(launchId, fields) {
  if (!launchId) return null;
  const normalized = ethers.hexlify(launchId).toLowerCase();
  const links = fields.links || [];
  if (normalized !== CURRENT_LAUNCH_ID.toLowerCase()) return null;
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "string", "tuple(string linkType,string url)[]"],
    [fields.tokenName || "", fields.tokenSymbol || "", fields.description || "", fields.logoSvgUri || "", links]
  ));
}

function recipeName(launchId) {
  const normalized = ethers.hexlify(launchId).toLowerCase();
  if (normalized === CURRENT_LAUNCH_ID.toLowerCase()) return "D17_CURRENT_METADATA_HASH";
  return "unknown";
}

function launchVersionLabel(launchId) {
  const normalized = launchId ? ethers.hexlify(launchId).toLowerCase() : "";
  if (normalized === CURRENT_LAUNCH_ID.toLowerCase()) return "D17_CURRENT";
  return "unknown";
}

function parseContractUriJson(uri) {
  const prefixes = ["data:application/json;charset=utf-8,", "data:application/json;utf8,"];
  const prefix = prefixes.find((item) => String(uri || "").startsWith(item));
  if (!prefix) return null;
  try {
    return JSON.parse(String(uri).slice(prefix.length));
  } catch {
    return null;
  }
}

function writeLogoFile(token, logoSvgUri) {
  if (!logoSvgUri?.startsWith("data:image/svg+xml;base64,")) return null;
  if (Buffer.byteLength(logoSvgUri, "utf8") > MAX_LOGO_SVG_BYTES * 2) return null;
  mkdirSync(LOGO_DIR, { recursive: true });
  const svg = Buffer.from(logoSvgUri.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  if (!safeLogoSvg(svg)) return null;
  const tokenAddress = ethers.getAddress(token);
  const file = path.join(LOGO_DIR, `${tokenAddress}.svg`);
  writeFileSync(file, svg);
  return {
    svgFile: path.relative(root, file),
    svgUrl: `/api/assets/logos/${tokenAddress}.svg`,
    dataUriBytes: Buffer.byteLength(logoSvgUri, "utf8"),
    svgBytes: Buffer.byteLength(svg, "utf8")
  };
}

function activityForLaunch(launchAddress, { limit, cursor, locker, includeTypes = new Set(), excludeTypes = new Set() }) {
  const launchEvents = dedupeMirroredEvents(state.events
    .filter((event) => eventForLaunch(event, launchAddress))
    .filter((event) => !locker || ethers.getAddress(event.args.locker || event.args.owner || "0x0000000000000000000000000000000000000000") === locker || event.address === locker)
    .filter(publicEvent)
    .filter((event) => !includeTypes.size || includeTypes.has(event.eventName))
    .filter((event) => !excludeTypes.has(event.eventName)))
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  const start = cursor ? Math.max(0, launchEvents.findIndex((event) => event.id === cursor) + 1) : 0;
  const rows = launchEvents.slice(start, start + limit).map(activityDto);
  return { items: rows, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null };
}

function publicEvent(event) {
  return ALLOW_NOISY_API_EVENTS || !EXCLUDED_INGEST_EVENT_NAMES.has(event.eventName);
}

function mirroredEventClassification(event) {
  const family = MIRRORED_EVENT_FAMILIES.get(event.eventName);
  if (!family) return null;

  let side = null;
  if (event.eventName === "RoundCommitted" || event.eventName === "RoundRefunded") {
    if (event.sourceKind === "launch") side = "primary";
    else if (event.sourceKind === "locker") side = "mirror";
  } else if (["VaultSettlementClaimed", "LateVaultSettlementClaimed", "LaunchFailedRefunded", "OfficialPoolCreated"].includes(event.eventName)) {
    side = "primary";
  } else {
    side = "mirror";
  }
  if (!side) return null;

  const locker = normalizeOptionalAddress(event.args?.locker)
    || (event.sourceKind === "locker" ? normalizeOptionalAddress(event.address) : null)
    || "";
  const parts = [event.txHash || "", family, locker.toLowerCase()];
  if (family === "RoundCommitted") {
    parts.push(String(event.args?.round ?? ""), String(event.args?.amount ?? ""));
  } else if (family === "RoundRefunded") {
    parts.push(
      String(event.args?.round ?? event.args?.refundRound ?? ""),
      String(event.args?.refundWeth ?? ""),
      String(event.args?.penaltyWeth ?? "")
    );
  } else if (family === "LaunchFailedRefunded") {
    parts.push(String(event.args?.refundWeth ?? ""));
  }
  return { key: parts.join(":"), side };
}

function dedupeMirroredEvents(events) {
  const keep = new Set();
  const groups = new Map();
  for (const event of events) {
    const classification = mirroredEventClassification(event);
    if (!classification) {
      keep.add(event);
      continue;
    }
    const group = groups.get(classification.key) || { primary: [], mirror: [] };
    group[classification.side].push(event);
    groups.set(classification.key, group);
  }
  for (const group of groups.values()) {
    if (group.primary.length === 0) {
      for (const event of group.mirror) keep.add(event);
      continue;
    }
    for (const event of group.primary) keep.add(event);
    for (const event of group.mirror.slice(group.primary.length)) keep.add(event);
  }
  return events.filter((event) => keep.has(event));
}

function deployerSchema() {
  const createLaunch = ABI.d17Factory.find((item) => item.type === "function" && item.name === "createLaunch");
  const configFields = createLaunchConfigFields(createLaunch);
  return {
    chainId: CHAIN_ID,
    profile: CHAIN_ID === 11155111 ? "sepolia" : CHAIN_ID === 1 ? "mainnet" : "self-hosted",
    contractVersion: "D17_CURRENT",
    contractVersionId: CURRENT_LAUNCH_ID,
    hostedPublicDeployEnabled: CHAIN_ID === 11155111,
    mainnetHostedDeployEnabled: CHAIN_ID === 1 && process.env.MAINNET_HOSTED_DEPLOY_ENABLED === "1",
    contracts: {
      d17Factory: configuredContractAddress("d17Factory"),
      tokenFactory: configuredContractAddress("tokenFactory"),
      launchFactory: configuredContractAddress("launchFactory"),
      liquidityVaultFactory: configuredContractAddress("vaultFactory"),
      lockerFactory: configuredContractAddress("lockerFactory")
    },
    createLaunch: {
      contract: "D17Factory",
      method: "createLaunch",
      signature: "createLaunch((string,string,string,string,(string,string)[],uint256,uint256,uint256,uint256,uint256,address,address,uint64,uint32[5],uint32,uint32,uint256,uint256,uint256,uint16[5],uint16,uint16,bool))",
      txValueWei: "0",
      signaturesRequired: 1,
      abi: createLaunch || null,
      configFields
    },
    validation: {
      roundCount: ROUND_COUNT,
      refundStageCount: REFUND_STAGE_COUNT,
      finalRound: FINAL_ROUND,
      bps: 10000,
      tokenNameBytes: { min: 1, max: 64, jsonSafe: true },
      tokenSymbolBytes: { min: 1, max: 16, jsonSafe: true },
      descriptionBytes: { min: 0, max: 512, jsonSafe: true },
      links: {
        max: 8,
        linkTypeBytes: { min: 1, max: 32, pattern: "^[a-z0-9-]+$" },
        urlBytes: { min: 1, max: 128, scheme: "https://" }
      },
      logoSvgUri: {
        maxBytes: 8192,
        optional: true,
        requiredPrefixWhenPresent: "data:image/svg+xml;base64,"
      },
      tokenSupply: { minWei: "1" },
      supplySplit: {
        currentContractRule: "saleTokens + lpTokens + manualDistributionTokens + deadTokens == tokenSupply",
        saleTokensMinWei: "1",
        lpTokensMinWei: "1000000000000000000",
        manualDistributionTokensMaxBps: 1000,
        manualDistributionRecipient: "launch creator / msg.sender",
        deadRecipientWhenDeadTokensNonZero: "0x000000000000000000000000000000000000dEaD"
      },
      roundSeconds: { length: ROUND_COUNT, min: 60, max: 7776000 },
      roundSharesBps: {
        length: ROUND_COUNT,
        eachMin: 1,
        sum: 10000,
        minRoundAllocationWei: "1000000000000000000",
        rule: "saleTokens * roundSharesBps[i] / 10000 >= minRoundAllocationWei"
      },
      refundSeconds: { min: 1, max: 2592000 },
      settlementSeconds: { min: 1, max: 2592000 },
      startTime: { min: "current block timestamp", maxDelaySeconds: 31536000 },
      minCommitWeth: { minWei: "1000000000000000" },
      minPhase1Weth: { minRule: "minPhase1Weth >= minCommitWeth" },
      minAnchorPriceWad: { min: "1000000" },
      treasuryBps: { min: 0, max: 1000 },
      refundPenaltyBps: { min: 100, max: 2500 },
      maxProtocolFeeBps: { min: 0, max: 200, rule: "creation reverts if D17FeeConfig's fee is above this value" },
      mainnetMinimums: { startDelaySeconds: 86400, roundSeconds: 3600, refundSeconds: 3600, settlementSeconds: 3600 }
    },
    protocolFee: {
      source: "D17FeeConfig, snapshotted into each launch's immutables and rulesHash",
      maxBps: 200,
      chargedOn: "successful settlement only (never refunds, penalties or failed launches)"
    },
    refundPolicy: {
      source: "contract-fixed",
      contractVersion: "D17_V15_HARDENED",
      appliesRefundPenaltyField: "refundPenaltyBps",
      configurableByDeployer: false,
      note: "Display rounds 1-2 charge the fixed 1% early penalty, display rounds 3-4 charge refundPenaltyBps, display round 5 has no normal refund window. Every penalty is paid into the official pool (burned if the launch fails), never to the creator.",
      rounds: refundPolicyScheduleDto({ launchId: CURRENT_LAUNCH_ID, refundPenaltyBps: null })
    },
    manualDistribution: {
      supportedByCurrentContract: true,
      configField: "manualDistributionTokens",
      recipient: "launch creator / msg.sender",
      maxBpsOfSupply: 1000,
      contractChangeRequired: false,
      expectedMint: "D17LaunchFactory mints manualDistributionTokens into the liquidity vault, which vests them linearly to the creator over 180 days from pool creation.",
      splitRule: "saleTokens + lpTokens + manualDistributionTokens + deadTokens == tokenSupply"
    },
    revertStrings: {
      BURN_BEFORE_OPEN: "Token holders cannot burn before trading opens; launch-initiated unsold sale-token burn is still allowed."
    },
    knownContractGaps: [],
    lateSettlement: {
      supportedByCurrentContract: true,
      mode: "late-lp-topup",
      ownerPath: "D17Locker.settleAndClaim() after pool creation",
      publicPath: "D17Locker.settleAfterGrace() after poolCreationOpensAt",
      indexerEvents: ["LateVaultSettlementClaimed", "LateLiquidityAdded"],
      poolCompositionRule: "Initial pool uses the settled proportional LP token share; late lockers release reserved LP tokens and WETH into the pair through LateLiquidityAdded."
    },
    metadataVerification: {
      hashRecipe: "keccak256(abi.encode(tokenName, tokenSymbol, description, logoSvgUri, links))",
      logoServing: "/api/assets/logos/:token.svg"
    },
    realtime: {
      defaultSilentEventTypes: [...SILENT_REALTIME_EVENTS],
      noisyPublicOptInEnabled: ALLOW_NOISY_API_EVENTS
    },
    launchDiscovery: {
      triggerEvent: "LaunchCreated",
      appearsIn: ["/api/launches", "/api/launches/:launch"],
      healthyWsTargetSeconds: 15,
      rpcFallbackPollMs: INDEX_POLL_MS,
      rpcFallbackTargetSeconds: Math.ceil(INDEX_POLL_MS / 1000) + 15,
      note: "In healthy ws-logs mode the launch should appear after the LaunchCreated log is observed and its block is backfilled/hydrated. If WSS falls back to HTTP polling, discovery follows the polling interval plus provider latency."
    },
    lockerBalances: {
      servedByApi: true,
      source: "cached-contract-read",
      refreshMs: LOCKER_BALANCE_REFRESH_MS,
      fields: ["balances.lockedWeth", "balances.withdrawableWeth", "balances.accountedWeth"],
      note: "Known D17 locker contracts are hydrated by the backend from D17Locker getters. The frontend should not poll locker WETH balances through browser RPC in hosted API mode."
    },
    ingestionPolicy: {
      excludedEventNames: [...EXCLUDED_INGEST_EVENT_NAMES],
      excludedAtSourceLevel: true,
      pairAddressWatchingEnabled: WATCH_PAIR_EVENTS,
      pairAddressWatchingDefault: false,
      publicNoisyEventOptInEnabled: ALLOW_NOISY_API_EVENTS
    }
  };
}

function configuredContractAddress(kind) {
  return Object.entries(state.addressKinds || {}).find(([, kinds]) => kinds.includes(kind))?.[0] || "";
}

function createLaunchConfigFields(createLaunch) {
  const tuple = createLaunch?.inputs?.[0];
  return Array.isArray(tuple?.components) ? tuple.components.map((component) => component.name) : [
    "tokenName",
    "tokenSymbol",
    "description",
    "logoSvgUri",
    "links",
    "tokenSupply",
    "saleTokens",
    "lpTokens",
    "manualDistributionTokens",
    "deadTokens",
    "deadRecipient",
    "treasury",
    "startTime",
    "roundSeconds",
    "refundSeconds",
    "settlementSeconds",
    "minCommitWeth",
    "minPhase1Weth",
    "minAnchorPriceWad",
    "roundSharesBps",
    "treasuryBps",
    "refundPenaltyBps",
    "maxProtocolFeeBps"
  ];
}

function lockersForLaunch(launchAddress) {
  const lockers = state.launchLockers[launchAddress] || [];
  return lockers.map((locker) => lockerDto(locker, launchAddress)).sort((a, b) => b.lastBlock - a.lastBlock);
}

function lockerDto(locker, launchAddress) {
  const events = state.events.filter((event) => eventForLaunch(event, launchAddress) && (event.address === locker || ethers.getAddress(event.args.locker || "0x0000000000000000000000000000000000000000") === locker));
  const summary = aggregateLocker(events);
  const balances = lockerBalanceSnapshot(locker, launchAddress, summary);
  return {
    ...(state.lockers[locker] || { locker }),
    launch: launchAddress,
    ...summary,
    balances,
    position: balances.position,
    lockedWeth: balances.lockedWeth,
    withdrawableWeth: balances.withdrawableWeth,
    accountedWeth: balances.accountedWeth,
    lockerWethBalance: balances.accountedWeth,
    balanceSource: balances.source,
    balanceRefreshedAt: balances.refreshedAt,
    events: dedupeMirroredEvents(events.filter(publicEvent)).map(activityDto)
  };
}

function aggregateLocker(events) {
  const summary = {
    committedWeth: 0n,
    refundedWeth: 0n,
    penaltyWeth: 0n,
    settledWeth: 0n,
    saleTokens: 0n,
    estimatedLockedWeth: 0n,
    rounds: Array.from({ length: 5 }, (_, round) => ({ round, committedWeth: "0", refundedWeth: "0", penaltyWeth: "0" })),
    settled: false,
    lastBlock: 0
  };
  const roundBig = Array.from({ length: 5 }, () => ({ committedWeth: 0n, refundedWeth: 0n, penaltyWeth: 0n }));
  for (const event of dedupeMirroredEvents(events)) {
    summary.lastBlock = Math.max(summary.lastBlock, event.blockNumber);
    if (event.eventName === "RoundCommitted") {
      const round = Number(event.args.round);
      const amount = BigInt(event.args.amount || 0);
      summary.committedWeth += amount;
      if (roundBig[round]) roundBig[round].committedWeth += amount;
    }
    if (event.eventName === "RoundRefunded") {
      const round = Number(event.args.round ?? event.args.refundRound ?? 0);
      const refund = BigInt(event.args.refundWeth || 0);
      const penalty = BigInt(event.args.penaltyWeth || 0);
      summary.refundedWeth += refund;
      summary.penaltyWeth += penalty;
      if (roundBig[round]) {
        roundBig[round].refundedWeth += refund;
        roundBig[round].penaltyWeth += penalty;
      }
    }
    if (event.eventName === "VaultSettlementClaimed" || event.eventName === "LateVaultSettlementClaimed" || event.eventName === "VaultSettlementCompleted") {
      summary.settled = true;
      summary.settledWeth += BigInt(event.args.wethForVault || event.args.wethSentToVault || 0);
      summary.saleTokens += BigInt(event.args.saleTokens || event.args.claimedSaleTokens || 0);
    }
    if (event.eventName === "LaunchFailedRefunded" || event.eventName === "FailedLaunchRefunded") {
      summary.refundedWeth += BigInt(event.args.refundWeth || 0);
    }
  }
  summary.estimatedLockedWeth = summary.settled
    ? 0n
    : summary.committedWeth - summary.refundedWeth - summary.penaltyWeth;
  if (summary.estimatedLockedWeth < 0n) summary.estimatedLockedWeth = 0n;
  summary.rounds = roundBig.map((item, round) => ({
    round,
    committedWeth: item.committedWeth.toString(),
    refundedWeth: item.refundedWeth.toString(),
    penaltyWeth: item.penaltyWeth.toString()
  }));
  return stringifyBigints(summary);
}

function lockerBalanceSnapshot(locker, launchAddress, summary = {}) {
  const snapshot = state.lockers[locker]?.balanceSnapshots?.[launchAddress] || null;
  const estimatedLockedWeth = decimalString(summary.estimatedLockedWeth);
  if (!snapshot) {
    return {
      lockedWeth: estimatedLockedWeth,
      withdrawableWeth: null,
      accountedWeth: null,
      position: null,
      source: "indexed-event-estimate",
      refreshedAt: null,
      indexedToBlock: state.indexedToBlock || 0
    };
  }
  return {
    lockedWeth: decimalString(snapshot.lockedWeth),
    withdrawableWeth: decimalString(snapshot.withdrawableWeth),
    accountedWeth: decimalString(snapshot.accountedWeth),
    position: snapshot.position || null,
    estimatedLockedWeth,
    source: snapshot.source || "cached-contract-read",
    refreshedAt: snapshot.refreshedAt || null,
    indexedToBlock: Number(snapshot.indexedToBlock || 0)
  };
}

function eventForLaunch(event, launchAddress) {
  if (event.address === launchAddress) return true;
  const launch = state.launches[launchAddress];
  if (!launch) return false;
  if (event.address === launch.token || event.address === launch.liquidityVault || event.address === launch.officialPair) return true;
  if (event.args.launch) {
    try {
      return ethers.getAddress(event.args.launch) === launchAddress;
    } catch {
      return false;
    }
  }
  return false;
}

function eventSemanticKey(event) {
  return [
    event.txHash || "",
    event.address || "",
    event.topic0 || event.topics?.[0] || "",
    JSON.stringify(event.topics || []),
    event.dataHex || "0x"
  ].join("|");
}

function lateEventTotals(launchAddress, additionalEvent = null) {
  const totals = {
    lateSettledCommittedWeth: 0n,
    lateSettledLiquidityWeth: 0n,
    lateLpTokensReleased: 0n,
    lateTokenUsedForLp: 0n,
    lateWethUsedForLp: 0n,
    lateLpMinted: 0n
  };
  const events = additionalEvent ? [...(state.events || []), additionalEvent] : (state.events || []);
  for (const event of events) {
    if (!eventForLaunch(event, launchAddress)) continue;
    if (event.eventName === "LateVaultSettlementClaimed") {
      totals.lateSettledCommittedWeth += toBigIntSafe(event.args?.grossCommittedWeth);
      totals.lateSettledLiquidityWeth += toBigIntSafe(event.args?.wethForVault);
      totals.lateLpTokensReleased += toBigIntSafe(event.args?.lateLpTokens);
    }
    if (event.eventName === "LateLiquidityAdded") {
      totals.lateTokenUsedForLp += toBigIntSafe(event.args?.tokenUsed);
      totals.lateWethUsedForLp += toBigIntSafe(event.args?.wethUsed);
      totals.lateLpMinted += toBigIntSafe(event.args?.lpMinted);
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toString()]));
}

function firstEventArg(args, ...names) {
  for (const name of names) {
    if (args?.[name] !== undefined && args[name] !== null && args[name] !== "") return args[name];
  }
  return null;
}

function activityAmounts(event) {
  const args = event.args || {};
  let amountWeth = firstEventArg(args, "refundWeth", "wethForVault", "wethSentToVault", "wethForPool", "wethUsed");
  let amountToken = firstEventArg(args, "saleTokens", "liquidityTokens", "tokenUsed", "value");
  let amountNative = null;

  if (GENERIC_TOKEN_AMOUNT_EVENT_NAMES.has(event.eventName)) amountToken = firstEventArg(args, "amount") ?? amountToken;
  if (GENERIC_WETH_AMOUNT_EVENT_NAMES.has(event.eventName)) amountWeth = firstEventArg(args, "amount") ?? amountWeth;
  if (GENERIC_NATIVE_AMOUNT_EVENT_NAMES.has(event.eventName)) amountNative = firstEventArg(args, "amount");

  return { amountWeth, amountToken, amountNative };
}

function activityDto(event) {
  const amounts = activityAmounts(event);
  return {
    id: event.id,
    eventName: event.eventName,
    sourceKind: event.sourceKind,
    address: event.address,
    locker: event.args.locker || (event.sourceKind === "locker" ? event.address : null),
    owner: event.args.owner || state.lockers[event.address]?.owner || null,
    roundIndex: event.args.round ?? event.args.refundRound ?? null,
    amountWeth: amounts.amountWeth,
    amountToken: amounts.amountToken,
    amountNative: amounts.amountNative,
    penaltyWeth: event.args.penaltyWeth || null,
    txHash: event.txHash,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    timestamp: event.timestamp,
    args: event.args
  };
}

function launchDto(launch) {
  const current = decorateLaunchForApi(launch);
  return {
    ...current,
    unsoldSaleTokens: unsoldSaleTokenDispositionDto(current),
    lockers: lockersForLaunch(current.launch).map(({ events, ...summary }) => summary),
    activityCount: dedupeMirroredEvents(state.events.filter((event) => eventForLaunch(event, current.launch) && publicEvent(event))).length
  };
}

function unsoldSaleTokenDispositionDto(launch) {
  const event = state.events
    .filter((candidate) => eventForLaunch(candidate, launch.launch))
    .filter((candidate) => candidate.eventName === "UnsoldSaleTokensBurned" || candidate.eventName === "UnsoldSaleTokensPaid")
    .sort((left, right) => right.blockNumber - left.blockNumber || right.logIndex - left.logIndex)[0] || null;
  const amount = decimalString(firstEventArg(event?.args, "amount") ?? launch.unsoldSaleTokensSettled);
  const failed = launch.phase?.label === "failed";
  let status = "pending";
  if (failed) status = "not-applicable";
  else if (event?.eventName === "UnsoldSaleTokensBurned") status = "burned";
  else if (event?.eventName === "UnsoldSaleTokensPaid") status = "paid-to-treasury";
  else if (launch.finalized && amount === "0") status = "none";
  else if (launch.finalized) status = launch.burnUnsoldSaleTokens ? "burned" : "paid-to-treasury";

  return {
    configuredPolicy: launch.burnUnsoldSaleTokens ? "burn" : "pay-treasury",
    status,
    amount,
    recipient: status === "paid-to-treasury"
      ? normalizeOptionalAddress(event?.args?.recipient) || launch.treasury || null
      : null,
    txHash: event?.txHash || null,
    blockNumber: event?.blockNumber ?? null,
    timestamp: event?.timestamp ?? null,
    source: event ? "event" : "contract-state"
  };
}

function decorateLaunchForApi(launch) {
  if (!launch) return launch;
  const current = { ...launch };
  current.rounds = Array.isArray(current.rounds)
    ? current.rounds.map((round) => roundDto(current, round))
    : [];
  current.config = launchConfigDto(current);
  current.tokenomics = tokenomicsDto(current);
  current.poolComposition = poolCompositionDto(current);
  current.phase = phaseForLaunch(current);
  return current;
}

function launchConfigDto(launch) {
  const rounds = Array.isArray(launch.rounds) ? launch.rounds : [];
  const refundPolicySchedule = refundPolicyScheduleDto(launch);
  return {
    version: launchVersionLabel(launch.launchId),
    launchId: launch.launchId || "",
    roundCount: ROUND_COUNT,
    finalRound: FINAL_ROUND,
    refundStageCount: REFUND_STAGE_COUNT,
    contractRoundIndexBase: 0,
    displayRoundIndexBase: 1,
    startTime: numberOrNull(launch.startTime),
    roundSeconds: rounds.map((round) => Number(round.seconds || 0)),
    roundSharesBps: rounds.map((round) => String(round.shareBps ?? "")),
    roundStart: rounds.map((round) => numberOrNull(round.start)),
    roundEnd: rounds.map((round) => numberOrNull(round.end)),
    roundDiscoveredPriceWad: rounds.map((round) => String(round.discoveredPriceWad || "0")),
    refundSeconds: numberOrNull(launch.refundSeconds),
    settlementSeconds: numberOrNull(launch.settlementSeconds),
    refundPenaltyBps: numberOrNull(launch.refundPenaltyBps),
    refundPolicySource: "contract-fixed",
    refundPenaltySchedule: refundPolicySchedule,
    refundPenaltyRounds: refundPolicySchedule.map((item) => item.appliesPenalty),
    minCommitWeth: decimalString(launch.minCommitWeth),
    minPhase1Weth: decimalString(launch.minPhase1Weth),
    minAnchorPriceWad: decimalString(launch.minAnchorPriceWad),
    treasuryBps: numberOrNull(launch.treasuryBps),
    treasury: launch.treasury || "",
    protocolFeeBps: numberOrNull(launch.protocolFeeBps),
    protocolFeeRecipient: launch.protocolFeeRecipient || "",
    creatorVestingSeconds: numberOrNull(launch.creatorVestingSeconds),
    officialPair: launch.officialPair || "",
    allFinalCommitmentsSettled: Boolean(launch.allFinalCommitmentsSettled),
    poolCreationRequiresAllSettled: false
  };
}

function tokenomicsDto(launch) {
  const saleTokens = decimalString(launch.saleTokens);
  const lpTokens = decimalString(launch.lpTokens);
  const deadTokens = decimalString(launch.deadTokens);
  const manualDistributionTokens = decimalString(launch.manualDistributionTokens);
  const supply = decimalString(launch.tokenSupply || launch.tokenMaxSupply || tokenSupplyFromParts(saleTokens, lpTokens, deadTokens, manualDistributionTokens));
  const maxSupply = decimalString(launch.tokenMaxSupply || supply);
  const totalSupply = launch.tokenTotalSupply != null ? decimalString(launch.tokenTotalSupply) : null;
  const burnedTokens = totalSupply == null ? null : nonNegativeDelta(maxSupply, totalSupply);
  return {
    supply,
    tokenSupply: supply,
    maxSupply,
    totalSupply,
    saleTokens,
    lpTokens,
    deadTokens,
    deadAddressAllocationTokens: deadTokens,
    burnedTokens,
    manualDistributionTokens,
    deployerAirdropTokens: decimalString(launch.deployerAirdropTokens || manualDistributionTokens),
    manualDistributionRecipient: launch.manualDistributionRecipient || launch.creator || "",
    treasuryBps: numberOrNull(launch.treasuryBps),
    treasury: launch.treasury || "",
    minCommitWeth: decimalString(launch.minCommitWeth),
    officialPair: launch.officialPair || "",
    officialTokenUsedForLp: decimalString(launch.officialTokenUsedForLp),
    lateTokenUsedForLp: decimalString(launch.lateTokenUsedForLp),
    reservedLpTokensRemaining: decimalString(launch.reservedLpTokensRemaining)
  };
}

function poolCompositionDto(launch) {
  const lpTokens = decimalString(launch.lpTokens);
  const initialTokenUsed = decimalString(launch.officialTokenUsedForLp);
  const initialWethUsed = decimalString(launch.officialWethUsedForLp);
  const initialLpMinted = decimalString(launch.officialLpMinted);
  const lateTokenUsed = decimalString(launch.lateTokenUsedForLp);
  const lateWethUsed = decimalString(launch.lateWethUsedForLp);
  const lateLpMinted = decimalString(launch.lateLpMinted);
  const lateLpTokensReleased = decimalString(launch.lateLpTokensReleased);
  const reservedRemaining = decimalString(launch.reservedLpTokensRemaining || reservedLpTokens(lpTokens, launch.vaultLiquidityTokensClaimed, launch.lateLpTokensReleased));
  return {
    model: "proportional-initial-plus-late-topup",
    officialPair: launch.officialPair || "",
    allFinalCommitmentsSettled: Boolean(launch.allFinalCommitmentsSettled),
    finalCommittedWeth: decimalString(launch.finalCommittedWeth),
    settledCommittedWeth: decimalString(launch.settledCommittedWeth),
    unsettledCommittedWeth: nonNegativeDelta(launch.finalCommittedWeth, launch.settledCommittedWeth),
    totalLiquidityWeth: decimalString(launch.totalLiquidityWeth),
    settledLiquidityWeth: decimalString(launch.settledLiquidityWeth),
    poolSettledCommittedWeth: decimalString(launch.poolSettledCommittedWeth),
    poolSettledLiquidityWeth: decimalString(launch.poolSettledLiquidityWeth),
    initial: {
      tokenUsedForLp: initialTokenUsed,
      wethUsedForLp: initialWethUsed,
      lpMinted: initialLpMinted,
      sourceEvents: ["VaultLiquidityTokensClaimed", "LiquidityPoolCreated", "OfficialPoolCreated"]
    },
    lateTopUp: {
      tokenUsedForLp: lateTokenUsed,
      wethUsedForLp: lateWethUsed,
      lpMinted: lateLpMinted,
      lpTokensReleased: lateLpTokensReleased,
      settledCommittedWeth: decimalString(launch.lateSettledCommittedWeth),
      settledLiquidityWeth: decimalString(launch.lateSettledLiquidityWeth),
      sourceEvents: ["LateVaultSettlementClaimed", "LateLiquidityAdded"]
    },
    reserved: {
      lpTokens,
      vaultLiquidityTokensClaimed: decimalString(launch.vaultLiquidityTokensClaimed),
      lateLpTokensReleased,
      remainingLpTokens: reservedRemaining
    },
    totals: {
      tokenUsedForLp: addDecimalStrings(initialTokenUsed, lateTokenUsed),
      wethUsedForLp: addDecimalStrings(initialWethUsed, lateWethUsed),
      lpMinted: addDecimalStrings(initialLpMinted, lateLpMinted)
    }
  };
}

function roundDto(launch, round) {
  const contractRound = Number(round.round ?? 0);
  const refundPolicy = refundPolicyForRound(launch, round);
  return {
    ...round,
    round: contractRound,
    displayRound: Number(round.displayRound || contractRound + 1),
    start: numberOrNull(round.start),
    end: numberOrNull(round.end),
    seconds: numberOrNull(round.seconds),
    shareBps: numberOrNull(round.shareBps),
    baseTokenAllocation: decimalString(round.baseTokenAllocation),
    tokenAllocation: decimalString(round.tokenAllocation),
    soldTokens: decimalString(round.soldTokens),
    raisedWeth: decimalString(round.raisedWeth),
    anchorTargetWeth: decimalString(round.anchorTargetWeth),
    underfillRemainingWeth: decimalString(round.underfillRemainingWeth),
    discoveredPriceWad: decimalString(round.discoveredPriceWad),
    claimTime: numberOrNull(round.claimTime),
    refundable: refundPolicy.refundable,
    refundPenaltyBps: refundPolicy.refundPenaltyBps,
    deflectionCostBps: refundPolicy.deflectionCostBps,
    refundPolicy
  };
}

function refundPolicyForRound(launch, round) {
  const contractRound = Number(round.round ?? 0);
  const refundable = contractRound < REFUND_STAGE_COUNT;
  const appliesPenalty = refundable && refundPenaltyAppliesForRound(launch, contractRound);
  const penaltyBps = !refundable
    ? null
    : contractRound < EARLY_REFUND_ROUNDS
      ? EARLY_REFUND_PENALTY_BPS
      : Number(launch.refundPenaltyBps || 0);
  return {
    refundable,
    reason: refundable ? null : "final-round-no-normal-refund-window",
    refundWindowStart: refundable ? numberOrNull(round.end) : null,
    refundWindowEnd: refundable ? numberOrNull(Number(round.end || 0) + Number(launch.refundSeconds || 0)) : null,
    source: "contract-fixed",
    appliesPenalty,
    refundPenaltyBps: penaltyBps,
    deflectionCostBps: penaltyBps
  };
}

// V15: every refund window charges a penalty (fixed 1% in contract rounds 0-1,
// refundPenaltyBps in rounds 2-3); the final round has no window.
const EARLY_REFUND_ROUNDS = 2;
const EARLY_REFUND_PENALTY_BPS = 100;

function refundPenaltyAppliesForRound(launch, contractRound) {
  return contractRound < REFUND_STAGE_COUNT;
}

function refundPolicyScheduleDto(launch) {
  return Array.from({ length: ROUND_COUNT }, (_, contractRound) => {
    const refundable = contractRound < REFUND_STAGE_COUNT;
    const appliesPenalty = refundable && refundPenaltyAppliesForRound(launch, contractRound);
    const penaltyBps = !refundable
      ? null
      : contractRound < EARLY_REFUND_ROUNDS
        ? EARLY_REFUND_PENALTY_BPS
        : launch?.refundPenaltyBps != null ? Number(launch.refundPenaltyBps || 0) : null;
    return {
      round: contractRound,
      displayRound: contractRound + 1,
      refundable,
      appliesPenalty,
      refundPenaltyBps: penaltyBps,
      deflectionCostBps: penaltyBps,
      reason: refundable ? null : "final-round-no-normal-refund-window"
    };
  });
}

function addAddress(address, kind) {
  if (!address) return;
  const normalized = ethers.getAddress(address);
  const current = state.addressKinds[normalized] || [];
  if (!current.includes(kind)) state.addressKinds[normalized] = [...current, kind];
}

function watchAddresses() {
  return Object.entries(state.addressKinds)
    .filter(([, kinds]) => WATCH_PAIR_EVENTS || !kinds.includes("pair"))
    .map(([address]) => address);
}

function addressKey() {
  return `${watchAddresses().sort().join(",")}|${INGEST_TOPIC0S.join(",")}`;
}

function normalizeAddressKinds(target = state) {
  const normalizedKinds = {};
  for (const [address, kinds] of Object.entries(target.addressKinds || {})) {
    let normalized = "";
    try {
      normalized = ethers.getAddress(address);
    } catch {
      continue;
    }
    const current = new Set(normalizedKinds[normalized] || []);
    for (const kind of kinds || []) current.add(kind);
    normalizedKinds[normalized] = [...current].sort();
  }
  target.addressKinds = normalizedKinds;
  return target;
}

function ingestLogFilter(baseFilter) {
  return INGEST_TOPIC0S.length
    ? { ...baseFilter, topics: [INGEST_TOPIC0S] }
    : baseFilter;
}

function allowedIngestTopic0s() {
  const topics = new Set();
  for (const iface of Object.values(ifaceByKind)) {
    for (const fragment of iface.fragments) {
      if (fragment.type !== "event") continue;
      if (EXCLUDED_INGEST_EVENT_NAMES.has(fragment.name)) continue;
      topics.add(ethers.id(fragment.format("sighash")));
    }
  }
  return [...topics].sort();
}

function bootstrapConfiguredAddresses() {
  const deployment = readMaybeJson(resolveMaybe(process.env.FACTORY_DEPLOYMENT_FILE || ""));
  if (deployment?.chainId !== undefined && Number(deployment.chainId) !== CHAIN_ID) {
    throw new Error(`Deployment manifest chain mismatch: expected ${CHAIN_ID}, received ${deployment.chainId}`);
  }
  const contracts = deployment?.contracts || deployment || {};
  const factory = process.env.D17_FACTORY_ADDRESS || contracts.d17Factory || contracts.factory;
  const tokenFactory = process.env.D17_TOKEN_FACTORY_ADDRESS || contracts.tokenFactory;
  const launchFactory = process.env.D17_LAUNCH_FACTORY_ADDRESS || contracts.launchFactory;
  const vaultFactory = process.env.D17_LIQUIDITY_VAULT_FACTORY_ADDRESS || contracts.liquidityVaultFactory;
  const lockerFactory = process.env.D17_LOCKER_FACTORY_ADDRESS || contracts.lockerFactory;
  const launch = process.env.LAUNCH_ADDRESS || "";
  const configuredFactories = {
    d17Factory: factory ? ethers.getAddress(factory) : "",
    tokenFactory: tokenFactory ? ethers.getAddress(tokenFactory) : "",
    launchFactory: launchFactory ? ethers.getAddress(launchFactory) : "",
    vaultFactory: vaultFactory ? ethers.getAddress(vaultFactory) : "",
    lockerFactory: lockerFactory ? ethers.getAddress(lockerFactory) : ""
  };
  for (const [kind, address] of Object.entries(configuredFactories)) {
    if (!address) continue;
    const existing = Object.entries(state.addressKinds || {})
      .filter(([, kinds]) => Array.isArray(kinds) && kinds.includes(kind))
      .map(([candidate]) => ethers.getAddress(candidate));
    if (existing.some((candidate) => candidate !== address)) {
      throw new Error(`State deployment mismatch for ${kind}; use a fresh STATE_FILE for a different factory suite.`);
    }
  }
  if (factory) addAddress(factory, "d17Factory");
  if (tokenFactory) addAddress(tokenFactory, "tokenFactory");
  if (launchFactory) addAddress(launchFactory, "launchFactory");
  if (vaultFactory) addAddress(vaultFactory, "vaultFactory");
  if (lockerFactory) addAddress(lockerFactory, "lockerFactory");
  if (launch) addAddress(launch, "launch");
  const startBlock = Number(process.env.START_BLOCK || deployment?.startBlock || deployment?.gas?.blockNumber || deployment?.factoryBlock || deployment?.blockNumber || 0);
  const deploymentFingerprint = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
    chainId: CHAIN_ID,
    startBlock,
    factories: configuredFactories,
    weth: deployment?.weth || "",
    router: deployment?.router || ""
  })));
  if (state.deploymentFingerprint && state.deploymentFingerprint !== deploymentFingerprint) {
    throw new Error("State deployment fingerprint does not match the configured deployment manifest.");
  }
  state.deploymentFingerprint = deploymentFingerprint;
  const forceStartBlock = process.env.D17_FORCE_DEPLOYMENT_START_BLOCK === "1" || process.env.FORCE_DEPLOYMENT_START_BLOCK === "1";
  if (startBlock && (forceStartBlock || !state.startBlock || startBlock < state.startBlock)) {
    state.startBlock = startBlock;
    const indexedToBlock = Number(state.indexedToBlock || 0);
    state.indexedToBlock = indexedToBlock >= startBlock ? indexedToBlock : startBlock - 1;
  }
  if (!state.startBlock) state.startBlock = Number(process.env.START_BLOCK || 0);
}

function assertConfiguredState() {
  if (Number(state.chainId) !== CHAIN_ID) {
    throw new Error(`State chain mismatch: expected ${CHAIN_ID}, received ${state.chainId ?? "none"}`);
  }
  if (watchAddresses().length === 0) {
    throw new Error("No D17 factory addresses are configured. Set FACTORY_DEPLOYMENT_FILE or explicit factory addresses.");
  }
}

async function rebuildDerivedState() {
  const previous = state.events;
  state.launches = {};
  state.lockers = {};
  state.launchLockers = {};
  state.metadataEvents = {};
  const configuredKinds = { ...state.addressKinds };
  state.addressKinds = {};
  for (const [address, kinds] of Object.entries(configuredKinds)) {
    for (const kind of kinds.filter((item) => item.endsWith("Factory") || item === "d17Factory")) addAddress(address, kind);
  }
  const replay = previous.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  state.events = [];
  for (const event of replay) {
    await applyEvent(event);
    state.events.push(event);
  }
}

function decodedArgs(parsed) {
  const out = {};
  parsed.fragment.inputs.forEach((input, index) => {
    const value = parsed.args[index];
    out[input.name || String(index)] = normalizeValue(value);
  });
  return out;
}

function normalizeValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") return stringifyBigints(value);
  return value;
}

function stringifyBigints(value) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
}

function phaseDto(snapshot) {
  const kind = Number(snapshot[0]);
  const roundIndex = Number(snapshot[1]);
  return buildPhase(kind, roundIndex, snapshot[2], snapshot[3], "contract-read");
}

function phaseForLaunch(launch, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!launch) return null;
  const rounds = Array.isArray(launch.rounds) ? launch.rounds : [];
  const startTime = Number(launch.startTime || rounds[0]?.start || 0);
  const refundSeconds = Number(launch.refundSeconds || 0);
  const finalRound = rounds[FINAL_ROUND];
  if (!startTime || rounds.length < ROUND_COUNT || !refundSeconds || !finalRound) {
    return launch.phase ? { ...launch.phase, source: launch.phase.source || "cached" } : null;
  }

  const finalized = Boolean(launch.finalized);
  const liquidityPoolCreated = Boolean(launch.liquidityPoolCreated || launch.tradingOpen || launch.officialPair);
  const poolCreationOpensAt = Number(launch.poolCreationOpensAt || launch.tradingOpenAt || 0);
  const poolCreatedAt = Number(launch.poolCreatedAt || poolCreationOpensAt || nowSeconds);
  const finalizedAt = Number(launch.finalizedAt || 0);

  if (finalized && liquidityPoolCreated) return buildPhase(6, NO_ROUND, poolCreatedAt, MAX_UINT256_STRING, "indexed-state");
  if (finalized && nowSeconds < poolCreationOpensAt) return buildPhase(4, NO_ROUND, finalizedAt, poolCreationOpensAt, "indexed-state");
  if (finalized) return buildPhase(5, NO_ROUND, poolCreationOpensAt, MAX_UINT256_STRING, "indexed-state");
  if (nowSeconds < startTime) return buildPhase(0, NO_ROUND, startTime, startTime, "indexed-state");

  const firstRefundEnd = Number(rounds[0]?.end || 0) + refundSeconds;
  if (nowSeconds >= firstRefundEnd && !anchorReady(launch)) {
    return buildPhase(7, NO_ROUND, firstRefundEnd, MAX_UINT256_STRING, "indexed-state");
  }

  for (const round of rounds) {
    const roundIndex = Number(round.round ?? 0);
    const start = Number(round.start || 0);
    const end = Number(round.end || 0);
    if (nowSeconds >= start && nowSeconds < end) {
      if (roundIndex > 0 && !anchorReady(launch)) break;
      return buildPhase(1, roundIndex, start, end, "indexed-state");
    }
  }

  for (const round of rounds.slice(0, REFUND_STAGE_COUNT)) {
    const roundIndex = Number(round.round ?? 0);
    const start = Number(round.end || 0);
    const end = start + refundSeconds;
    if (nowSeconds >= start && nowSeconds < end) {
      return buildPhase(2, roundIndex, start, end, "indexed-state");
    }
  }

  const finalRoundEnd = Number(finalRound.end || 0);
  if (nowSeconds >= finalRoundEnd) return buildPhase(3, NO_ROUND, finalRoundEnd, poolCreationOpensAt, "indexed-state");
  return buildPhase(0, NO_ROUND, startTime, startTime, "indexed-state");
}

function buildPhase(kind, roundIndex, startsAt, endsAt, source) {
  const startString = String(startsAt ?? 0);
  const endString = String(endsAt ?? 0);
  const openEnded = endString === MAX_UINT256_STRING;
  return {
    kind,
    label: PHASE_LABELS[kind] || "unknown",
    roundIndex,
    displayRound: roundIndex === NO_ROUND ? null : roundIndex + 1,
    startsAt: Number(startString),
    endsAt: openEnded ? null : Number(endString),
    openEnded,
    raw: [String(kind), String(roundIndex), startString, endString],
    source,
    computedAt: new Date().toISOString()
  };
}

function anchorReady(launch) {
  const round0 = launch.rounds?.[0] || {};
  const raised = currentRoundRaised(launch.launch, 0) ?? toBigIntSafe(round0.raisedWeth);
  const allocation = toBigIntSafe(round0.baseTokenAllocation || round0.tokenAllocation);
  const minPhase1Weth = toBigIntSafe(launch.minPhase1Weth);
  const minAnchorPriceWad = toBigIntSafe(launch.minAnchorPriceWad);
  const anchorPriceWad = allocation > 0n && raised > 0n
    ? raised * WAD / allocation
    : toBigIntSafe(launch.anchorPriceWad);
  return raised >= minPhase1Weth && anchorPriceWad >= minAnchorPriceWad;
}

function currentRoundRaised(launchAddress, round) {
  if (!launchAddress) return null;
  let sawRoundEvent = false;
  let raised = 0n;
  for (const event of state.events || []) {
    if (!eventForLaunch(event, launchAddress)) continue;
    if (isMirroredLockerEvent(event)) continue;
    const eventRound = Number(event.args?.round ?? event.args?.refundRound ?? -1);
    if (eventRound !== round) continue;
    if (event.eventName === "RoundCommitted") {
      sawRoundEvent = true;
      raised += toBigIntSafe(event.args?.amount);
    }
    if (event.eventName === "RoundRefunded") {
      sawRoundEvent = true;
      raised -= toBigIntSafe(event.args?.refundWeth) + toBigIntSafe(event.args?.penaltyWeth);
    }
  }
  return sawRoundEvent ? raised > 0n ? raised : 0n : null;
}

async function ensureLaunchApiState(launchAddress) {
  const launch = state.launches[launchAddress];
  if (!launch) return null;
  if (INDEX_DISABLED || !provider) return launch;
  const needsLaunchHydration = !launchHasApiState(launch);
  const needsLaunchRefresh = REFRESH_SNAPSHOTS_ON_REQUEST && launchSnapshotNeedsRefresh(launch);
  const needsLockerBalanceHydration = lockerBalancesNeedRefresh(launchAddress);
  if (!needsLaunchHydration && !needsLaunchRefresh && !needsLockerBalanceHydration) return launch;
  if (!launchHydrationPromises.has(launchAddress)) {
    launchHydrationPromises.set(launchAddress, (async () => {
      try {
        const refreshed = needsLaunchHydration || needsLaunchRefresh
          ? await refreshLaunchSnapshot(launchAddress)
          : state.launches[launchAddress];
        if (needsLockerBalanceHydration) await refreshLockerBalancesForLaunch(launchAddress);
        saveState();
        return refreshed || state.launches[launchAddress];
      } catch (error) {
        console.warn(`Launch API hydration skipped for ${launchAddress}: ${humanError(error)}`);
        return state.launches[launchAddress];
      } finally {
        launchHydrationPromises.delete(launchAddress);
      }
    })());
  }
  return launchHydrationPromises.get(launchAddress);
}

function lockerBalancesNeedRefresh(launchAddress) {
  if (LOCKER_BALANCE_REFRESH_MS < 0) return false;
  const lockers = state.launchLockers[launchAddress] || [];
  if (!lockers.length) return false;
  const now = Date.now();
  return lockers.some((locker) => {
    const snapshot = state.lockers[locker]?.balanceSnapshots?.[launchAddress];
    if (!snapshot?.refreshedAt || !snapshot.position) return true;
    if (!REFRESH_LOCKER_BALANCES_ON_REQUEST) return false;
    const refreshedAtMs = Date.parse(snapshot.refreshedAt);
    return !Number.isFinite(refreshedAtMs) || now - refreshedAtMs >= LOCKER_BALANCE_REFRESH_MS;
  });
}

async function refreshLockerBalancesForLaunch(launchAddress) {
  if (!provider || LOCKER_BALANCE_REFRESH_MS < 0) return;
  const lockers = state.launchLockers[launchAddress] || [];
  if (!lockers.length) return;
  if (lockerBalanceHydrationPromises.has(launchAddress)) return lockerBalanceHydrationPromises.get(launchAddress);
  const promise = runLimited(lockers.map((locker) => async () => {
    await refreshLockerBalance(launchAddress, locker).catch((error) => {
      console.warn(`Locker balance refresh skipped for ${locker}: ${humanError(error)}`);
    });
  }), Math.max(1, LOCKER_BALANCE_REFRESH_CONCURRENCY)).finally(() => {
    lockerBalanceHydrationPromises.delete(launchAddress);
  });
  lockerBalanceHydrationPromises.set(launchAddress, promise);
  return promise;
}

async function refreshLockerBalance(launchAddress, locker, blockTag = state.indexedToBlock) {
  const contract = new ethers.Contract(locker, ABI.locker, provider);
  const blockOverride = Number(blockTag) > 0 ? { blockTag: Number(blockTag) } : {};
  const [lockedWeth, withdrawableWeth, accountedWeth, position] = await runLimited([
    () => safeCallArgs(contract, "lockedWeth", [launchAddress, blockOverride], null),
    () => safeCallArgs(contract, "withdrawableWeth", [blockOverride], null),
    () => safeCallArgs(contract, "accountedWeth", [blockOverride], null),
    () => safeCallArgs(contract, "positions", [launchAddress, blockOverride], null)
  ], 2);
  const exactRounds = await runLimited(Array.from({ length: ROUND_COUNT }, (_, round) => async () => {
    const value = await safeCallArgs(contract, "roundPosition", [launchAddress, round, blockOverride], null);
    if (value == null) return null;
    return {
      round,
      committedWeth: decimalString(value[0]),
      claimedSaleTokens: decimalString(value[1]),
      refunded: Boolean(value[2]),
      tokensClaimed: Boolean(value[3])
    };
  }), 2);
  if (lockedWeth == null && withdrawableWeth == null && accountedWeth == null && position == null) return;
  const serializedPosition = position == null ? null : {
    // Named fields: the V15 locker struct inserted protocolFeeWeth after treasuryWeth.
    known: Boolean(position.known),
    liquiditySettled: Boolean(position.liquiditySettled),
    token: normalizeOptionalAddress(position.token),
    liquidityVault: normalizeOptionalAddress(position.liquidityVault),
    rulesHash: position.rulesHash,
    ethCommitted: decimalString(position.ethCommitted),
    wethCommitted: decimalString(position.wethCommitted),
    wethRefunded: decimalString(position.wethRefunded),
    penaltyPaid: decimalString(position.penaltyPaid),
    claimedSaleTokens: decimalString(position.claimedSaleTokens),
    wethSentToVault: decimalString(position.wethSentToVault),
    wethForLp: decimalString(position.wethForLp),
    treasuryWeth: decimalString(position.treasuryWeth),
    protocolFeeWeth: decimalString(position.protocolFeeWeth),
    withdrawableTokens: decimalString(position.withdrawableTokens),
    residualWeth: decimalString(position.residualWeth),
    finalSaleTokensClaimed: Boolean(position.finalSaleTokensClaimed),
    rounds: exactRounds.filter(Boolean)
  };
  state.lockers[locker] = {
    ...(state.lockers[locker] || { locker }),
    locker,
    balanceSnapshots: {
      ...(state.lockers[locker]?.balanceSnapshots || {}),
      [launchAddress]: {
        lockedWeth: lockedWeth == null ? null : lockedWeth.toString(),
        withdrawableWeth: withdrawableWeth == null ? null : withdrawableWeth.toString(),
        accountedWeth: accountedWeth == null ? null : accountedWeth.toString(),
        position: serializedPosition,
        source: "cached-contract-read",
        refreshedAt: new Date().toISOString(),
        indexedToBlock: Number(blockTag || state.indexedToBlock || 0)
      }
    }
  };
}

function launchHasApiState(launch) {
  return Boolean(
    launch?.config
    && launch?.tokenomics
    && Array.isArray(launch.rounds)
    && launch.rounds.length >= ROUND_COUNT
    && launch.rounds.every((round) => round.start != null && round.end != null && round.shareBps != null)
  );
}

function launchSnapshotNeedsRefresh(launch) {
  if (LAUNCH_SNAPSHOT_REFRESH_MS < 0) return false;
  if (!launchHasApiState(launch)) return true;
  if (!launch?.apiSnapshotRefreshedAt) return true;
  const refreshedAtMs = Date.parse(launch.apiSnapshotRefreshedAt);
  return !Number.isFinite(refreshedAtMs) || Date.now() - refreshedAtMs >= LAUNCH_SNAPSHOT_REFRESH_MS;
}

function normalizeOptionalAddress(value) {
  if (!value) return "";
  try {
    const address = ethers.getAddress(value);
    return address === "0x0000000000000000000000000000000000000000" ? "" : address;
  } catch {
    return "";
  }
}

function manualDistributionAmount({ manualDistributionTokensFromContract, tokenMaxSupply, saleTokens, lpTokens, deadTokens }) {
  if (manualDistributionTokensFromContract != null) return decimalString(manualDistributionTokensFromContract);
  if (tokenMaxSupply == null) return "0";
  const residual = toBigIntSafe(tokenMaxSupply) - toBigIntSafe(saleTokens) - toBigIntSafe(lpTokens) - toBigIntSafe(deadTokens);
  return residual > 0n ? residual.toString() : "0";
}

function tokenSupplyFromParts(saleTokens, lpTokens, deadTokens, manualDistributionTokens = "0") {
  return (toBigIntSafe(saleTokens) + toBigIntSafe(lpTokens) + toBigIntSafe(deadTokens) + toBigIntSafe(manualDistributionTokens)).toString();
}

function reservedLpTokens(lpTokens, vaultLiquidityTokensClaimed, lateLpTokensReleased) {
  return nonNegativeDelta(lpTokens, addDecimalStrings(vaultLiquidityTokensClaimed, lateLpTokensReleased));
}

function nonNegativeDelta(left, right) {
  const delta = toBigIntSafe(left) - toBigIntSafe(right);
  return delta > 0n ? delta.toString() : "0";
}

function addDecimalStrings(...values) {
  return values.reduce((sum, value) => sum + toBigIntSafe(value), 0n).toString();
}

function maxDecimalString(...values) {
  return values.reduce((max, value) => {
    const current = toBigIntSafe(value);
    return current > max ? current : max;
  }, 0n).toString();
}

function decimalString(value) {
  if (value == null || value === "") return "0";
  return toBigIntSafe(value).toString();
}

function toBigIntSafe(value, fallback = 0n) {
  if (value == null || value === "") return fallback;
  if (typeof value === "bigint") return value;
  try {
    return BigInt(String(value));
  } catch {
    return fallback;
  }
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function findLaunchByToken(token) {
  const normalized = ethers.getAddress(token);
  return Object.values(state.launches).find((launch) => launch.token === normalized)?.launch || null;
}

function findLaunchByVault(vault) {
  const normalized = ethers.getAddress(vault);
  return Object.values(state.launches).find((launch) => launch.liquidityVault === normalized)?.launch || null;
}

async function assertNetwork() {
  const network = await withRetry(() => rpcGetNetwork(), "network");
  if (Number(network.chainId) !== CHAIN_ID) throw new Error(`Expected chain ${CHAIN_ID}, got ${network.chainId}`);
}

async function safeCall(contract, method, fallback = null) {
  try {
    return await withRetry(() => contract[method](), method, 1);
  } catch {
    return fallback;
  }
}

async function safeCallArgs(contract, method, args = [], fallback = null) {
  try {
    return await withRetry(() => contract[method](...args), method, 1);
  } catch {
    return fallback;
  }
}

async function runLimited(tasks, limit) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    const loaded = normalizeAddressKinds(JSON.parse(readFileSync(STATE_FILE, "utf8")));
    if (Number(loaded.chainId) !== CHAIN_ID) {
      throw new Error(`State file chain mismatch: expected ${CHAIN_ID}, received ${loaded.chainId ?? "none"}`);
    }
    return loaded;
  }
  return {
    schema: "d17-reference-api-state-v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    startBlock: Number(process.env.START_BLOCK || 0),
    latestBlock: 0,
    indexedToBlock: Number(process.env.START_BLOCK || 0) ? Number(process.env.START_BLOCK) - 1 : 0,
    blocks: {},
    addressKinds: {},
    launches: {},
    lockers: {},
    launchLockers: {},
    metadataEvents: {},
    events: []
  };
}

function saveState() {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, STATE_FILE);
  stateLoadedMtimeMs = stateMtimeMs();
}

function maybeReloadState() {
  if (!STATE_RELOAD_ON_REQUEST) return;
  const latestMtimeMs = stateMtimeMs();
  if (!latestMtimeMs || latestMtimeMs <= stateLoadedMtimeMs) return;
  try {
    const nextState = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (Number(nextState.chainId) !== CHAIN_ID) {
      throw new Error(`Reloaded state chain mismatch: expected ${CHAIN_ID}, received ${nextState.chainId ?? "none"}`);
    }
    state = nextState;
    normalizeAddressKinds();
    stateLoadedMtimeMs = latestMtimeMs;
    bootstrapConfiguredAddresses();
    assertConfiguredState();
  } catch (error) {
    console.warn(`State reload skipped: ${humanError(error)}`);
  }
}

function stateMtimeMs() {
  try {
    return statSync(STATE_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function readAbi(file) {
  return JSON.parse(readFileSync(path.join(ABI_DIR, file), "utf8"));
}

function readMaybeJson(file) {
  if (!file || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

function resolveMaybe(file) {
  if (!file) return "";
  return resolvePath(file, backendRoot);
}

function resolvePath(file, base) {
  return path.isAbsolute(file) ? file : path.resolve(base, file);
}

function sendOptions(req, res) {
  res.writeHead(204, corsHeaders(req));
  res.end();
}

function sendData(req, res, data) {
  return sendJson(req, res, 200, { ok: true, data, meta: meta() });
}

async function handleEthUsdPrice(req, res) {
  if (!USD_PRICING_ENABLED) {
    return sendJson(req, res, 503, { ok: false, error: "USD pricing is disabled.", meta: meta() });
  }
  try {
    let price;
    if (USD_PRICE_SERVICE_URL) {
      const response = await fetch(`${USD_PRICE_SERVICE_URL}/price`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(USD_PRICE_SERVICE_TIMEOUT_MS)
      });
      const body = await response.json();
      if (!response.ok || body?.ok !== true || !validEthUsdPrice(body.data)) {
        throw new Error("USD pricing service returned no valid price.");
      }
      price = body.data;
    } else if (USD_PRICE_RPC_URL) {
      price = await readEthUsdFromChainlink();
    } else {
      return sendJson(req, res, 503, { ok: false, error: "USD pricing needs USD_PRICE_RPC_URL or USD_PRICE_SERVICE_URL.", meta: meta() });
    }
    return sendData(req, res, price);
  } catch (error) {
    console.error(`USD pricing request failed: ${humanError(error)}`);
    return sendJson(req, res, 503, { ok: false, error: "USD pricing is temporarily unavailable.", meta: meta() });
  }
}

async function readEthUsdFromChainlink() {
  const now = Date.now();
  if (usdPriceCache && now - usdPriceCache.cachedAtMs < USD_PRICE_CACHE_MS) {
    return withCurrentPriceStaleness(usdPriceCache.data);
  }
  if (usdPricePromise) return usdPricePromise;
  usdPricePromise = (async () => {
    if (!usdPriceProvider) {
      usdPriceProvider = CHAIN_ID === 1 && USD_PRICE_RPC_URL === RPC_URL
        ? provider
        : new ethers.JsonRpcProvider(USD_PRICE_RPC_URL, 1, { batchMaxCount: 1 });
    }
    if (!usdPriceProvider) throw new Error("USD price RPC provider is unavailable.");
    const feed = new ethers.Contract(ETH_USD_FEED_ADDRESS, ETH_USD_FEED_ABI, usdPriceProvider);
    const [decimalsRaw, round] = await Promise.all([
      withRetry(() => feed.decimals(), "ETH/USD decimals", 2),
      withRetry(() => feed.latestRoundData(), "ETH/USD latest round", 2)
    ]);
    const decimals = Number(decimalsRaw);
    const roundId = BigInt(round.roundId);
    const answer = BigInt(round.answer);
    const answeredInRound = BigInt(round.answeredInRound);
    const startedAt = Number(round.startedAt);
    const updatedAt = Number(round.updatedAt);
    if (answer <= 0n || updatedAt <= 0 || answeredInRound < roundId) {
      throw new Error("Chainlink ETH/USD round is incomplete.");
    }
    const observedAt = Math.floor(Date.now() / 1_000);
    const data = {
      pair: "ETH/USD",
      price: ethers.formatUnits(answer, decimals),
      priceScaled: answer.toString(),
      decimals,
      roundId: roundId.toString(),
      answeredInRound: answeredInRound.toString(),
      oracleStartedAt: startedAt,
      oracleUpdatedAt: updatedAt,
      observedAt,
      stale: observedAt - updatedAt > USD_PRICE_STALE_SECONDS,
      source: "chainlink-mainnet",
      referenceNetwork: "ethereum-mainnet",
      feedAddress: ETH_USD_FEED_ADDRESS
    };
    if (!validEthUsdPrice(data)) throw new Error("Chainlink ETH/USD response is malformed.");
    usdPriceCache = { cachedAtMs: Date.now(), data };
    return data;
  })().finally(() => {
    usdPricePromise = null;
  });
  return usdPricePromise;
}

function withCurrentPriceStaleness(data) {
  const observedAt = Math.floor(Date.now() / 1_000);
  return {
    ...data,
    observedAt,
    stale: observedAt - Number(data.oracleUpdatedAt) > USD_PRICE_STALE_SECONDS
  };
}

function validEthUsdPrice(value) {
  return value?.pair === "ETH/USD"
    && typeof value.price === "string"
    && /^[0-9]+(?:\.[0-9]+)?$/.test(value.price)
    && typeof value.priceScaled === "string"
    && /^[0-9]+$/.test(value.priceScaled)
    && Number.isInteger(Number(value.decimals))
    && Number(value.decimals) >= 0
    && Number(value.decimals) <= 18
    && typeof value.roundId === "string"
    && /^[0-9]+$/.test(value.roundId)
    && typeof value.answeredInRound === "string"
    && /^[0-9]+$/.test(value.answeredInRound)
    && Number(value.oracleStartedAt) > 0
    && Number(value.oracleUpdatedAt) > 0
    && Number(value.observedAt) > 0
    && typeof value.stale === "boolean"
    && value.source === "chainlink-mainnet"
    && value.referenceNetwork === "ethereum-mainnet"
    && String(value.feedAddress || "").toLowerCase() === ETH_USD_FEED_ADDRESS;
}

function sendJson(req, res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS,
    ...corsHeaders(req)
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendInternalError(req, res, error) {
  console.error(`Request failed: ${humanError(error)}`);
  const body = { ok: false, error: "Internal server error" };
  if (process.env.EXPOSE_ERROR_DETAIL === "1") body.detail = humanError(error);
  return sendJson(req, res, 500, body);
}

function sendRateLimited(req, res, limited) {
  res.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": String(limited.retryAfterSeconds),
    "X-RateLimit-Limit": String(limited.limit),
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": String(limited.resetAt),
    ...SECURITY_HEADERS,
    ...corsHeaders(req)
  });
  res.end(`${JSON.stringify({
    ok: false,
    error: "Rate limit exceeded",
    retryAfterSeconds: limited.retryAfterSeconds
  }, null, 2)}\n`);
}

function sendLogoSvg(req, res, tokenAddress) {
  const file = ensureLogoSvgFile(tokenAddress);
  if (!existsSync(file)) return sendJson(req, res, 404, { ok: false, error: "Logo not found" });
  const { size } = statSync(file);
  if (size > MAX_LOGO_SVG_BYTES) return sendJson(req, res, 413, { ok: false, error: "Logo too large" });
  const svg = readFileSync(file, "utf8");
  if (!safeLogoSvg(svg)) return sendJson(req, res, 415, { ok: false, error: "Unsupported logo SVG" });
  res.writeHead(200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    ...SVG_SECURITY_HEADERS,
    ...corsHeaders(req)
  });
  res.end(svg);
}

function ensureLogoSvgFile(tokenAddress) {
  const file = path.join(LOGO_DIR, `${tokenAddress}.svg`);
  if (existsSync(file)) return file;
  const launch = Object.values(state.launches || {}).find((item) => item.token === tokenAddress);
  if (launch?.metadata?.logoSvgUri) writeLogoFile(tokenAddress, launch.metadata.logoSvgUri);
  return file;
}

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const allowAll = CORS_ALLOWED_ORIGINS.includes("*");
  const allowedOrigin = allowAll ? "*" : originAllowed(origin) ? (origin || "*") : "null";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...(allowAll ? {} : { "Vary": "Origin" })
  };
}

function originAllowed(origin) {
  if (!origin) return true;
  return CORS_ALLOWED_ORIGINS.includes("*") || CORS_ALLOWED_ORIGINS.includes(origin) || isLoopbackOrigin(origin);
}

function isLoopbackOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function storageWritable() {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    accessSync(existsSync(STATE_FILE) ? STATE_FILE : path.dirname(STATE_FILE), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function healthReady() {
  return storageWritable() && watchAddresses().length > 0 && !meta().stale;
}

function meta() {
  const staleThreshold = INDEX_SOURCE_MODE === "ws-logs" && wsLive
    ? Math.max(WS_GAP_BACKFILL_BLOCKS, CONFIRMATIONS + 2)
    : Math.max(5, CONFIRMATIONS + 2);
  const lastHeadMs = Date.parse(runtimeStats.lastHeadAt || runtimeStats.startedAt);
  const sourceTimeoutMs = Math.max(45_000, INDEX_POLL_MS * 3);
  const sourceStale = !INDEX_DISABLED && (!Number.isFinite(lastHeadMs) || Date.now() - lastHeadMs > sourceTimeoutMs);
  return {
    chainId: CHAIN_ID,
    latestBlock: state.latestBlock || 0,
    indexedToBlock: state.indexedToBlock || 0,
    stale: sourceStale || (state.latestBlock || 0) - (state.indexedToBlock || 0) > staleThreshold,
    sourceStale,
    sourceStaleMs: sourceTimeoutMs,
    generatedAt: new Date().toISOString()
  };
}

function rateLimitRequest(req) {
  if (HTTP_RATE_LIMIT_MAX <= 0) return null;
  const key = clientIp(req);
  const now = Date.now();
  const existing = rateLimitBuckets.get(key);
  const bucket = existing && existing.resetAt > now
    ? existing
    : { count: 0, resetAt: now + HTTP_RATE_LIMIT_WINDOW_MS };
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  if (bucket.count <= HTTP_RATE_LIMIT_MAX) return null;
  return {
    limit: HTTP_RATE_LIMIT_MAX,
    resetAt: Math.ceil(bucket.resetAt / 1000),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  };
}

function cleanupRateLimitBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (!bucket || bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
}

function clientIp(req) {
  if (TRUST_PROXY_HEADERS && isLoopbackAddress(req.socket?.remoteAddress)) {
    const cfIp = normalizeIp(firstHeader(req.headers["cf-connecting-ip"]));
    if (cfIp) return cfIp;
    const forwarded = firstHeader(req.headers["x-forwarded-for"])
      .split(",")
      .map((value) => normalizeIp(value))
      .find(Boolean);
    if (forwarded) return forwarded;
  }
  return normalizeIp(req.socket?.remoteAddress) || "unknown";
}

function isLoopbackAddress(value) {
  const ip = String(value || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1";
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : String(value || "");
}

function normalizeIp(value) {
  const ip = String(value || "").trim();
  return ip && ip.length <= 64 && isIP(ip) ? ip : "";
}

function optionalAddress(value) {
  if (!value) return "";
  try {
    return ethers.getAddress(value);
  } catch {
    return "";
  }
}

function requestUrl(req, fallback) {
  try {
    return new URL(req.url || fallback, `http://${req.headers.host || "127.0.0.1"}`);
  } catch {
    return null;
  }
}

function safeLogoSvg(svg) {
  const text = String(svg || "");
  if (Buffer.byteLength(text, "utf8") > MAX_LOGO_SVG_BYTES) return "";
  const lower = text.toLowerCase();
  if (lower.includes("<script") || lower.includes("javascript:") || /\son[a-z]+\s*=/.test(lower)) return "";
  return text;
}

function rejectUpgrade(socket, status, statusText, headers = {}) {
  const headerText = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\n${headerText ? `${headerText}\r\n` : ""}Connection: close\r\n\r\n`);
  socket.destroy();
}

function broadcast(event) {
  if (!ALLOW_NOISY_API_EVENTS && EXCLUDED_INGEST_EVENT_NAMES.has(event.eventName)) return;
  const data = JSON.stringify({ event: activityDto(event), meta: meta() });
  const silentByDefault = SILENT_REALTIME_EVENTS.has(event.eventName);
  for (const client of clients) {
    if (client.launch && !eventForLaunch(event, client.launch)) continue;
    if (silentByDefault && !client.includeNoisyEvents) continue;
    client.res.write(`event: activity\ndata: ${data}\n\n`);
  }
  const wsMessage = JSON.stringify({ type: "activity", data: { event: activityDto(event), meta: meta() } });
  for (const client of wsClients) {
    if (client.launch && !eventForLaunch(event, client.launch)) continue;
    if (silentByDefault && !client.includeNoisyEvents) continue;
    if (client.socket.readyState !== 1) {
      wsClients.delete(client);
      continue;
    }
    client.socket.send(wsMessage);
  }
}

function summaryObject() {
  return {
    chainId: CHAIN_ID,
    startBlock: state.startBlock,
    latestBlock: state.latestBlock,
    indexedToBlock: state.indexedToBlock,
    watchedAddresses: watchAddresses().length,
    launches: Object.keys(state.launches).length,
    lockers: Object.keys(state.lockers).length,
    events: state.events.length
  };
}

function summary() {
  return JSON.stringify(summaryObject(), null, 2);
}

function truthyParam(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function envInteger(name, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function parseCsvSet(value) {
  return new Set(String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean));
}

function rpcUsageSummary() {
  const uptimeSeconds = Math.max(1, Math.floor((Date.now() - Date.parse(runtimeStats.startedAt)) / 1000));
  const projectedDailyRequests = Math.round(runtimeStats.httpRequests / uptimeSeconds * 86400);
  return {
    provider: runtimeStats.provider,
    sourceMode: runtimeStats.sourceMode,
    startedAt: runtimeStats.startedAt,
    uptimeSeconds,
    httpRequests: runtimeStats.httpRequests,
    httpByMethod: runtimeStats.httpByMethod,
    projectedDailyRequests,
    dailyRequestLimit: RPC_DAILY_REQUEST_LIMIT || null,
    maxRequestsPerSecond: RPC_MAX_REQUESTS_PER_SECOND || null,
    wsHeads: runtimeStats.wsHeads,
    wsLogs: runtimeStats.wsLogs,
    backfills: runtimeStats.backfills,
    retryCount: runtimeStats.retryCount,
    lastBackfillAt: runtimeStats.lastBackfillAt,
    lastWsHeadAt: runtimeStats.lastWsHeadAt,
    lastWsLogAt: runtimeStats.lastWsLogAt,
    lastError: runtimeStats.lastError
  };
}

function publicRpcUsageSummary() {
  return {
    sourceMode: runtimeStats.sourceMode,
    httpRequests: runtimeStats.httpRequests,
    wsHeads: runtimeStats.wsHeads,
    wsLogs: runtimeStats.wsLogs,
    backfills: runtimeStats.backfills,
    lastHeadAt: runtimeStats.lastHeadAt,
    healthy: !runtimeStats.lastError
  };
}

async function rpcGetBlock(blockTag) {
  if (!provider) throw new Error("RPC provider is not configured");
  recordRpc("eth_getBlockByNumber");
  return provider.getBlock(blockTag);
}

async function rpcGetLogs(filter) {
  if (!provider) throw new Error("RPC provider is not configured");
  recordRpc("eth_getLogs");
  return provider.getLogs(filter);
}

async function rpcGetNetwork() {
  if (!provider) throw new Error("RPC provider is not configured");
  recordRpc("eth_chainId");
  return provider.getNetwork();
}

function recordRpc(method) {
  runtimeStats.httpRequests += 1;
  runtimeStats.httpByMethod[method] = (runtimeStats.httpByMethod[method] || 0) + 1;
}

function humanError(error) {
  const message = String(error?.shortMessage || error?.reason || error?.message || error || "Unknown error");
  if (message.includes("block range")) return "RPC block range issue; retry after the node catches up.";
  if (message.includes("request timeout")) return "RPC request timed out; retrying.";
  if (message.includes("could not coalesce")) return "RPC returned a provider error; retrying.";
  if (message.includes("rate limit")) return "RPC rate limit reached.";
  return message;
}

async function withRetry(fn, label, attempts = RPC_RETRY_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await throttleRpc();
      return await withTimeout(fn(), label);
    } catch (error) {
      lastError = error;
      const message = String(error?.shortMessage || error?.message || error);
      const retryable = message.includes("Too Many Requests")
        || message.includes("rate limit")
        || message.includes("missing response")
        || message.includes("request timeout")
        || message.includes("timed out")
        || message.includes("could not coalesce")
        || message.includes("UNKNOWN_ERROR")
        || message.includes("block range extends beyond current head block");
      if (!retryable || attempt === attempts) break;
      const delayMs = 750 * attempt * attempt;
      runtimeStats.retryCount += 1;
      runtimeStats.lastError = humanError(error);
      console.warn(`RPC retry ${attempt}/${attempts} for ${label}: ${humanError(error)}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function throttleRpc() {
  if (!(RPC_MAX_REQUESTS_PER_SECOND > 0)) return Promise.resolve();
  const intervalMs = Math.ceil(1_000 / RPC_MAX_REQUESTS_PER_SECOND);
  const slot = rpcThrottleQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, rpcNextRequestAt - now);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    rpcNextRequestAt = Date.now() + intervalMs;
  });
  rpcThrottleQueue = slot.catch(() => {});
  return slot;
}

async function withTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${RPC_CALL_TIMEOUT_MS}ms`)), RPC_CALL_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    if (process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function required(name) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
}

function reqOnClose(res, fn) {
  const cleanup = once(fn);
  res.on("close", cleanup);
  res.on("finish", cleanup);
}

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    return fn(...args);
  };
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pollTimer) clearInterval(pollTimer);
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  if (wsSafetyTimer) clearInterval(wsSafetyTimer);
  for (const client of clients) client.res.end();
  try {
    wsProvider?.destroy?.();
    if (usdPriceProvider && usdPriceProvider !== provider) usdPriceProvider.destroy?.();
    provider?.destroy?.();
  } finally {
    process.exit(0);
  }
}
