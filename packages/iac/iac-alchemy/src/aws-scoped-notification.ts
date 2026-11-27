import {
	type NotificationOutcome,
	type NotificationPort,
	type NotificationRequest,
	parseNotificationRequest,
} from "@hobo/core/notification";

const freeze = Object.freeze;
const setPrototype = Object.setPrototypeOf;

function outcome<T extends NotificationOutcome>(value: T): T {
	setPrototype(value, null);
	return freeze(value);
}

export function scopeAwsNotification(
	port: NotificationPort,
	live: () => boolean,
): NotificationPort {
	const permitted = () => {
		try {
			return live() === true;
		} catch {
			return false;
		}
	};
	return freeze({
		async send(input: NotificationRequest): Promise<NotificationOutcome> {
			let request: NotificationRequest;
			try {
				request = parseNotificationRequest(input);
			} catch {
				return outcome({ status: "rejected", code: "invalid-argument" });
			}
			if (!permitted())
				return outcome({ status: "rejected", code: "unauthorized" });
			try {
				const result = await port.send(request);
				return permitted()
					? result
					: outcome({ status: "unknown", attemptId: request.attemptId });
			} catch {
				return outcome({ status: "unknown", attemptId: request.attemptId });
			}
		},
	});
}
