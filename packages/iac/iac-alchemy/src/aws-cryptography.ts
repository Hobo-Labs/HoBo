/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: grants and byte requests cross an untrusted application boundary. */
import { types } from "node:util";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as KMS from "@distilled.cloud/aws/kms";
import * as Retry from "@distilled.cloud/aws/Retry";
import {
	type CryptographyOutcome,
	type CryptographyPort,
	type CryptographyRequest,
	parseCryptographyRequest,
} from "@hobo/core/cryptography";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { createAwsRuntimeBoundary } from "./aws-runtime-boundary.js";
import { acceptSynchronousTrue } from "./synchronous-result.js";

export const AWS_KMS_MAX_PLAINTEXT_BYTES = 4096;
export const AWS_KMS_MAX_CIPHERTEXT_BYTES = 6144;
export type AwsKmsOperation = "encrypt" | "decrypt";
export interface AwsKmsGrant {
	readonly keyId: string;
	readonly accountId: string;
	readonly partition: string;
	readonly region: string;
	readonly resourceEpoch: string;
	readonly grantEpoch: string;
	readonly allow: readonly AwsKmsOperation[];
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
const arrayIsArray = Array.isArray;
const includes = Array.prototype.includes;
const push = Array.prototype.push;
const getByteLength = descriptor(
	getPrototype(Uint8Array.prototype),
	"byteLength",
)?.get;
const patterns = {
	keyId:
		/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/u,
	accountId: /^[0-9]{12}$/u,
	partition: /^aws(?:-[a-z0-9]+){0,3}$/u,
	region: /^[a-z0-9-]{3,63}$/u,
	resourceEpoch: /^sha256:[a-f0-9]{64}$/u,
	grantEpoch: /^sha256:[a-f0-9]{64}$/u,
};
const fields = [
	"keyId",
	"accountId",
	"partition",
	"region",
	"resourceEpoch",
	"grantEpoch",
] as const;
const optionFields = ["grant", "verify", "layer"] as const;
const grants = new WeakMap<object, AwsKmsGrant>();
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;

export function inspectAwsKmsCryptography(
	value: unknown,
): AwsKmsGrant | undefined {
	if (typeof value !== "object" || value === null || isProxy(value))
		return undefined;
	return apply(weakGet, grants, [value]);
}
function snapshotGrant(input: AwsKmsGrant): AwsKmsGrant {
	if (
		typeof input !== "object" ||
		input === null ||
		isProxy(input) ||
		(getPrototype(input) !== Object.prototype &&
			getPrototype(input) !== null) ||
		ownKeys(input).length !== fields.length + 1
	)
		throw new TypeError("aws_kms.invalid_grant");
	// SAFETY: all grant properties are installed as own data properties before freezing.
	const result = create(null) as AwsKmsGrant;
	for (let index = 0; index < fields.length; index++) {
		const key = fields[index];
		if (key === undefined) throw new TypeError("aws_kms.invalid_grant");
		const field = descriptor(input, key);
		if (
			!field?.enumerable ||
			!own(field, "value") ||
			typeof field.value !== "string" ||
			apply(exec, patterns[key], [field.value]) === null
		)
			throw new TypeError("aws_kms.invalid_grant");
		const property: PropertyDescriptor = create(null);
		property.value = field.value;
		property.enumerable = true;
		define(result, key, property);
	}
	const allowField = descriptor(input, "allow");
	const raw = allowField?.value;
	if (
		!allowField?.enumerable ||
		!own(allowField, "value") ||
		!arrayIsArray(raw) ||
		isProxy(raw) ||
		getPrototype(raw) !== Array.prototype ||
		raw.length < 1 ||
		raw.length > 2 ||
		ownKeys(raw).length !== raw.length + 1
	)
		throw new TypeError("aws_kms.invalid_grant");
	const allow: AwsKmsOperation[] = [];
	for (let i = 0; i < raw.length; i++) {
		const field = descriptor(raw, String(i));
		if (
			!field?.enumerable ||
			!own(field, "value") ||
			(field.value !== "encrypt" && field.value !== "decrypt") ||
			apply(includes, allow, [field.value])
		)
			throw new TypeError("aws_kms.invalid_grant");
		apply(push, allow, [field.value]);
	}
	const property: PropertyDescriptor = create(null);
	property.value = freeze(allow);
	property.enumerable = true;
	define(result, "allow", property);
	return freeze(result);
}
function outcome<T extends CryptographyOutcome>(value: T): T {
	setPrototype(value, null);
	return freeze(value);
}
export function createAwsKmsCryptography(options: {
	readonly grant: AwsKmsGrant;
	readonly verify: (
		grant: AwsKmsGrant,
		operation: AwsKmsOperation,
		attemptId: string,
	) => boolean;
	readonly layer: Layer.Layer<Credentials | HttpClient.HttpClient>;
}): CryptographyPort {
	if (
		typeof options !== "object" ||
		options === null ||
		isProxy(options) ||
		(getPrototype(options) !== Object.prototype &&
			getPrototype(options) !== null) ||
		ownKeys(options).length !== 3
	)
		throw new TypeError("aws_kms.invalid_options");
	for (let index = 0; index < optionFields.length; index++) {
		const key = optionFields[index];
		if (key === undefined) throw new TypeError("aws_kms.invalid_options");
		const field = descriptor(options, key);
		if (!field?.enumerable || !own(field, "value"))
			throw new TypeError("aws_kms.invalid_options");
	}
	const grant = snapshotGrant(options.grant);
	const verify = options.verify;
	if (typeof verify !== "function" || isProxy(verify) || !getByteLength)
		throw new TypeError("aws_kms.invalid_options");
	const denied = new Error("aws_kms.denied");
	const capacity = new Error("aws_kms.capacity");
	const authorize = (operation: AwsKmsOperation, attemptId: string) => {
		try {
			return (
				apply(includes, grant.allow, [operation]) &&
				acceptSynchronousTrue(verify(grant, operation, attemptId))
			);
		} catch {
			return false;
		}
	};
	const boundary = createAwsRuntimeBoundary<AwsKmsOperation>({
		layer: options.layer,
		authorize,
		denied: () => denied,
		capacity: () => capacity,
		unavailable: () => new Error("aws_kms.unknown"),
	});
	const keyArn = `arn:${grant.partition}:kms:${grant.region}:${grant.accountId}:key/${grant.keyId}`;
	const perform = async (
		operation: AwsKmsOperation,
		input: CryptographyRequest,
	): Promise<CryptographyOutcome> => {
		let request: CryptographyRequest;
		try {
			request = parseCryptographyRequest(input);
			if (
				apply(getByteLength, request.data, []) >
				(operation === "encrypt"
					? AWS_KMS_MAX_PLAINTEXT_BYTES
					: AWS_KMS_MAX_CIPHERTEXT_BYTES)
			)
				throw Error();
		} catch {
			return outcome({ status: "rejected", code: "invalid-argument" });
		}
		try {
			const result =
				operation === "encrypt"
					? (
							await boundary.run(
								operation,
								request.attemptId,
								KMS.encrypt({
									region: grant.region,
									KeyId: keyArn,
									Plaintext: request.data,
									EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
								}).pipe(Retry.none),
							)
						).value
					: (
							await boundary.run(
								operation,
								request.attemptId,
								KMS.decrypt({
									region: grant.region,
									KeyId: keyArn,
									CiphertextBlob: request.data,
									EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
								}).pipe(Retry.none),
							)
						).value;
			if (
				result.KeyId !== keyArn ||
				(result.EncryptionAlgorithm !== undefined &&
					result.EncryptionAlgorithm !== "SYMMETRIC_DEFAULT")
			)
				throw Error();
			const raw =
				operation === "encrypt"
					? "CiphertextBlob" in result
						? result.CiphertextBlob
						: undefined
					: "Plaintext" in result
						? result.Plaintext
						: undefined;
			const output = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
			const data = parseCryptographyRequest({
				attemptId: request.attemptId,
				data: output,
			}).data;
			if (
				apply(getByteLength, data, []) >
				(operation === "encrypt"
					? AWS_KMS_MAX_CIPHERTEXT_BYTES
					: AWS_KMS_MAX_PLAINTEXT_BYTES)
			)
				throw Error();
			boundary.beforeReturn(operation, request.attemptId);
			return outcome({
				status: "completed",
				attemptId: request.attemptId,
				data,
			});
		} catch (error) {
			if (error === denied)
				return outcome({ status: "rejected", code: "unauthorized" });
			if (error === capacity)
				return outcome({ status: "rejected", code: "capacity" });
			return outcome({ status: "unknown", attemptId: request.attemptId });
		}
	};
	const port: CryptographyPort = freeze({
		encrypt: (input: CryptographyRequest) => perform("encrypt", input),
		decrypt: (input: CryptographyRequest) => perform("decrypt", input),
	});
	apply(weakSet, grants, [port, grant]);
	return port;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply */
