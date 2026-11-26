import type { SecretValue } from "../secret-value.js";

export type SecretAccessContext = {
  readonly camp: string;
  readonly accessorId?: string;
};

export class SecretUnavailableError extends Error {
  readonly name = "SecretUnavailableError";
  readonly ref: string;
  readonly camp: string;
  readonly reason: string;

  constructor(ref: string, camp: string, reason: string) {
    super(`secret ${ref} unavailable in camp ${camp}: ${reason}`);
    this.ref = ref;
    this.camp = camp;
    this.reason = reason;
  }
}

export class UnresolvedBindingError extends Error {
  readonly name = "UnresolvedBindingError";
  readonly bindingRef: string;
  readonly camp: string;

  constructor(bindingRef: string, camp: string) {
    super(`binding ${bindingRef} is not registered in camp ${camp}`);
    this.bindingRef = bindingRef;
    this.camp = camp;
  }
}

export interface SecretsPort {
  get(ref: string, ctx: SecretAccessContext): Promise<SecretValue>;
}
