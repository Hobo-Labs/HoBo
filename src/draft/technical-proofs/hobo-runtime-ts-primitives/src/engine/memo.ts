import type { ParsedEnvelope } from "./events.js";

export function findStepCompleted(
  events: ParsedEnvelope[],
  stepKey: string,
): ParsedEnvelope | undefined {
  return events.find(
    (event) => event.type === "run.StepCompleted" && event.data.stepKey === stepKey,
  );
}

export function findStepFailed(
  events: ParsedEnvelope[],
  stepKey: string,
): ParsedEnvelope | undefined {
  return events.find(
    (event) => event.type === "run.StepFailed" && event.data.stepKey === stepKey,
  );
}

export function latestRunSeq(events: ParsedEnvelope[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

export function eventTypesInOrder(events: ParsedEnvelope[]): string[] {
  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .map((event) => event.type);
}
