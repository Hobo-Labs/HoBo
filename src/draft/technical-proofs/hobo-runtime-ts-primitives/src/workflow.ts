import { bindRunContext } from "./step.js";
import type { RunContextBinding } from "./step.js";

export type Workflow<A extends unknown[], O> = {
  readonly name: string;
  readonly fn: (...args: A) => Promise<O>;
  run(ctx: RunContextBinding, args: A): Promise<O>;
};

export function workflow<A extends unknown[], O>(
  name: string,
  fn: (...args: A) => Promise<O>,
): Workflow<A, O> {
  return {
    name,
    fn,
    run(ctx, args) {
      return bindRunContext(ctx, () => fn(...args));
    },
  };
}
