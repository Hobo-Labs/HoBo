import { isJsonString } from "../json.js";
const REDACTED = "[secret:redacted]" as const;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    if (!isJsonString(value) || value.length === 0) {
      throw new TypeError("SecretValue requires a non-empty string");
    }
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return REDACTED;
  }
}

export { REDACTED };
