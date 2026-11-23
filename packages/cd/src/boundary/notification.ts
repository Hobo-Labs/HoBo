import type { JsonObject } from "@hobo/core";
import type { CdContext, NotificationPort } from "../ports.js";
import {
	assertCdEvent,
	CDEVENTS_SPEC,
	type CdEvent,
	canonicalJson,
	cdEventId,
	hoboEventType,
	sha256Hex,
} from "./cdevents.js";
import { BoundaryError } from "./errors.js";
import type { CdEventSink, WebhookDelivery } from "./webhook.js";

// public-contract: the custom CDEvent type every notification uses.
export const NOTIFICATION_EVENT_TYPE = hoboEventType("notification", "sent");

export type NotificationPortOptions = Readonly<{
	channels: Readonly<Record<string, CdEventSink>>;
	source: string;
}>;

export interface DrainableNotificationPort extends NotificationPort {
	drain(): Promise<readonly WebhookDelivery[]>;
}

export function notificationEvent(
	input: Readonly<{ channel: string; subject: string; body: JsonObject }>,
	ctx: Pick<CdContext, "now" | "tenant">,
	source: string,
): CdEvent {
	const atMs = ctx.now();
	const digest = sha256Hex(
		canonicalJson({
			channel: input.channel,
			subject: input.subject,
			body: input.body,
		}),
	);
	return assertCdEvent({
		context: {
			specversion: CDEVENTS_SPEC.specversion,
			id: cdEventId(
				`notification:${ctx.tenant}:${atMs}:${digest}`,
				NOTIFICATION_EVENT_TYPE,
			),
			source,
			type: NOTIFICATION_EVENT_TYPE,
			timestamp: new Date(atMs).toISOString(),
		},
		subject: {
			id: input.subject,
			source,
			content: { channel: input.channel, body: input.body },
		},
	});
}

export function createNotificationPort(
	options: NotificationPortOptions,
): DrainableNotificationPort {
	const inflight = new Set<Promise<WebhookDelivery>>();
	const settled: WebhookDelivery[] = [];
	return {
		async notify(input, ctx) {
			const sink = options.channels[input.channel];
			if (sink === undefined) {
				throw new BoundaryError(
					"notification-channel-unknown",
					`channel ${input.channel}`,
				);
			}
			const event = notificationEvent(input, ctx, options.source);
			const delivery = sink
				.deliver(event)
				.catch(
					(error): WebhookDelivery => ({
						outcome: "dead-lettered",
						attempts: 0,
						code:
							error instanceof BoundaryError
								? error.code
								: "webhook-retries-exhausted",
					}),
				)
				.then((result) => {
					settled.push(result);
					inflight.delete(delivery);
					return result;
				});
			inflight.add(delivery);
		},
		async drain() {
			while (inflight.size > 0) await Promise.all(inflight);
			return [...settled];
		},
	};
}
