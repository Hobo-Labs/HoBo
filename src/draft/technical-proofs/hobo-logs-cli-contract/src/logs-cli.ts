import { isJsonString, isJsonObject } from "./json.js";
export const HOBO_LOGS_CLI_CONTRACT_VERSION = "hobo.logs-cli/v1";

export class LogsCliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "LogsCliError";
    this.exitCode = exitCode;
  }
}

export function createHoboLogsCli({ streamer }) {
  if (!streamer || !(streamer.openLogStream instanceof Function)) {
    throw new TypeError("logs CLI requires a Streamer-backed log source");
  }

  return Object.freeze({
    async run(argv, runOptions = {}) {
      try {
        const request = parseLogsArgv(argv);
        const logStream = streamer.openLogStream({
          follow: request.follow,
          resource: request.resource,
          sinceSeq: request.sinceSeq,
          tail: request.tail,
          signal: runOptions.signal,
        });
        const lines = [];

        for await (const frame of logStream) {
          lines.push(request.json ? renderJsonLine(frame) : renderHumanLine(frame));
        }

        return {
          exitCode: 0,
          stdout: lines.join(""),
          stderr: "",
        };
      } catch (error) {
        return renderError(error);
      }
    },
  });
}

export function createRuntimeLogStreamer(options = {}) {
  const resources = new Set((options.resources ?? []).map((resource) => normalizeString(resource, "resource")));
  const subscriberQueueLimit = normalizePositiveInteger(options.subscriberQueueLimit ?? 1000, "subscriberQueueLimit");
  const frames = [];
  const subscribers = new Map();
  let nextSeq = 1;
  let nextSubscriberId = 1;

  function append(entry) {
    const frame = normalizeFrame(entry, nextSeq++);
    resources.add(frame.resource);
    frames.push(frame);

    for (const subscriber of subscribers.values()) {
      if (matchesResource(frame, subscriber.resource)) {
        enqueueSubscriberFrame(subscriber, frame);
      }
    }

    return clone(frame);
  }

  function openLogStream(request = {}) {
    const resource = request.resource ? normalizeString(request.resource, "resource") : null;
    if (resource && !resources.has(resource)) {
      throw new LogsCliError(`Unknown log resource "${resource}".`, 2);
    }

    const history = selectHistory({
      frames,
      resource,
      sinceSeq: request.sinceSeq,
      tail: request.tail,
    });

    if (!request.follow) {
      return finiteLogStream(history);
    }

    const subscriber = createSubscriber({
      id: `logs-sub-${nextSubscriberId++}`,
      resource,
      history,
      signal: request.signal,
    });
    subscribers.set(subscriber.id, subscriber);
    if (request.signal?.aborted) {
      closeSubscriber(subscriber, "aborted");
    } else {
      request.signal?.addEventListener("abort", () => closeSubscriber(subscriber, "aborted"), {
        once: true,
      });
    }

    return liveLogStream(subscriber);
  }

  function disconnectActiveSubscriptions(reason = "stream disconnected") {
    const marker = {
      kind: "gap",
      reason,
      dropped: 0,
      reconnecting: true,
    };
    for (const subscriber of subscribers.values()) {
      enqueueGap(subscriber, marker);
    }
  }

  function activeSubscriptions() {
    return subscribers.size;
  }

  function closeSubscriber(subscriber, reason) {
    if (subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    subscriber.closeReason = reason;
    subscribers.delete(subscriber.id);
    for (const resolve of subscriber.waiters.splice(0)) {
      resolve({ done: true });
    }
  }

  return Object.freeze({
    contract: HOBO_LOGS_CLI_CONTRACT_VERSION,
    activeSubscriptions,
    append,
    disconnectActiveSubscriptions,
    openLogStream,
  });

  function createSubscriber({ id, resource, history, signal }) {
    return {
      id,
      resource,
      signal,
      queue: history.map(clone),
      waiters: [],
      closed: false,
      closeReason: undefined,
      maxQueue: subscriberQueueLimit,
    };
  }

  function enqueueSubscriberFrame(subscriber, frame) {
    enqueueBounded(subscriber, clone(frame), {
      kind: "gap",
      reason: "client backpressure",
      dropped: 1,
      reconnecting: true,
    });
  }

  function enqueueGap(subscriber, marker) {
    enqueueBounded(subscriber, clone(marker), marker);
  }

  function enqueueBounded(subscriber, value, gapMarker) {
    if (subscriber.closed) {
      return;
    }

    const waiter = subscriber.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }

    if (subscriber.queue.length < subscriber.maxQueue) {
      subscriber.queue.push(value);
      return;
    }

    const last = subscriber.queue.at(-1);
    if (last?.kind === "gap") {
      last.dropped = (last.dropped ?? 0) + (gapMarker.dropped ?? 1);
      last.reason = gapMarker.reason;
      last.reconnecting = true;
      return;
    }

    subscriber.queue[subscriber.queue.length - 1] = {
      ...clone(gapMarker),
      dropped: gapMarker.dropped ?? 1,
      reconnecting: true,
    };
  }

  function liveLogStream(subscriber) {
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (subscriber.queue.length > 0) {
              return {
                value: subscriber.queue.shift(),
                done: false,
              };
            }
            if (subscriber.closed) {
              return { value: undefined, done: true };
            }

            return new Promise((resolve) => {
              subscriber.waiters.push(resolve);
            });
          },
          async return() {
            closeSubscriber(subscriber, "iterator-returned");
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

function finiteLogStream(history) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of history) {
        yield clone(frame);
      }
    },
  };
}

