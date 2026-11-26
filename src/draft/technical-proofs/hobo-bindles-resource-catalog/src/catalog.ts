const catalogRows = [
  ["api", ["wasi:http", "hobo:http"], []],
  ["kv", ["wasi:keyvalue"], ["get", "set", "delete"]],
  ["cache", ["hobo:cache"], ["get", "set", "delete", "invalidate"]],
  ["bucket", ["wasi:blobstore", "hobo:blob-events"], ["read", "write", "delete"]],
  ["queue", ["hobo:queue"], ["enqueue", "dequeue"]],
  ["topic", ["wasi:messaging"], ["publish", "subscribe"]],
  ["secret", ["wasi:config", "hobo:secrets"], ["put", "access"]],
  ["data", ["hobo:data"], ["read", "write", "query", "admin"]],
  ["schedule", ["hobo:scheduler"], []],
  ["websocket", ["wasi:websocket", "hobo:websocket"], ["accept", "connect", "send", "broadcast", "subscribe"]],
  ["job", ["hobo:job"], ["submit"]],
  ["web", ["wasi:http"], []],
  ["service", ["wasi:http"], []],
  ["flag", ["hobo:feature-flag"], ["eval", "change"]],
  ["auth", ["hobo:auth"], ["verify", "session"]],
  ["crypto", ["hobo:crypto"], ["encrypt", "decrypt", "sign", "verify"]],
  ["notify", ["hobo:notify"], ["send"]],
  ["guardrail", ["hobo:guardrail"], ["check"]],
  ["ui", ["hobo:ui-render"], ["render", "drive"]],
  ["experiment", ["hobo:experiment"], ["assign", "expose", "analyze"]]
];

export const CATALOG = Object.freeze(
  catalogRows.map(([factory, portRef, allowVerbs]) =>
    Object.freeze({
      factory,
      portRef: Object.freeze([...portRef]),
      allowVerbs: Object.freeze([...allowVerbs])
    })
  )
);

const catalogByFactory = new Map(CATALOG.map((entry) => [entry.factory, entry]));

export function catalogFactoryNames() {
  return CATALOG.map((entry) => entry.factory);
}

function requireResourceName(factory, name) {
  if (!isNonEmptyString(name)) {
    throw new TypeError(`${factory} resource name must be a non-empty string`);
  }
}

function makeLoweringDescriptor(handle, verb, args) {
  return Object.freeze({
    lowersTo: "hobo:sdk",
    kind: handle.kind,
    name: handle.name,
    handleStableId: handle.stableId,
    portRef: handle.portRef,
    verb,
    args: Object.freeze([...args])
  });
}

function createHandle(entry, name, declaredAllow = []) {
  requireResourceName(entry.factory, name);

  const stableId = `${entry.factory}:${name}`;
  const handle = {
    kind: entry.factory,
    name,
    portRef: entry.portRef,
    allowVerbs: entry.allowVerbs,
    allowVerbsType: `${entry.factory}.allow`,
    stableId,
    identity: Object.freeze({ kind: entry.factory, name, stableId }),
    declaredAllow: Object.freeze([...declaredAllow]),
    allow(...verbs) {
      for (const verb of verbs) {
        if (!entry.allowVerbs.includes(verb)) {
          throw new TypeError(`${entry.factory} does not allow verb "${verb}"`);
        }
      }
      return createHandle(entry, name, verbs);
    },
    toDescriptor() {
      return Object.freeze({
        kind: entry.factory,
        name,
        stableId,
        portRef: entry.portRef,
        allowVerbs: entry.allowVerbs,
        declaredAllow: this.declaredAllow
      });
    }
  };

  for (const verb of entry.allowVerbs) {
    Object.defineProperty(handle, verb, {
      enumerable: true,
      value: (...args) => makeLoweringDescriptor(handle, verb, args)
    });
  }

  return Object.freeze(handle);
}

function makeFactory(factory) {
  const entry = catalogByFactory.get(factory);
  if (!entry) {
    throw new Error(`unknown catalog factory: ${factory}`);
  }
  return (name) => createHandle(entry, name);
}

export const api = makeFactory("api");
export const kv = makeFactory("kv");
export const cache = makeFactory("cache");
export const bucket = makeFactory("bucket");
export const queue = makeFactory("queue");
export const topic = makeFactory("topic");
export const secret = makeFactory("secret");
export const data = makeFactory("data");
export const schedule = makeFactory("schedule");
export const websocket = makeFactory("websocket");
export const job = makeFactory("job");
export const web = makeFactory("web");
export const service = makeFactory("service");
export const flag = makeFactory("flag");
export const auth = makeFactory("auth");
export const crypto = makeFactory("crypto");
export const notify = makeFactory("notify");
export const guardrail = makeFactory("guardrail");
export const ui = makeFactory("ui");
export const experiment = makeFactory("experiment");

export function secretRef(ref) {
  if (!isNonEmptyString(ref)) {
    throw new TypeError("secretRef value reference must be a non-empty string");
  }

  return Object.freeze({
    kind: "secret-ref",
    ref,
    catalogFactory: false,
    portRef: "wasi:config/hobo:secrets",
    stableId: `secret-ref:${ref}`,
    lowersTo: "hobo:sdk"
  });
}

function isNonEmptyString(value) {
  return Object.prototype.toString.call(value) === "[object String]" && value.length > 0;
}
