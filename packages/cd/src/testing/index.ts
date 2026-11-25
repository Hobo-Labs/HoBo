import type { CdEvent } from "../boundary/cdevents.js";
import type { CdEventSink, WebhookDelivery } from "../boundary/webhook.js";

export interface RecordingCdEventSink extends CdEventSink {
	readonly events: readonly CdEvent[];
	clear(): void;
}

export function createRecordingCdEventSink(
	options: { readonly delivery?: WebhookDelivery } = {},
): RecordingCdEventSink {
	const recorded: CdEvent[] = [];
	const delivery: WebhookDelivery = {
		...(options.delivery ?? { outcome: "delivered", attempts: 1, status: 202 }),
	};
	return {
		get events() {
			return structuredClone(recorded);
		},
		async deliver(event) {
			recorded.push(structuredClone(event));
			return { ...delivery };
		},
		clear() {
			recorded.length = 0;
		},
	};
}
