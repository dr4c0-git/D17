import { ethers } from "ethers";

// Free RPC plans cap requests per second, and their "too many requests" answers often
// reach the browser as an opaque network error. Every read provider of the app shares
// this queue: a few requests in flight at a time, and a failed transport is retried
// with a growing delay before the error is surfaced.
const MAX_IN_FLIGHT = 4;
const MAX_ATTEMPTS = 6;

let inFlight = 0;
const waiting: (() => void)[] = [];

async function acquire() {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else inFlight -= 1;
}

class QueuedJsonRpcProvider extends ethers.JsonRpcProvider {
  async _send(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]): Promise<ethers.JsonRpcResult[]> {
    await acquire();
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await super._send(payload);
        } catch (error) {
          // _send only throws on transport failures (JSON-RPC errors come back as results).
          if (attempt >= MAX_ATTEMPTS) throw error;
          await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
        }
      }
    } finally {
      release();
    }
  }
}

export function createReadProvider(url: string, chainId: number) {
  return new QueuedJsonRpcProvider(url, chainId, { batchMaxCount: 1, staticNetwork: true });
}
