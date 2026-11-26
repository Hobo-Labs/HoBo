import type { ConfigAuditEvent } from "../bindles/types.js";
import { scrubAtCapture } from "./redaction.js";

export type PersistedEvent = ConfigAuditEvent | { readonly type: string; readonly id: string; readonly data: unknown };

export type EventStore = {
  append(event: PersistedEvent): PersistedEvent;
  readonly events: readonly PersistedEvent[];
};

export function createInMemoryEventStore(): EventStore & { events: PersistedEvent[] } {
  const events: PersistedEvent[] = [];
  return {
    get events() {
      return events;
    },
    append(event: PersistedEvent): PersistedEvent {
      // SAFETY: assertion to `const scrubbed = scrubAtCapture(event) as PersistedEvent;` is required at this boundary.
      const scrubbed = scrubAtCapture(event) as PersistedEvent;
      events.push(scrubbed);
      return scrubbed;
    },
  };
}

let eventSeq = 1;

export function nextEventId(prefix: string): string {
  return `${prefix}-${eventSeq++}`;
}

export function resetEventSeq(): void {
  eventSeq = 1;
}
