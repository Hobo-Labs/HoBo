import { type JsonValue } from "./json.js";
// domain-view: parse-produced draft-proof record; its wire form is the TriggerFiredEvent proto message in data-models/.
export interface TriggerFiredEvent {
  readonly type: "trigger.Fired";
  readonly triggerId: string;
  readonly kind: string;
  readonly resource: string;
  readonly handler: string;
  readonly success: boolean;
}

export interface LocalEventStore {
  append(event: TriggerFiredEvent): void;
  readonly events: readonly TriggerFiredEvent[];
}

export function createLocalEventStore(): LocalEventStore {
  const events: TriggerFiredEvent[] = [];
  return Object.freeze({
    append(event: TriggerFiredEvent) {
      events.push(Object.freeze({ ...event }));
    },
    get events() {
      return Object.freeze([...events]);
    },
  });
}

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: JsonValue;
  readonly params?: Record<string, string>;
}

export interface HttpResponse {
  readonly status: number;
  readonly body?: JsonValue;
}

export interface LocalHttpPort {
  register(method: string, path: string, handler: (req: HttpRequest) => Promise<HttpResponse>): void;
  handle(req: HttpRequest): Promise<HttpResponse>;
}

export function createLocalHttpPort(): LocalHttpPort {
  const routes = new Map<string, (req: HttpRequest) => Promise<HttpResponse>>();
  return Object.freeze({
    register(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    async handle(req) {
      const key = `${req.method} ${req.path}`;
      const handler = routes.get(key);
      if (!handler) {
        return { status: 404 };
      }
      return handler(req);
    },
  });
}

export interface LocalSchedulerPort {
  scheduleEvery(resource: string, spec: string, handler: () => Promise<void> | void): void;
  scheduleCron(resource: string, expression: string, handler: () => Promise<void> | void): void;
  tick(resource: string): Promise<void>;
}

export function createLocalSchedulerPort(): LocalSchedulerPort {
  const handlers = new Map<string, () => Promise<void> | void>();
  return Object.freeze({
    scheduleEvery(resource, _spec, handler) {
      handlers.set(resource, handler);
    },
    scheduleCron(resource, _expression, handler) {
      handlers.set(resource, handler);
    },
    async tick(resource) {
      const handler = handlers.get(resource);
      if (handler) {
        await handler();
      }
    },
  });
}

export interface LocalMessagingPort {
  subscribe(resource: string, eventType: string, handler: (payload: JsonValue) => Promise<void> | void): void;
  publish(resource: string, eventType: string, payload: JsonValue): Promise<void>;
}

export function createLocalMessagingPort(): LocalMessagingPort {
  const subscribers = new Map<string, (payload: JsonValue) => Promise<void> | void>();
  return Object.freeze({
    subscribe(resource, eventType, handler) {
      subscribers.set(`${resource}:${eventType}`, handler);
    },
    async publish(resource, eventType, payload) {
      const handler = subscribers.get(`${resource}:${eventType}`) ?? subscribers.get(`${resource}:*`);
      if (handler) {
        await handler(payload);
      }
    },
  });
}

export interface LocalBlobStorePort {
  on(resource: string, event: string, handler: (key: string) => Promise<void> | void): void;
  write(resource: string, key: string, value: JsonValue): Promise<void>;
}

export function createLocalBlobStorePort(): LocalBlobStorePort {
  const handlers = new Map<string, (key: string) => Promise<void> | void>();
  const objects = new Map<string, unknown>();
  return Object.freeze({
    on(resource, event, handler) {
      handlers.set(`${resource}:${event}`, handler);
    },
    async write(resource, key, value) {
      objects.set(`${resource}:${key}`, value);
      const handler = handlers.get(`${resource}:write`);
      if (handler) {
        await handler(key);
      }
    },
  });
}

export interface QueueMessage {
  readonly messageId: string;
  readonly body: JsonValue;
}

export interface LocalQueuePort {
  worker(resource: string, handler: (message: QueueMessage) => Promise<void> | void): void;
  enqueue(resource: string, body: JsonValue): Promise<void>;
  readonly completed: readonly string[];
}

export function createLocalQueuePort(): LocalQueuePort {
  const queues = new Map<string, QueueMessage[]>();
  const workers = new Map<string, (message: QueueMessage) => Promise<void> | void>();
  const completed: string[] = [];
  let nextId = 1;

  return Object.freeze({
    worker(resource, handler) {
      workers.set(resource, handler);
    },
    async enqueue(resource, body) {
      const queue = queues.get(resource) ?? [];
      const message = { messageId: `msg-${nextId++}`, body };
      queue.push(message);
      queues.set(resource, queue);
      const worker = workers.get(resource);
      if (worker) {
        await worker(message);
        completed.push(message.messageId);
      }
    },
    get completed() {
      return Object.freeze([...completed]);
    },
  });
}

export interface RuntimeLocalPorts {
  readonly http: LocalHttpPort;
  readonly scheduler: LocalSchedulerPort;
  readonly messaging: LocalMessagingPort;
  readonly blobStore: LocalBlobStorePort;
  readonly queue: LocalQueuePort;
}

export function createRuntimeLocalPorts(): RuntimeLocalPorts {
  return Object.freeze({
    http: createLocalHttpPort(),
    scheduler: createLocalSchedulerPort(),
    messaging: createLocalMessagingPort(),
    blobStore: createLocalBlobStorePort(),
    queue: createLocalQueuePort(),
  });
}
