import type { AuditSink, PamAuditEvent } from "./types.js";

export type YardAuditAppender = (event: PamAuditEvent) => void | Promise<void>;

export function createPamAuditSink(options?: {
	readonly yardAppend?: YardAuditAppender;
}): AuditSink & {
	readonly events: readonly PamAuditEvent[];
	readonly drainedToYard: number;
} {
	const events: PamAuditEvent[] = [];
	let drainedToYard = 0;
	return {
		get events() {
			return events;
		},
		get drainedToYard() {
			return drainedToYard;
		},
		list() {
			return events;
		},
		async append(event) {
			const frozen = Object.freeze({ ...event });
			events.push(frozen);
			if (options?.yardAppend) {
				await options.yardAppend(frozen);
				drainedToYard += 1;
			}
		},
	};
}
