import { type JsonValue } from "./json.js";
export interface ManualClock {
  nowMs(): number;
  sleep(durationMs: number, options?: { signal?: AbortSignal }): Promise<void>;
  advance(durationMs: number): void;
}

export function createManualClock(startMs = 0): ManualClock {
  let nowMs = startMs;
  const sleepers: Array<{
    dueAtMs: number;
    resolve: () => void;
    reject: (error: JsonValue) => void;
    cleanup: () => void;
  }> = [];

  function sleep(durationMs: number, { signal }: { signal?: AbortSignal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    return new Promise<void>((resolve, reject) => {
      const entry = {
        dueAtMs: nowMs + Math.max(0, durationMs),
        resolve,
        reject,
        cleanup: () => {},
      };

      if (signal) {
        const onAbort = () => {
          remove(entry);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      sleepers.push(entry);
      flush();
    });
  }

  function advance(durationMs: number) {
    nowMs += Math.max(0, durationMs);
    flush();
  }

  function flush() {
    sleepers.sort((left, right) => left.dueAtMs - right.dueAtMs);

    for (let index = 0; index < sleepers.length; ) {
      const entry = sleepers[index];
      if (entry.dueAtMs > nowMs) {
        index += 1;
        continue;
      }

      sleepers.splice(index, 1);
      entry.cleanup();
      entry.resolve();
    }
  }

  function remove(entry: (typeof sleepers)[number]) {
    const index = sleepers.indexOf(entry);
    if (index >= 0) {
      sleepers.splice(index, 1);
    }
    entry.cleanup();
  }

  return {
    nowMs: () => nowMs,
    sleep,
    advance,
  };
}
