import type { StepOpts } from "./types.js";
import type { Hook } from "./types.js";
import { stableIdempotencyKey } from "./engine/events.js";
import { type JsonValue } from "./json.js";


let activeRunContext: RunContextBinding | undefined;

export interface RunContextBinding {
  step<O>(stepKey: string, fn: () => Promise<O>, opts?: StepOpts): Promise<O>;
  sleep(duration: string | number): Promise<void>;
  createHook<T>(name?: string): Hook<T>;
  emit(type: string, data: JsonValue): Promise<number>;
}

export function bindRunContext<T>(ctx: RunContextBinding, callback: () => Promise<T>): Promise<T> {
  const previous = activeRunContext;
  activeRunContext = ctx;
  return callback().finally(() => {
    activeRunContext = previous;
  });
}

function requireContext(): RunContextBinding {
  if (!activeRunContext) {
    throw new Error("runtime primitive called outside an active workflow run");
  }
  return activeRunContext;
}

export type Step<A extends unknown[], O> = {
  readonly __brand: "step";
  readonly fn: (...args: A) => Promise<O>;
  readonly opts?: StepOpts;
  (...args: A): Promise<O>;
};

export function step<A extends unknown[], O>(
  fn: (...args: A) => Promise<O>,
  opts?: StepOpts,
): Step<A, O> {
  const stepFn = async (...args: A): Promise<O> => {
    const ctx = requireContext();
    const stepKey = opts?.idempotencyKey ?? stableIdempotencyKey(["step", fn.name, args]);
    return ctx.step(stepKey, () => fn(...args), opts);
  };

  return Object.assign(stepFn, {
    __brand: "step" as const,
    fn,
    opts,
  });
}

export function runSleep(duration: string | number): Promise<void> {
  return requireContext().sleep(duration);
}

export function runCreateHook<T>(name?: string): Hook<T> {
  return requireContext().createHook<T>(name);
}

export function runEmit(type: string, data: JsonValue): Promise<number> {
  return requireContext().emit(type, data);
}
