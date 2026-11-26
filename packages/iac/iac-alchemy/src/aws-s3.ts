/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: resource grants and object values cross an external host boundary. */
import { createHash } from "node:crypto";
import { types } from "node:util";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { createAwsRuntimeBoundary } from "./aws-runtime-boundary.js";
import { acceptSynchronousTrue } from "./synchronous-result.js";

export const AWS_S3_MAX_KEY_BYTES = 1024;
export const AWS_S3_MAX_OBJECT_BYTES = 1_048_576;
export const AWS_S3_MAX_CONTENT_TYPE_BYTES = 512;
const maxChunks = 1024;
const apply = Reflect.apply;
const includes = Array.prototype.includes;
const push = Array.prototype.push;
const stringIncludes = String.prototype.includes;
const regexExec = RegExp.prototype.exec;
const descriptor = Object.getOwnPropertyDescriptor;
const own = Object.hasOwn;
const ownKeys = Reflect.ownKeys;
const getPrototype = Object.getPrototypeOf;
const isArray = Array.isArray;
const isProxy = types.isProxy;
const define = Object.defineProperty;
const accountPattern = /^\d{12}$/u;
const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const ipPattern = /^\d+\.\d+\.\d+\.\d+$/u;
const regionPattern = /^[a-z0-9-]{3,63}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const contentPattern = /^[\x20-\x7e]+$/u;
function matches(pattern: RegExp, value: string): boolean {
	return apply(regexExec, pattern, [value]) !== null;
}

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

export type AwsS3Operation = "read" | "write" | "delete";
export interface AwsS3Grant {
	readonly bucketName: string;
	readonly accountId: string;
	readonly region: string;
	readonly resourceEpoch: string;
	readonly grantEpoch: string;
	readonly allow: readonly AwsS3Operation[];
}
export interface AwsS3Object {
	readonly name: string;
	readonly contentType: string;
	readonly digest: string;
	readonly size: number;
	readonly body: Uint8Array;
}
export interface AwsS3Store {
	read(name: string): Promise<AwsS3Object | undefined>;
	write(object: AwsS3Object): Promise<void>;
	delete(name: string): Promise<void>;
}
const storeGrants = new WeakMap<object, AwsS3Grant>();
const storeGrantGet = WeakMap.prototype.get;
const storeGrantSet = WeakMap.prototype.set;
const storeIsProxy = types.isProxy;
const storeApply = Reflect.apply;

export function inspectAwsS3Store(value: unknown): AwsS3Grant | undefined {
	if (typeof value !== "object" || value === null || storeIsProxy(value))
		return undefined;
	return storeApply(storeGrantGet, storeGrants, [value]);
}
export class AwsS3Error extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "AwsS3Error";
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

