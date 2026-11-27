/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: grants and notification requests cross an untrusted application boundary. */
import { types } from "node:util";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as SNS from "@distilled.cloud/aws/sns";
import {
	type NotificationOutcome,
	type NotificationPort,
	type NotificationRequest,
	parseNotificationRequest,
} from "@hobo/core/notification";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Layer from "effect/Layer";
import { createAwsRuntimeBoundary } from "./aws-runtime-boundary.js";
import { acceptSynchronousTrue } from "./synchronous-result.js";

export interface AwsNotificationGrant {
	readonly topicName: string;
	readonly accountId: string;
	readonly partition: string;
	readonly region: string;
	readonly resourceEpoch: string;
	readonly grantEpoch: string;
}

const apply = Reflect.apply;
const exec = RegExp.prototype.exec;
const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const own = Object.hasOwn;
const isProxy = types.isProxy;
const create = Object.create;
const define = Object.defineProperty;
const freeze = Object.freeze;
const setPrototype = Object.setPrototypeOf;
const patterns = {
	topicName: /^[A-Za-z0-9_-]{1,256}$/u,
	accountId: /^[0-9]{12}$/u,
	partition: /^aws(?:-[a-z0-9]+){0,3}$/u,
	region: /^[a-z0-9-]{3,63}$/u,
	resourceEpoch: /^sha256:[a-f0-9]{64}$/u,
	grantEpoch: /^sha256:[a-f0-9]{64}$/u,
};
const fields = [
	"topicName",
	"accountId",
	"partition",
	"region",
	"resourceEpoch",
	"grantEpoch",
] as const;
const receiptPattern = /^[A-Za-z0-9-]{1,128}$/u;
const publisherGrants = new WeakMap<object, AwsNotificationGrant>();
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;

export function inspectAwsNotificationPublisher(
	value: unknown,
): AwsNotificationGrant | undefined {
	if (typeof value !== "object" || value === null || isProxy(value))
		return undefined;
	return apply(weakGet, publisherGrants, [value]);
}

function snapshotGrant(input: AwsNotificationGrant): AwsNotificationGrant {
	if (
		typeof input !== "object" ||
		input === null ||
		isProxy(input) ||
		(getPrototype(input) !== Object.prototype &&
			getPrototype(input) !== null) ||
		ownKeys(input).length !== fields.length
	)
		throw new TypeError("aws_notification.invalid_grant");
	// SAFETY: every grant field is defined as an own data property before use.
	const result = create(null) as AwsNotificationGrant;
	for (let index = 0; index < fields.length; index++) {
		const key = fields[index];
		if (key === undefined)
			throw new TypeError("aws_notification.invalid_grant");
		const field = descriptor(input, key);
		if (
			!field?.enumerable ||
			!own(field, "value") ||
			typeof field.value !== "string" ||
			apply(exec, patterns[key], [field.value]) === null
		)
			throw new TypeError("aws_notification.invalid_grant");
		const property: PropertyDescriptor = create(null);
		property.value = field.value;
		property.enumerable = true;
		define(result, key, property);
	}
	return freeze(result);
}

function outcome<T extends NotificationOutcome>(value: T): T {
	setPrototype(value, null);
	return freeze(value);
}

export function createAwsNotificationPublisher(options: {
	readonly grant: AwsNotificationGrant;
	readonly verify: (grant: AwsNotificationGrant) => boolean;
	readonly layer: Layer.Layer<Credentials | HttpClient.HttpClient>;
}): NotificationPort {
	if (
		typeof options !== "object" ||
		options === null ||
		isProxy(options) ||
		(getPrototype(options) !== Object.prototype &&
			getPrototype(options) !== null) ||
		ownKeys(options).length !== 3
	)
		throw new TypeError("aws_notification.invalid_options");
	const optionFields = ["grant", "verify", "layer"] as const;
	for (let index = 0; index < optionFields.length; index++) {
		const key = optionFields[index];
		if (key === undefined)
			throw new TypeError("aws_notification.invalid_options");
		const field = descriptor(options, key);
		if (!field?.enumerable || !own(field, "value"))
			throw new TypeError("aws_notification.invalid_options");
	}
	const grant = snapshotGrant(options.grant);
	const verify = options.verify;
	if (typeof verify !== "function" || isProxy(verify))
		throw new TypeError("aws_notification.invalid_options");
	const denied = new Error("aws_notification.denied");
	const capacity = new Error("aws_notification.capacity");
	const authorize = () => {
		try {
			return acceptSynchronousTrue(verify(grant));
		} catch {
			return false;
		}
	};
	const boundary = createAwsRuntimeBoundary<"send">({
		layer: options.layer,
		authorize,
		denied: () => denied,
		capacity: () => capacity,
		unavailable: () => new Error("aws_notification.unknown"),
	});
	const topicArn = `arn:${grant.partition}:sns:${grant.region}:${grant.accountId}:${grant.topicName}`;
	const publisher: NotificationPort = freeze({
		async send(input: NotificationRequest) {
			let request: ReturnType<typeof parseNotificationRequest>;
			try {
				request = parseNotificationRequest(input);
			} catch {
				return outcome({ status: "rejected", code: "invalid-argument" });
			}
			try {
				const message: SNS.PublishInput & { region: string } = {
					TopicArn: topicArn,
					region: grant.region,
					Message: request.body,
				};
				if (request.subject !== undefined) message.Subject = request.subject;
				const response = (
					await boundary.run(
						"send",
						request.attemptId,
						SNS.publish(message).pipe(Retry.none),
					)
				).value;
				if (
					typeof response.MessageId !== "string" ||
					apply(exec, receiptPattern, [response.MessageId]) === null
				)
					throw new Error("aws_notification.invalid_receipt");
				boundary.beforeReturn("send", request.attemptId);
				return outcome({
					status: "accepted",
					attemptId: request.attemptId,
					receipt: response.MessageId,
				});
			} catch (error) {
				if (error === denied)
					return outcome({ status: "rejected", code: "unauthorized" });
				if (error === capacity)
					return outcome({ status: "rejected", code: "capacity" });
				return outcome({ status: "unknown", attemptId: request.attemptId });
			}
		},
	});
	apply(weakSet, publisherGrants, [publisher, grant]);
	return publisher;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply */
