import type { ArgsOf, RunHandle } from "./types.js";
import type { Workflow } from "./workflow.js";


export function start<W extends Workflow<unknown[], unknown>>(
  wf: W,
  args: ArgsOf<W>,
  opts?: { idempotencyKey?: string },
): Promise<RunHandle> {
  void wf;
  void args;
  void opts;
  throw new Error("start() requires a configured runtime host; use testRuntime().start in this draft POC");
}

export { emit } from "./saga.js";
