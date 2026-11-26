import type { TriggerEdge } from "./triggers.js";
import type {
  HttpRequest,
  HttpResponse,
  LocalEventStore,
  RuntimeLocalPorts,
  TriggerFiredEvent,
} from "./runtime-ports.js";
import { isJsonObject, type JsonValue } from "./json.js";


export interface ParsedManifest {
  readonly schema: "hobo.manifest/v1";
  readonly triggerEdges?: readonly TriggerEdge[];
}

export interface HandlerRegistry {
  readonly get: (name: string) => ((ctx: JsonValue) => JsonValue | Promise<JsonValue>) | undefined;
}

export interface TriggerDispatcherOptions {
  readonly manifest: ParsedManifest;
  readonly ports: RuntimeLocalPorts;
  readonly eventStore: LocalEventStore;
  readonly handlers: HandlerRegistry;
}

export class TriggerDispatcher {
  readonly #manifest: ParsedManifest;
  readonly #ports: RuntimeLocalPorts;
  readonly #eventStore: LocalEventStore;
  readonly #handlers: HandlerRegistry;

  constructor(options: TriggerDispatcherOptions) {
    this.#manifest = options.manifest;
    this.#ports = options.ports;
    this.#eventStore = options.eventStore;
    this.#handlers = options.handlers;
  }

  wire(): void {
    const edges = this.#manifest.triggerEdges ?? [];
    for (const edge of edges) {
      this.#wireEdge(edge);
    }
  }

  async handleHttp(request: HttpRequest): Promise<HttpResponse> {
    return this.#ports.http.handle(request);
  }

  async tickSchedule(resource: string): Promise<void> {
    await this.#ports.scheduler.tick(resource);
  }

  async publishTopic(resource: string, eventType: string, payload: JsonValue): Promise<void> {
    await this.#ports.messaging.publish(resource, eventType, payload);
  }

  async writeBucket(resource: string, key: string, value: JsonValue): Promise<void> {
    await this.#ports.blobStore.write(resource, key, value);
  }

  async enqueueQueue(resource: string, body: JsonValue): Promise<void> {
    await this.#ports.queue.enqueue(resource, body);
  }

  get firedEvents(): readonly TriggerFiredEvent[] {
    return this.#eventStore.events;
  }

  #wireEdge(edge: TriggerEdge): void {
    switch (edge.kind) {
      case "http.route":
        this.#wireHttpRoute(edge);
        break;
      case "topic.subscribe":
        this.#wireTopicSubscribe(edge);
        break;
      case "schedule.cron":
      case "schedule.every":
        this.#wireSchedule(edge);
        break;
      case "bucket.on":
        this.#wireBucketOn(edge);
        break;
      case "queue.worker":
        this.#wireQueueWorker(edge);
        break;
      default:
        // SAFETY: assertion to `throw new Error(unsupported trigger kind: ${(edge as TriggerEdge).kind});` is required at this boundary.
        throw new Error(`unsupported trigger kind: ${(edge as TriggerEdge).kind}`);
    }
  }

  #wireHttpRoute(edge: TriggerEdge): void {
    const handler = this.#handlers.get(edge.handler);
    if (!handler) {
      return;
    }
    this.#ports.http.register(edge.method!, edge.path!, async (req) => {
      try {
        const result = await handler({
          params: req.params ?? {},
          json: async () => req.body,
          body: req.body,
          bindings: {},
          config: {},
        });
        this.#emitFired(edge, true);
        if (result && isJsonObject(result) && "status" in result) {
          // SAFETY: assertion to `return result as HttpResponse;` is required at this boundary.
          return result as HttpResponse;
        }
        return { status: 200, body: result };
      } catch {
        this.#emitFired(edge, false);
        return { status: 500 };
      }
    });
  }

  #wireTopicSubscribe(edge: TriggerEdge): void {
    const handler = this.#handlers.get(edge.handler);
    if (!handler) {
      return;
    }
    this.#ports.messaging.subscribe(edge.resource, edge.event ?? "*", async (payload) => {
      try {
        await handler({
          params: {},
          json: async () => payload,
          body: payload,
          bindings: {},
          config: {},
        });
        this.#emitFired(edge, true);
      } catch {
        this.#emitFired(edge, false);
      }
    });
  }

  #wireSchedule(edge: TriggerEdge): void {
    const handler = this.#handlers.get(edge.handler);
    if (!handler) {
      return;
    }
    const invoke = async () => {
      try {
        await handler({
          params: {},
          json: async () => undefined,
          body: undefined,
          bindings: {},
          config: {},
        });
        this.#emitFired(edge, true);
      } catch {
        this.#emitFired(edge, false);
      }
    };
    if (edge.kind === "schedule.every") {
      this.#ports.scheduler.scheduleEvery(edge.resource, edge.every!, invoke);
    } else {
      this.#ports.scheduler.scheduleCron(edge.resource, edge.cron!, invoke);
    }
  }

  #wireBucketOn(edge: TriggerEdge): void {
    const handler = this.#handlers.get(edge.handler);
    if (!handler) {
      return;
    }
    this.#ports.blobStore.on(edge.resource, edge.event!, async (key) => {
      try {
        await handler({
          params: { key },
          json: async () => ({ key }),
          body: { key },
          bindings: {},
          config: {},
        });
        this.#emitFired(edge, true);
      } catch {
        this.#emitFired(edge, false);
      }
    });
  }

  #wireQueueWorker(edge: TriggerEdge): void {
    const handler = this.#handlers.get(edge.handler);
    if (!handler) {
      return;
    }
    this.#ports.queue.worker(edge.resource, async (message) => {
      try {
        await handler({
          params: {},
          json: async () => message.body,
          body: message.body,
          bindings: {},
          config: {},
        });
        this.#emitFired(edge, true);
      } catch {
        this.#emitFired(edge, false);
      }
    });
  }

  #emitFired(edge: TriggerEdge, success: boolean): void {
    this.#eventStore.append({
      type: "trigger.Fired",
      triggerId: edge.id,
      kind: edge.kind,
      resource: edge.resource,
      handler: edge.handler,
      success,
    });
  }
}
