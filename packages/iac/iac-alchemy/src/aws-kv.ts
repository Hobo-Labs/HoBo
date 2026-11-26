/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/no-reflect-apply -- SAFETY: runtime options and byte buffers cross a host boundary and require intrinsic validation before use. */
import { types } from "node:util";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Layer from "effect/Layer";
import {
	type BoundaryBox,
	createBoundaryDeferred,
	raceBoundary,
} from "./async-boundary.js";
import { acceptSynchronousTrue } from "./synchronous-result.js";

export const AWS_KV_MAX_KEY_BYTES = 2048;
// Leaves ample space for the partition key, attribute names, and DynamoDB's 400 KiB item limit.
export const AWS_KV_MAX_VALUE_BYTES = 256 * 1024;
export const AWS_KV_MAX_IN_FLIGHT = 32;
export const AWS_KV_DEADLINE_MS = 10_000;
const apply = Reflect.apply;
const includes = Array.prototype.includes;
const push = Array.prototype.push;
const regexExec = RegExp.prototype.exec;
const descriptor = Object.getOwnPropertyDescriptor;
const own = Object.hasOwn;
const ownKeys = Reflect.ownKeys;
const getPrototype = Object.getPrototypeOf;
const isArray = Array.isArray;
const isProxy = types.isProxy;
const tablePattern = /^[-A-Za-z0-9_.]{3,255}$/u;
const regionPattern = /^[a-z0-9-]{3,63}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const runCallback = Effect.runCallback;
const isSuccess = Exit.isSuccess;
const schedule = setTimeout;
const cancel = clearTimeout;
const define = Object.defineProperty;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;
const byteOffset = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteOffset",
)?.get;
const byteBuffer = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"buffer",
)?.get;

export type AwsKvOperation = "get" | "set" | "delete";
export interface AwsKvGrant {
	readonly tableName: string;
	readonly region: string;
	readonly resourceEpoch: string;
	readonly grantEpoch: string;
	readonly allow: readonly AwsKvOperation[];
}
export interface AwsKvStore {
	get(key: string): Promise<Uint8Array | undefined>;
	exists(key: string): Promise<boolean>;
	set(entry: {
		readonly key: string;
		readonly value: Uint8Array;
	}): Promise<void>;
	delete(key: string): Promise<void>;
}
export class AwsKvError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "AwsKvError";
	}
}

function ownData(value: object, keys: readonly string[]): boolean {
	if (!value || typeof value !== "object" || isProxy(value) || isArray(value))
		return false;
	const prototype = getPrototype(value);
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		ownKeys(value).length !== keys.length
	)
		return false;
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		if (!key) return false;
		const field = descriptor(value, key);
		if (!field || !own(field, "value") || !field.enumerable) return false;
	}
	return true;
}
function matches(pattern: RegExp, value: string): boolean {
	return apply(regexExec, pattern, [value]) !== null;
}

