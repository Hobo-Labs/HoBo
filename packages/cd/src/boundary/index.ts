// @hobo/cd/boundary — outbound standards boundary (WP16, plan 0024 D17):
// CDEvents projection, CloudEvents webhooks, and the NotificationPort.
export {
	artifactPurl,
	assertCdEvent,
	CDEVENT_TYPES,
	CDEVENTS_SPEC,
	type CdEvent,
	type CdEventContext,
	type CdEventSubject,
	canonicalJson,
	cdEventId,
	freightPurl,
	HOBO_CUSTOM_EVENT_PREFIX,
	HOBO_CUSTOM_EVENT_VERSION,
	hoboEventType,
	type StandardCdEventType,
} from "./cdevents.js";
export {
	BOUNDARY_FAILURES,
	BoundaryError,
	type BoundaryFailureCode,
} from "./errors.js";
export {
	createNotificationPort,
	type DrainableNotificationPort,
	NOTIFICATION_EVENT_TYPE,
	type NotificationPortOptions,
	notificationEvent,
} from "./notification.js";
export {
	type CdEventsProjector,
	type CdEventsProjectorOptions,
	createCdEventsProjector,
	projectCdEvents,
} from "./projection.js";
export {
	type CdEventsRelay,
	type CdEventsRelayOptions,
	createCdEventsRelay,
	type RelayPumpResult,
} from "./relay.js";
export {
	type CdEventSink,
	CLOUDEVENTS_HEADERS,
	type CloudEventHttpRequest,
	cloudEventRequest,
	createCloudEventsWebhookSink,
	createMemoryDeadLetter,
	type DeadLetterEntry,
	type DeadLetterSink,
	signWebhook,
	verifyWebhookSignature,
	WEBHOOK_SECRET_SCOPE,
	WEBHOOK_SIGNATURE_HEADERS,
	WEBHOOK_TIMESTAMP_TOLERANCE_MS,
	type WebhookDelivery,
	type WebhookOutcome,
	type WebhookSinkOptions,
	webhookBackoffMs,
} from "./webhook.js";
