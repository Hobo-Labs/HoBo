export type GateEventType =
  | "capability.ContractEvaluated"
  | "capability.ContractFailed"
  | "coverage.Evaluated"
  | "coverage.Failed";

export type GateEvent<T extends GateEventType = GateEventType> = {
  id: string;
  type: T;
  seq: number;
  source: "hobo.collector";
  data: GateEventData[T];
};

export type GateEventData = {
  "capability.ContractEvaluated": {
    bindle: string;
    resource: string;
    required: readonly string[];
    granted: readonly string[];
    status: "satisfied";
  };
  "capability.ContractFailed": {
    bindle: string;
    resource: string;
    required: readonly string[];
    granted: readonly string[];
    status: "failed";
    failures: readonly CapabilityFailureRecord[];
  };
  "coverage.Evaluated": {
    fileName: string;
    status: "pass" | "pass-with-warnings";
    observedResourceIds: readonly string[];
    observedBindKeys: readonly string[];
  };
  "coverage.Failed": {
    fileName: string;
    status: "fail";
    diagnostics: readonly CoverageDiagnosticRecord[];
  };
};

export type CapabilityFailureRecord = {
  code: "capability.required-not-granted";
  missing: readonly string[];
  message: string;
};

export type CoverageDiagnosticRecord = {
  code: string;
  severity: "error" | "warning";
  message: string;
  resourceId?: string;
  bindKey?: string;
  branch?: string;
  fileName?: string;
  line?: number;
  callee?: string;
};

let eventSeq = 0;

export function resetGateEventSeq(): void {
  eventSeq = 0;
}

export function appendGateEvent<T extends GateEventType>(
  type: T,
  data: GateEventData[T],
): GateEvent<T> {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq.toString(16).padStart(12, "0")}`,
    type,
    seq: eventSeq,
    source: "hobo.collector",
    data,
  };
}

export type GateEventLog = {
  readonly events: readonly GateEvent[];
};

export function createGateEventLog(): GateEventLog & {
  append<T extends GateEventType>(type: T, data: GateEventData[T]): GateEvent<T>;
} {
  const events: GateEvent[] = [];
  return {
    get events() {
      return events;
    },
    append<T extends GateEventType>(type: T, data: GateEventData[T]): GateEvent<T> {
      const event = appendGateEvent(type, data);
      events.push(event);
      return event;
    },
  };
}