function parseLogsArgv(argv) {
  const request = {
    follow: false,
    json: false,
    resource: null,
    sinceSeq: 0,
    tail: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--follow") {
      request.follow = true;
      continue;
    }
    if (token === "--json") {
      request.json = true;
      continue;
    }
    if (token === "--tail") {
      request.tail = parsePositiveFlag(argv[++index], "--tail");
      continue;
    }
    if (token === "--since") {
      request.sinceSeq = parseNonNegativeFlag(argv[++index], "--since");
      continue;
    }
    if (token?.startsWith("-")) {
      throw new LogsCliError(`Unknown logs option "${token}".`, 2);
    }
    if (request.resource) {
      throw new LogsCliError("logs accepts at most one resource filter.", 2);
    }
    request.resource = normalizeString(token, "resource");
  }

  return request;
}

function selectHistory({ frames, resource, sinceSeq = 0, tail = null }) {
  const selected = frames.filter(
    (frame) => frame.seq > sinceSeq && matchesResource(frame, resource),
  );
  if (tail == null) {
    return selected.map(clone);
  }
  return selected.slice(-tail).map(clone);
}

function normalizeFrame(entry, seq) {
  return {
    kind: "log",
    seq,
    timestampMs: entry.timestampMs ?? seq,
    runId: normalizeString(entry.runId, "runId"),
    resource: normalizeString(entry.resource, "resource"),
    level: normalizeLevel(entry.level ?? "info"),
    message: String(entry.message ?? ""),
    fields: clone(entry.fields ?? {}),
  };
}

function matchesResource(frame, resource) {
  return !resource || frame.resource === resource;
}

function renderJsonLine(frame) {
  if (frame.kind === "gap") {
    return `${JSON.stringify({
      type: "log.gap",
      reason: frame.reason,
      dropped: frame.dropped,
      reconnecting: Boolean(frame.reconnecting),
    })}\n`;
  }
  return `${JSON.stringify({
    type: "log.line",
    seq: frame.seq,
    runId: frame.runId,
    resource: frame.resource,
    level: frame.level,
    message: frame.message,
    fields: frame.fields,
  })}\n`;
}

function renderHumanLine(frame) {
  if (frame.kind === "gap") {
    const dropped = frame.dropped ? ` dropped=${frame.dropped}` : "";
    return `--- log gap: ${frame.reason}; reconnecting${dropped} ---\n`;
  }
  return `${frame.seq} ${frame.level} ${frame.resource} ${frame.message}\n`;
}

function renderError(error) {
  if (error instanceof LogsCliError) {
    return {
      exitCode: error.exitCode,
      stdout: "",
      stderr: `${error.message}\n`,
    };
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: "Internal logs error.\n",
  };
}

function parsePositiveFlag(value, flag) {
  return normalizePositiveInteger(Number(value), flag);
}

function parseNonNegativeFlag(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new LogsCliError(`${flag} must be a non-negative integer.`, 2);
  }
  return parsed;
}

function normalizePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LogsCliError(`${label} must be a positive integer.`, 2);
  }
  return value;
}

function normalizeLevel(level) {
  const normalized = String(level).toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(normalized)) {
    throw new LogsCliError("level must be one of debug, info, warn, error.", 2);
  }
  return normalized;
}

function normalizeString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new LogsCliError(`${label} must be a non-empty string.`, 2);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}