function copyBytes(value: Uint8Array): Uint8Array | undefined {
	if (
		!(value instanceof Uint8Array) ||
		types.isProxy(value) ||
		!byteLength ||
		!byteOffset ||
		!byteBuffer
	)
		return undefined;
	try {
		const length = Reflect.apply(byteLength, value, []);
		const offset = Reflect.apply(byteOffset, value, []);
		const buffer = Reflect.apply(byteBuffer, value, []);
		if (length > AWS_S3_MAX_OBJECT_BYTES || !(buffer instanceof ArrayBuffer))
			return undefined;
		return new Uint8Array(new Uint8Array(buffer, offset, length));
	} catch {
		return undefined;
	}
}
function keyOf(key: string): string {
	if (
		typeof key !== "string" ||
		!key ||
		key.length > AWS_S3_MAX_KEY_BYTES ||
		new TextEncoder().encode(key).length > AWS_S3_MAX_KEY_BYTES
	)
		throw new AwsS3Error(
			"AWS_S3_KEY_INVALID",
			"object key is outside S3 limits",
		);
	try {
		encodeURIComponent(key);
	} catch {
		throw new AwsS3Error(
			"AWS_S3_KEY_INVALID",
			"object key must be valid Unicode",
		);
	}
	return key;
}
function validContentType(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= AWS_S3_MAX_CONTENT_TYPE_BYTES &&
		matches(contentPattern, value)
	);
}
function digest(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function createAwsS3Store(options: {
	readonly grant: AwsS3Grant;
	readonly verify: (
		grant: AwsS3Grant,
		operation: AwsS3Operation,
		key: string,
	) => boolean;
	readonly layer: Layer.Layer<Credentials | HttpClient.HttpClient>;
}): AwsS3Store {
	if (!ownData(options, ["grant", "verify", "layer"]))
		throw new AwsS3Error("AWS_S3_GRANT_INVALID", "invalid bucket grant");
	const { grant: input, verify, layer } = options;
	if (
		!ownData(input, [
			"bucketName",
			"accountId",
			"region",
			"resourceEpoch",
			"grantEpoch",
			"allow",
		]) ||
		typeof verify !== "function" ||
		isProxy(verify) ||
		typeof input.bucketName !== "string" ||
		!matches(bucketPattern, input.bucketName) ||
		apply(stringIncludes, input.bucketName, [".."]) ||
		matches(ipPattern, input.bucketName) ||
		typeof input.accountId !== "string" ||
		!matches(accountPattern, input.accountId) ||
		typeof input.region !== "string" ||
		!matches(regionPattern, input.region) ||
		typeof input.resourceEpoch !== "string" ||
		!matches(digestPattern, input.resourceEpoch) ||
		typeof input.grantEpoch !== "string" ||
		!matches(digestPattern, input.grantEpoch) ||
		!isArray(input.allow) ||
		isProxy(input.allow) ||
		getPrototype(input.allow) !== Array.prototype ||
		input.allow.length < 1 ||
		input.allow.length > 3 ||
		ownKeys(input.allow).length !== input.allow.length + 1
	)
		throw new AwsS3Error("AWS_S3_GRANT_INVALID", "invalid bucket grant");
	const allow: AwsS3Operation[] = [];
	for (let index = 0; index < input.allow.length; index++) {
		const field = descriptor(input.allow, String(index));
		if (
			!field ||
			!own(field, "value") ||
			!field.enumerable ||
			(field.value !== "read" &&
				field.value !== "write" &&
				field.value !== "delete") ||
			apply(includes, allow, [field.value])
		)
			throw new AwsS3Error("AWS_S3_GRANT_INVALID", "invalid bucket grant");
		apply(push, allow, [field.value]);
	}
	const grant: AwsS3Grant = Object.freeze({
		bucketName: input.bucketName,
		accountId: input.accountId,
		region: input.region,
		resourceEpoch: input.resourceEpoch,
		grantEpoch: input.grantEpoch,
		allow: Object.freeze(allow),
	});
	const authorized = (op: AwsS3Operation, key: string) => {
		try {
			return (
				apply(includes, grant.allow, [op]) &&
				acceptSynchronousTrue(verify(grant, op, key))
			);
		} catch {
			return false;
		}
	};
	const boundary = createAwsRuntimeBoundary<AwsS3Operation>({
		layer,
		authorize: authorized,
		denied: () =>
			new AwsS3Error("AWS_S3_DENIED", "operation is not authorized"),
		capacity: () =>
			new AwsS3Error("AWS_S3_CAPACITY", "too many outstanding calls"),
		unavailable: (op) =>
			new AwsS3Error(
				op === "read"
					? "AWS_S3_READ_UNAVAILABLE"
					: "AWS_S3_MUTATION_OUTCOME_UNKNOWN",
				op === "read"
					? "object read failed"
					: "mutation may have taken effect; reconcile before retry",
			),
	});
	const store = Object.freeze({
		async read(name: string) {
			const key = keyOf(name);
			const effect = Effect.gen(function* () {
				const response = yield* S3.getObject({
					Bucket: grant.bucketName,
					ExpectedBucketOwner: grant.accountId,
					Key: key,
					region: grant.region,
				}).pipe(Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)));
				if (response === undefined) return undefined;
				const size = response.ContentLength;
				const contentType = response.ContentType;
				const hash = response.Metadata?.["hobo-digest"];
				if (
					!Number.isSafeInteger(size) ||
					size === undefined ||
					size < 0 ||
					size > AWS_S3_MAX_OBJECT_BYTES ||
					!contentType ||
					!validContentType(contentType) ||
					typeof hash !== "string" ||
					!matches(digestPattern, hash) ||
					Object.keys(response.Metadata ?? {}).length !== 1 ||
					!response.Body ||
					response.ContentEncoding !== undefined ||
					response.ContentRange !== undefined
				) {
					if (response.Body)
						yield* Stream.runDrain(Stream.take(response.Body, 1)).pipe(
							Effect.ignore,
						);
					return yield* Effect.fail(new Error("unsupported object metadata"));
				}
				const buffer = new Uint8Array(size);
				const state = yield* Stream.runFoldEffect(
					response.Body,
					() => ({ offset: 0, chunks: 0 }),
					(previous, chunk) => {
						if (
							++previous.chunks > maxChunks ||
							previous.offset + chunk.byteLength > size
						)
							return Effect.fail(new Error("object exceeds bound"));
						buffer.set(chunk, previous.offset);
						previous.offset += chunk.byteLength;
						return Effect.succeed(previous);
					},
				);
				if (state.offset !== size || digest(buffer) !== hash)
					return yield* Effect.fail(new Error("object integrity mismatch"));
				return { name: key, contentType, digest: hash, size, body: buffer };
			});
			const result = (await boundary.run("read", key, effect)).value;
			if (result !== undefined) {
				define(result.body, "then", { value: undefined });
				define(result, "then", { value: undefined });
			}
			boundary.beforeReturn("read", key);
			return result;
		},
		async write(object: AwsS3Object) {
			if (!ownData(object, ["name", "contentType", "digest", "size", "body"]))
				throw new AwsS3Error(
					"AWS_S3_OBJECT_INVALID",
					"object must contain own data",
				);
			const key = keyOf(object.name);
			const value = copyBytes(object.body);
			if (
				!value ||
				!validContentType(object.contentType) ||
				!Number.isSafeInteger(object.size) ||
				object.size !== value.byteLength ||
				typeof object.digest !== "string" ||
				object.digest !== digest(value)
			)
				throw new AwsS3Error(
					"AWS_S3_OBJECT_INVALID",
					"object metadata or body is invalid",
				);
			await boundary.run(
				"write",
				key,
				S3.putObject({
					Bucket: grant.bucketName,
					ExpectedBucketOwner: grant.accountId,
					Key: key,
					region: grant.region,
					Body: value,
					ContentLength: value.byteLength,
					ContentType: object.contentType,
					Metadata: { "hobo-digest": object.digest },
				}),
			);
			boundary.beforeReturn("write", key);
		},
		async delete(name: string) {
			const key = keyOf(name);
			await boundary.run(
				"delete",
				key,
				S3.deleteObject({
					Bucket: grant.bucketName,
					ExpectedBucketOwner: grant.accountId,
					Key: key,
					region: grant.region,
				}),
			);
			boundary.beforeReturn("delete", key);
		},
	});
	storeApply(storeGrantSet, storeGrants, [store, grant]);
	return store;
}
