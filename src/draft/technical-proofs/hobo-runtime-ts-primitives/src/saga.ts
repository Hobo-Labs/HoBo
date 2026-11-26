import type { RegisteredSaga } from "./testing/test-runtime.js";
import type { SagaCtx } from "./ctx.js";
import { type JsonValue } from "./json.js";


export interface SagaBuilder {
  on(eventType: string, handler: (event: JsonValue, ctx: SagaCtx) => Promise<void> | void): SagaBuilder;
  compensate(
    eventType: string,
    handler: (event: JsonValue, ctx: SagaCtx) => Promise<void> | void,
  ): SagaBuilder;
  build(): RegisteredSaga;
}

export function saga(name: string): SagaBuilder {
  const handlers = new Map<string, (event: JsonValue, ctx: SagaCtx) => Promise<void> | void>();
  const compensations = new Map<string, (event: JsonValue, ctx: SagaCtx) => Promise<void> | void>();

  const builder: SagaBuilder = {
    on(eventType, handler) {
      handlers.set(eventType, handler);
      return builder;
    },
    compensate(eventType, handler) {
      compensations.set(eventType, handler);
      return builder;
    },
    build() {
      return {
        name,
        handlers: new Map(
          [...handlers.entries()].map(([type, handler]) => [
            type,
            async (event, ctx) => {
              await handler(event.data, {
                runId: String(event.runId),
                seq: event.seq,
                bindings: {},
                emit: ctx.emit,
              });
            },
          ]),
        ),
        compensations: new Map(
          [...compensations.entries()].map(([type, handler]) => [
            type,
            async (event, ctx) => {
              await handler(event.data, {
                runId: String(event.runId),
                seq: event.seq,
                bindings: {},
                emit: ctx.emit,
              });
            },
          ]),
        ),
      };
    },
  };

  return builder;
}

export async function emit(_type: string, _data: JsonValue): Promise<number> {
  throw new Error("emit() requires an active runtime; use testRuntime().emit in tests or start() in production");
}
