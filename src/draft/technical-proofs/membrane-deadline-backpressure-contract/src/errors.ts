import { classifyFailure, type FailureClassification } from "./failure-taxonomy.js";
import type { Deadline } from "./deadline.js";

export class DeadlineExceededError extends Error {
  readonly code = "deadline-exceeded";
  readonly failure: FailureClassification;

  constructor(args: {
    componentId: string;
    importInterface: string;
    operation: string;
    deadline: Deadline;
  }) {
    super("wrpc.deadline_exceeded");
    this.name = "DeadlineExceededError";
    this.componentId = args.componentId;
    this.importInterface = args.importInterface;
    this.operation = args.operation;
    this.deadline = args.deadline;
    this.failure = classifyFailure({ code: this.code });
  }

  readonly componentId: string;
  readonly importInterface: string;
  readonly operation: string;
  readonly deadline: Deadline;
}

export class MembraneOverloadedError extends Error {
  readonly code = "WRPC_OVERLOADED";
  readonly membrane = "overloaded" as const;
  readonly failure: FailureClassification;

  constructor(args: {
    providerId: string;
    operation: string;
    importInterface?: string;
    maxInFlight: number;
    inFlight: number;
  }) {
    super(`wrpc.overloaded: ${args.providerId}.${args.operation}`);
    this.name = "MembraneOverloadedError";
    this.providerId = args.providerId;
    this.operation = args.operation;
    this.importInterface = args.importInterface;
    this.maxInFlight = args.maxInFlight;
    this.inFlight = args.inFlight;
    this.failure = classifyFailure({
      membrane: this.membrane,
      providerId: args.providerId,
      operation: args.operation,
      importInterface: args.importInterface,
    });
  }

  readonly providerId: string;
  readonly operation: string;
  readonly importInterface?: string;
  readonly maxInFlight: number;
  readonly inFlight: number;
}

export class MembraneSeveredError extends Error {
  readonly code = "WRPC_SEVERED";
  readonly membrane = "severed" as const;
  readonly ambiguousCommit: boolean;
  readonly failure: FailureClassification;

  constructor(args: {
    providerId: string;
    operation: string;
    importInterface?: string;
    committed?: "yes" | "no" | "unknown";
  }) {
    super(`wrpc.severed: ${args.providerId}.${args.operation}`);
    this.name = "MembraneSeveredError";
    this.providerId = args.providerId;
    this.operation = args.operation;
    this.importInterface = args.importInterface;
    this.committed = args.committed ?? "unknown";
    this.ambiguousCommit = this.committed === "unknown";
    this.failure = classifyFailure({
      membrane: this.membrane,
      providerId: args.providerId,
      operation: args.operation,
      importInterface: args.importInterface,
      ambiguousCommit: this.ambiguousCommit,
    });
  }

  readonly providerId: string;
  readonly operation: string;
  readonly importInterface?: string;
  readonly committed: "yes" | "no" | "unknown";
}

export class AmbiguousReturnError extends Error {
  readonly code = "WRPC_AMBIGUOUS_RETURN";
  readonly membrane = "ambiguous-return" as const;
  readonly ambiguousCommit = true;
  readonly failure: FailureClassification;

  constructor(args: {
    providerId: string;
    operation: string;
    importInterface?: string;
  }) {
    super(`wrpc.ambiguous_return: ${args.providerId}.${args.operation}`);
    this.name = "AmbiguousReturnError";
    this.providerId = args.providerId;
    this.operation = args.operation;
    this.importInterface = args.importInterface;
    this.failure = classifyFailure({
      membrane: this.membrane,
      providerId: args.providerId,
      operation: args.operation,
      importInterface: args.importInterface,
      ambiguousCommit: true,
    });
  }

  readonly providerId: string;
  readonly operation: string;
  readonly importInterface?: string;
}
