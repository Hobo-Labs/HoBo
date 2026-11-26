import { Buffer } from "node:buffer";
import { types } from "node:util";

// public-contract: stable identifier for the asynchronous notification port.
export const NOTIFICATION_CONTRACT = "hobo.notification/v1";
export const NOTIFICATION_MAX_BODY_BYTES = 65_536;
export const NOTIFICATION_MAX_SUBJECT_BYTES = 100;

export interface NotificationRequest {
	readonly attemptId: string;
	readonly body: string;
	readonly subject?: string;
}

export type NotificationOutcome =
	| {
			readonly status: "accepted";
			readonly attemptId: string;
			readonly receipt: string;
	  }
	| {
			readonly status: "rejected";
			readonly code: "invalid-argument" | "unauthorized" | "capacity";
	  }
	| { readonly status: "unknown"; readonly attemptId: string };

export interface NotificationPort {
	send(input: NotificationRequest): Promise<NotificationOutcome>;
}

const isProxy = types.isProxy;
const isArray = Array.isArray;
const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const own = Object.hasOwn;
const create = Object.create;
const define = Object.defineProperty;
const freeze = Object.freeze;
const encode = encodeURIComponent;
const byteLength = Buffer.byteLength;
const apply = Reflect.apply;
const exec = RegExp.prototype.exec;
const objectPrototype = Object.prototype;
const attemptPattern = /^[A-Za-z0-9_-]{16,64}$/u;
const subjectPattern = /^[\x20-\x7e]{1,100}$/u;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: notification requests cross an untrusted provider boundary. */
export function parseNotificationRequest(value: unknown): NotificationRequest {
	if (
		typeof value !== "object" ||
		value === null ||
		isProxy(value) ||
		isArray(value) ||
		(getPrototype(value) !== objectPrototype && getPrototype(value) !== null)
	)
		throw new TypeError("notification.invalid_request");
	const names = ownKeys(value);
	if (names.length < 2 || names.length > 3)
		throw new TypeError("notification.invalid_request");
	for (let index = 0; index < names.length; index++) {
		const name = names[index];
		if (name !== "attemptId" && name !== "body" && name !== "subject")
			throw new TypeError("notification.invalid_request");
	}
	const hasSubject = descriptor(value, "subject") !== undefined;
	const data = (name: string, required: boolean): unknown => {
		const field = descriptor(value, name);
		if (!field && !required) return undefined;
		if (!field?.enumerable || !own(field, "value"))
			throw new TypeError("notification.invalid_request");
		return field.value;
	};
	const attemptId = data("attemptId", true);
	const body = data("body", true);
	const subject = data("subject", false);
	if (
		typeof attemptId !== "string" ||
		apply(exec, attemptPattern, [attemptId]) === null ||
		typeof body !== "string" ||
		body.length === 0 ||
		body.length > NOTIFICATION_MAX_BODY_BYTES ||
		byteLength(body, "utf8") > NOTIFICATION_MAX_BODY_BYTES ||
		(subject !== undefined &&
			(typeof subject !== "string" ||
				apply(exec, subjectPattern, [subject]) === null)) ||
		(hasSubject && subject === undefined)
	)
		throw new TypeError("notification.invalid_request");
	try {
		encode(body);
	} catch {
		throw new TypeError("notification.invalid_request");
	}
	// SAFETY: own data fields are installed before returning this frozen request.
	const result = create(null) as {
		attemptId: string;
		body: string;
		subject?: string;
	};
	const put = (name: string, fieldValue: string) => {
		const field: PropertyDescriptor = create(null);
		field.value = fieldValue;
		field.enumerable = true;
		define(result, name, field);
	};
	put("attemptId", attemptId);
	put("body", body);
	if (subject !== undefined) put("subject", subject);
	return freeze(result);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */
