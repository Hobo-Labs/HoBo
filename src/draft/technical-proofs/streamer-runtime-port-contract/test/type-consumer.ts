import type {
  StreamerFrame,
  StreamerRunHandle,
  StreamerWritable,
} from "../src/streamer-runtime-port.d.mts";
import type * as StreamerRuntimePort from "../src/streamer-runtime-port.d.mts";

declare const createRuntimeLocalStreamer: typeof StreamerRuntimePort.createRuntimeLocalStreamer;

interface UiChunk {
  readonly kind: "delta";
  readonly text: string;
}

interface LogChunk {
  readonly level: "info" | "warn";
  readonly message: string;
}

async function assertGenericStreamerTypes() {
  const runtime = createRuntimeLocalStreamer({ bufferLimit: 2, runIdPrefix: "run:typed" });
  const run = runtime.createRun<UiChunk | LogChunk>({ runId: "run:typed-1" });

  const ui = run.getWritable<UiChunk>("ui");
  await ui.write({ kind: "delta", text: "hello" });

  // @ts-expect-error ui stream only accepts UiChunk payloads.
  await ui.write({ level: "info", message: "wrong stream" });

  const logs: StreamerWritable<LogChunk> = run.getWritable<LogChunk>("logs");
  await logs.write({ level: "info", message: "started" });

  for await (const frame of run.readable) {
    const typedFrame: StreamerFrame<UiChunk | LogChunk> = frame;
    const chunk: UiChunk | LogChunk = typedFrame.chunk;

    // @ts-expect-error readable chunk is the declared union, not an arbitrary string.
    const text: string = chunk;
    void text;
    break;
  }

  const started: StreamerRunHandle<UiChunk> = runtime.start<UiChunk>(async (ctx) => {
    const output = ctx.getWritable<UiChunk>("ui");
    await output.write({ kind: "delta", text: ctx.runId });

    // @ts-expect-error start workflow ctx preserves getWritable<T> payload typing.
    await output.write({ level: "warn", message: "not a UI chunk" });
  });

  const done = await started.done;
  const status: "completed" | "closed" | "failed" = done.status;
  void status;
}

void assertGenericStreamerTypes;
