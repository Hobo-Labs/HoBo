import type { ConfigContract } from "../bindles/types.js";
import { createConfigContext } from "./context.js";
import type { ConfigResolver } from "./resolver.js";
import type { EventStore, PersistedEvent } from "./event-store.js";
import { scrubAtCapture } from "./redaction.js";
import { type JsonObject } from "../json.js";


export type RuntimeCtx<TContract extends ConfigContract> = {
  readonly config: ReturnType<typeof createConfigContext<TContract>>["config"];
  readonly log: (message: string, fields?: JsonObject) => void;
  readonly emit: (type: string, data: JsonObject) => void;
  readonly stream: (frame: JsonObject) => void;
  readonly eventStore: EventStore;
  readonly logs: readonly string[];
  readonly spans: readonly JsonObject[];
  readonly streamFrames: readonly JsonObject[];
};

export function createRuntimeCtx<TContract extends ConfigContract>(options: {
  readonly contract: TContract;
  readonly resolver: ConfigResolver;
  readonly eventStore: EventStore;
}): RuntimeCtx<TContract> {
  const { config } = createConfigContext(options.contract, options.resolver);
  const logs: string[] = [];
  const spans: JsonObject[] = [];
  const streamFrames: JsonObject[] = [];

  return {
    config,
    eventStore: options.eventStore,
    logs,
    spans,
    streamFrames,
    log(message: string, fields: JsonObject = {}) {
      const line = scrubAtCapture({ message, ...fields });
      logs.push(JSON.stringify(line));
    },
    emit(type: string, data: JsonObject) {
      // SAFETY: assertion to `const event = scrubAtCapture({` is required at this boundary.
      const event = scrubAtCapture({
        type,
        id: `evt-${type}-${logs.length + spans.length + 1}`,
        data,
      }) as PersistedEvent;
      options.eventStore.append(event);
    },
    stream(frame: JsonObject) {
      streamFrames.push(scrubAtCapture(frame));
      spans.push(scrubAtCapture({ name: "stream.frame", attributes: frame }));
    },
  };
}
