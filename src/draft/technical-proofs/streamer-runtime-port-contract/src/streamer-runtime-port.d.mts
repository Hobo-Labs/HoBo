export type StreamerRunStatus = "completed" | "closed" | "failed";

export interface StreamerFrame<TChunk = unknown> {
  readonly runId: string;
  readonly seq: number;
  readonly stream: string;
  readonly chunk: TChunk;
}

export interface StreamerWritable<TChunk = unknown> {
  readonly stream: string;
  write(chunk: TChunk): Promise<void>;
}

export interface StreamerRunResult {
  readonly runId: string;
  readonly status: StreamerRunStatus;
  readonly reason: string;
}

export interface StreamerRunHandle<TChunk = unknown> {
  readonly runId: string;
  readonly readable: AsyncIterable<StreamerFrame<TChunk>>;
  getWritable<TWritableChunk = TChunk>(stream?: string): StreamerWritable<TWritableChunk>;
  readonly done: Promise<StreamerRunResult>;
}

export interface StreamerWorkflowContext<TChunk = unknown> {
  readonly runId: string;
  getWritable<TWritableChunk = TChunk>(stream?: string): StreamerWritable<TWritableChunk>;
}

export interface StreamerRuntime {
  readonly backend: "runtime-local";
  readonly contract: typeof STREAMER_RUNTIME_PORT_CONTRACT_VERSION;
  createRun<TChunk = unknown>(options?: { readonly runId?: string }): StreamerRunHandle<TChunk>;
  start<TChunk = unknown>(
    workflow: (ctx: StreamerWorkflowContext<TChunk>) => void | Promise<void>,
    options?: { readonly runId?: string },
  ): StreamerRunHandle<TChunk>;
  teardownRun(runId: string, reason?: string): StreamerRunResult;
}

export interface StreamerConformanceReport {
  readonly contract: typeof STREAMER_RUNTIME_PORT_CONTRACT_VERSION;
  readonly backend: "runtime-local";
  readonly assertions: {
    readonly orderedRunReadable: "pass";
    readonly startReturnsReadable: "pass";
    readonly multiplexedStreamsOrdered: "pass";
    readonly boundedBackpressure: "pass";
    readonly teardownClosesStream: "pass";
  };
}

export declare const STREAMER_RUNTIME_PORT_CONTRACT_VERSION: "hobo.streamer-runtime-port/v1";
export declare class StreamerBackpressureError extends Error {
  readonly code: "STREAMER_BACKPRESSURE";
  readonly runId: string;
  readonly bufferLimit: number;
  constructor(input: { readonly runId: string; readonly bufferLimit: number });
}
export declare class StreamerClosedError extends Error {
  readonly code: "STREAMER_CLOSED";
  readonly runId: string;
  constructor(input: { readonly runId: string });
}
export declare function createRuntimeLocalStreamer(options?: {
  readonly bufferLimit?: number;
  readonly runIdPrefix?: string;
}): StreamerRuntime;
export declare function runStreamerConformance(
  createRuntime: () => StreamerRuntime,
): Promise<StreamerConformanceReport>;