/** The host must authenticate the table incarnation and authorization on every call. */
export function createAwsDynamoKvStore(options: {
	readonly grant: AwsKvGrant;
	readonly verify: (
		grant: AwsKvGrant,
		operation: AwsKvOperation,
		key: string,
	) => boolean;
	readonly layer: Layer.Layer<Credentials | HttpClient.HttpClient>;
}): AwsKvStore {
	if (!ownData(options, ["grant", "verify", "layer"]))
		throw new AwsKvError("AWS_KV_GRANT_INVALID", "invalid table grant");
	const { grant: input, verify, layer } = options;
	if (
		!ownData(input, [
			"tableName",
			"region",
			"resourceEpoch",
			"grantEpoch",
			"allow",
		]) ||
		typeof verify !== "function" ||
		isProxy(verify) ||
		typeof input.tableName !== "string" ||
		typeof input.region !== "string" ||
		typeof input.resourceEpoch !== "string" ||
		typeof input.grantEpoch !== "string" ||
		!matches(tablePattern, input.tableName) ||
		!matches(regionPattern, input.region) ||
		!matches(digestPattern, input.resourceEpoch) ||
		!matches(digestPattern, input.grantEpoch) ||
		!isArray(input.allow) ||
		isProxy(input.allow) ||
		getPrototype(input.allow) !== Array.prototype ||
		input.allow.length < 1 ||
		input.allow.length > 3 ||
		ownKeys(input.allow).length !== input.allow.length + 1
	)
		throw new AwsKvError("AWS_KV_GRANT_INVALID", "invalid table grant");
	const allow: AwsKvOperation[] = [];
	for (let index = 0; index < input.allow.length; index++) {
		const field = descriptor(input.allow, String(index));
		if (
			!field ||
			!own(field, "value") ||
			!field.enumerable ||
			(field.value !== "get" &&
				field.value !== "set" &&
				field.value !== "delete") ||
			apply(includes, allow, [field.value])
		)
			throw new AwsKvError("AWS_KV_GRANT_INVALID", "invalid table grant");
		apply(push, allow, [field.value]);
	}
	const grant: AwsKvGrant = Object.freeze({
		tableName: input.tableName,
		region: input.region,
		resourceEpoch: input.resourceEpoch,
		grantEpoch: input.grantEpoch,
		allow: Object.freeze(allow),
	});
	let inFlight = 0;
	const authorized = (op: AwsKvOperation, key: string): boolean => {
		try {
			return (
				apply(includes, grant.allow, [op]) &&
				acceptSynchronousTrue(verify(grant, op, key))
			);
		} catch {
			return false;
		}
	};
	const keyOf = (key: string): string => {
		if (
			typeof key !== "string" ||
			!key ||
			key.length > AWS_KV_MAX_KEY_BYTES ||
			new TextEncoder().encode(key).length > AWS_KV_MAX_KEY_BYTES
		)
			throw new AwsKvError(
				"AWS_KV_KEY_INVALID",
				"key is outside the DynamoDB limits",
			);
		try {
			encodeURIComponent(key);
		} catch {
			throw new AwsKvError("AWS_KV_KEY_INVALID", "key must be valid Unicode");
		}
		return key;
	};
	const perform = async <T>(
		op: AwsKvOperation,
		key: string,
		effect: Effect.Effect<T, unknown, Credentials | HttpClient.HttpClient>,
	): Promise<BoundaryBox<T>> => {
		if (!authorized(op, key))
			throw new AwsKvError("AWS_KV_DENIED", "operation is not authorized");
		if (inFlight >= AWS_KV_MAX_IN_FLIGHT)
			throw new AwsKvError("AWS_KV_CAPACITY", "too many outstanding calls");
		inFlight++;
		const completion = createBoundaryDeferred<T>();
		const deadline = createBoundaryDeferred<T>();
		const unavailable = () =>
			new AwsKvError(
				op === "get"
					? "AWS_KV_READ_UNAVAILABLE"
					: "AWS_KV_MUTATION_OUTCOME_UNKNOWN",
				op === "get"
					? "read failed"
					: "mutation may have taken effect; reconcile before retry",
			);
		try {
			runCallback(effect.pipe(Effect.provide(layer)), {
				onExit(exit) {
					inFlight--;
					if (isSuccess(exit)) completion.resolve(exit.value);
					else completion.reject(undefined);
				},
			});
		} catch {
			// The effect may have started before observer registration failed.
			// Its slot remains occupied until completion can be established.
			throw unavailable();
		}
		const timer = schedule(
			() => deadline.reject(undefined),
			AWS_KV_DEADLINE_MS,
		);
		try {
			const value = await raceBoundary(completion.promise, deadline.promise);
			if (!authorized(op, key)) throw new Error("authorization changed");
			return value;
		} catch {
			throw unavailable();
		} finally {
			cancel(timer);
		}
	};
	const beforeReturn = (op: AwsKvOperation, key: string): void => {
		if (!authorized(op, key))
			throw new AwsKvError(
				op === "get"
					? "AWS_KV_READ_UNAVAILABLE"
					: "AWS_KV_MUTATION_OUTCOME_UNKNOWN",
				"authorization changed before completion",
			);
	};
	const get = async (key: string): Promise<Uint8Array | undefined> => {
		const checkedKey = keyOf(key);
		const result = (
			await perform(
				"get",
				checkedKey,
				DynamoDB.getItem({
					TableName: grant.tableName,
					region: grant.region,
					Key: { pk: { S: checkedKey } },
					ConsistentRead: true,
				}),
			)
		).value;
		if (result.Item === undefined) {
			beforeReturn("get", checkedKey);
			return undefined;
		}
		const item = result.Item;
		if (
			Object.keys(item).length !== 2 ||
			item.pk?.S !== key ||
			!(item.value?.B instanceof Uint8Array) ||
			item.value.B.byteLength > AWS_KV_MAX_VALUE_BYTES
		)
			throw new AwsKvError(
				"AWS_KV_READ_UNAVAILABLE",
				"stored value is not representable",
			);
		const value = new Uint8Array(item.value.B);
		define(value, "then", { value: undefined });
		beforeReturn("get", checkedKey);
		return value;
	};
	return Object.freeze({
		get,
		async exists(key: string) {
			const present = (await get(key)) !== undefined;
			beforeReturn("get", key);
			return present;
		},
		async set(entry: { readonly key: string; readonly value: Uint8Array }) {
			if (
				!ownData(entry, ["key", "value"]) ||
				!(entry.value instanceof Uint8Array) ||
				types.isProxy(entry.value) ||
				!byteLength ||
				!byteOffset ||
				!byteBuffer
			)
				throw new AwsKvError(
					"AWS_KV_VALUE_INVALID",
					"value is outside the DynamoDB limits",
				);
			let value: Uint8Array;
			try {
				const length = Reflect.apply(byteLength, entry.value, []);
				const offset = Reflect.apply(byteOffset, entry.value, []);
				const buffer = Reflect.apply(byteBuffer, entry.value, []);
				if (length > AWS_KV_MAX_VALUE_BYTES || !(buffer instanceof ArrayBuffer))
					throw new Error("invalid bytes");
				value = new Uint8Array(new Uint8Array(buffer, offset, length));
			} catch {
				throw new AwsKvError(
					"AWS_KV_VALUE_INVALID",
					"value is outside the DynamoDB limits",
				);
			}
			const checkedKey = keyOf(entry.key);
			await perform(
				"set",
				checkedKey,
				DynamoDB.putItem({
					TableName: grant.tableName,
					region: grant.region,
					Item: { pk: { S: checkedKey }, value: { B: value } },
				}),
			);
			beforeReturn("set", checkedKey);
		},
		async delete(key: string) {
			const checkedKey = keyOf(key);
			await perform(
				"delete",
				checkedKey,
				DynamoDB.deleteItem({
					TableName: grant.tableName,
					region: grant.region,
					Key: { pk: { S: checkedKey } },
				}),
			);
			beforeReturn("delete", checkedKey);
		},
	});
}
