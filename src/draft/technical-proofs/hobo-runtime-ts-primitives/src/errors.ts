export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

export class RetryableError extends Error {
  readonly retries?: number;

  constructor(message: string, opts?: { retries?: number }) {
    super(message);
    this.name = "RetryableError";
    this.retries = opts?.retries;
  }
}
