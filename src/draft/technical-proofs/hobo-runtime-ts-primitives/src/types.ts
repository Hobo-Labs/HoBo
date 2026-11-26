import type { Workflow } from "./workflow.js";
import { type JsonValue } from "./json.js";


export type ArgsOf<W> = W extends Workflow<infer A, unknown> ? A : never;

export interface RunHandle {
  runId: string;
  readable: ReadableStream<JsonValue>;
}

export interface Message {
  type: string;
  payload: JsonValue;
  idempotencyKey?: string;
}

export type MessageMap<S> = Record<
  string,
  (state: S, message: Message, ctx: { emit: (type: string, data: JsonValue) => Promise<number> }) => S | Promise<S>
>;

export interface ActorKey {
  actor: string;
  id: string;
}

export interface StepOpts {
  retries?: number;
  timeout?: string;
  idempotencyKey?: string;
}

export interface Hook<T = unknown> {
  token: string;
  wait(): Promise<T>;
}

export interface Webhook {
  hook: Hook<JsonValue>;
  route: string;
}

export interface CronSchedule {
  expr: string;
}

export type StepFn<A extends unknown[], O> = (...args: A) => Promise<O>;

export interface StepRecord {
  stepKey: string;
  idempotencyKey: string;
  result?: JsonValue;
  failed?: { message: string; attempts: number };
}
