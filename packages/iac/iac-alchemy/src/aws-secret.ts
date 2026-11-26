/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: grants, secret bytes and provider results cross a checked host boundary. */
import { types } from "node:util";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as SecretsManager from "@distilled.cloud/aws/secrets-manager";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
	AWS_RUNTIME_DEADLINE_MS,
	AWS_RUNTIME_MAX_IN_FLIGHT,
	createAwsRuntimeBoundary,
} from "./aws-runtime-boundary.js";
import { acceptSynchronousTrue } from "./synchronous-result.js";

export const AWS_SECRET_MAX_VALUE_BYTES = 65_536;
export const AWS_SECRET_MAX_VERSIONS = 100;
export const AWS_SECRET_MAX_IN_FLIGHT = AWS_RUNTIME_MAX_IN_FLIGHT;
export const AWS_SECRET_DEADLINE_MS = AWS_RUNTIME_DEADLINE_MS;
export type AwsSecretOperation =
	| "put"
	| "access"
	| "access-version"
	| "list-versions";
export interface AwsSecretGrant {
	readonly secretArn: string;
	readonly resourceEpoch: string;
	readonly grantEpoch: string;
	readonly allow: readonly ("put" | "access")[];
}
export interface AwsSecretStore {
	put(value: Uint8Array, versionId: string): Promise<string>;
	access(): Promise<Readonly<{ versionId: string; value: Uint8Array }>>;
	accessVersion(versionId: string): Promise<Uint8Array>;
	listVersions(): Promise<readonly string[]>;
}
export class AwsSecretError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly versionId?: string,
	) {
		super(`${code}: ${message}`);
		this.name = "AwsSecretError";
	}
}
const NativeUint8Array = Uint8Array;
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
const apply = Reflect.apply;
const arrayIncludes = Array.prototype.includes;
const arrayPush = Array.prototype.push;
const regexExec = RegExp.prototype.exec;
const dateTime = Date.prototype.getTime;
const isProxy = types.isProxy;
const isArray = Array.isArray;
const descriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const own = Object.hasOwn;
const ownKeys = Reflect.ownKeys;
const arraySort = Array.prototype.sort;
const define = Object.defineProperty;
const freeze = Object.freeze;
const grants = new WeakMap<object, AwsSecretGrant>();
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const arnPattern =
	/^arn:(aws(?:-[a-z0-9]+){0,3}):secretsmanager:([a-z0-9-]{3,63}):(\d{12}):secret:([-A-Za-z0-9/_+=.@]{1,512})$/u;
const versionPattern =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function inspectAwsSecretStore(
	value: unknown,
): AwsSecretGrant | undefined {
	if (typeof value !== "object" || value === null || isProxy(value))
		return undefined;
	return apply(weakGet, grants, [value]);
}
function ownData(value: unknown, keys: readonly string[]): value is object {
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
		if (!field || !own(field, "value") || field.enumerable !== true)
			return false;
	}
	return true;
}
function matches(pattern: RegExp, value: string): boolean {
	return apply(regexExec, pattern, [value]) !== null;
}
function version(value: string): string {
	if (typeof value !== "string" || !matches(versionPattern, value))
		throw new AwsSecretError(
			"AWS_SECRET_VERSION_INVALID",
			"a canonical persisted UUID is required",
		);
	return value;
}
function copyBytes(value: unknown): Uint8Array {
	if (
		!(value instanceof NativeUint8Array) ||
		isProxy(value) ||
		!byteLength ||
		!byteOffset ||
		!byteBuffer
	)
		throw new Error("invalid secret bytes");
	const length: number = apply(byteLength, value, []);
	const offset: number = apply(byteOffset, value, []);
	const buffer: unknown = apply(byteBuffer, value, []);
	if (
		length < 1 ||
		length > AWS_SECRET_MAX_VALUE_BYTES ||
		!(buffer instanceof ArrayBuffer)
	)
		throw new Error("invalid secret bytes");
	const result = new NativeUint8Array(
		new NativeUint8Array(buffer, offset, length),
	);
	define(result, "then", { value: undefined });
	return result;
}

export function createAwsSecretStore(options: {
	readonly grant: AwsSecretGrant;
	readonly verify: (
		grant: AwsSecretGrant,
		operation: AwsSecretOperation,
		versionId: string,
	) => boolean;
	readonly layer: Layer.Layer<Credentials | HttpClient.HttpClient>;
}): AwsSecretStore {
	if (!ownData(options, ["grant", "verify", "layer"]))
		throw new AwsSecretError(
			"AWS_SECRET_GRANT_INVALID",
			"invalid secret grant",
		);
	const { grant: input, verify, layer } = options;
	if (
		!ownData(input, ["secretArn", "resourceEpoch", "grantEpoch", "allow"]) ||
		typeof input.secretArn !== "string" ||
		typeof input.resourceEpoch !== "string" ||
		typeof input.grantEpoch !== "string" ||
		!matches(digestPattern, input.resourceEpoch) ||
		!matches(digestPattern, input.grantEpoch) ||
		typeof verify !== "function" ||
		isProxy(verify) ||
		!isArray(input.allow) ||
		isProxy(input.allow) ||
		getPrototype(input.allow) !== Array.prototype ||
		input.allow.length < 1 ||
		input.allow.length > 2 ||
		ownKeys(input.allow).length !== input.allow.length + 1
	)
		throw new AwsSecretError(
			"AWS_SECRET_GRANT_INVALID",
			"invalid secret grant",
		);
	const allow: ("put" | "access")[] = [];
	for (let index = 0; index < input.allow.length; index++) {
		const field = descriptor(input.allow, String(index));
		if (
			!field ||
			!own(field, "value") ||
			!field.enumerable ||
			(field.value !== "put" && field.value !== "access") ||
			apply(arrayIncludes, allow, [field.value])
		)
			throw new AwsSecretError(
				"AWS_SECRET_GRANT_INVALID",
				"invalid secret grant",
			);
		apply(arrayPush, allow, [field.value]);
	}
	const match: RegExpExecArray | null = apply(regexExec, arnPattern, [
		input.secretArn,
	]);
	if (!match?.[2])
		throw new AwsSecretError(
			"AWS_SECRET_GRANT_INVALID",
			"the exact secret ARN is required",
		);
	const region = match[2];
	const grant: AwsSecretGrant = freeze({
		secretArn: input.secretArn,
		resourceEpoch: input.resourceEpoch,
		grantEpoch: input.grantEpoch,
		allow: freeze(allow),
	});
	const authorized = (operation: AwsSecretOperation, key: string) => {
		try {
			return (
				apply(arrayIncludes, grant.allow, [
					operation === "put" ? "put" : "access",
				]) && acceptSynchronousTrue(verify(grant, operation, key))
			);
		} catch {
			return false;
		}
	};
	const boundary = createAwsRuntimeBoundary<AwsSecretOperation>({
		layer,
		authorize: authorized,
		denied: () =>
			new AwsSecretError("AWS_SECRET_DENIED", "operation is not authorized"),
		capacity: () =>
			new AwsSecretError("AWS_SECRET_CAPACITY", "too many outstanding calls"),
		unavailable: (operation) =>
			new AwsSecretError(
				operation === "put"
					? "AWS_SECRET_MUTATION_OUTCOME_UNKNOWN"
					: "AWS_SECRET_READ_UNAVAILABLE",
				operation === "put"
					? "write may have completed; reconcile using the persisted version id"
					: "secret read failed",
			),
	});
	const read = async (
		operation: "access" | "access-version",
		requested?: string,
	) => {
		const key = requested ?? "latest";
		const request =
			requested === undefined
				? { SecretId: grant.secretArn, region }
				: { SecretId: grant.secretArn, region, VersionId: requested };
		const result = (
			await boundary.run(operation, key, SecretsManager.getSecretValue(request))
		).value;
		if (
			result.ARN !== grant.secretArn ||
			!result.VersionId ||
			!matches(versionPattern, result.VersionId) ||
			(requested !== undefined && result.VersionId !== requested) ||
			result.SecretString !== undefined ||
			result.SecretBinary === undefined
		)
			throw new AwsSecretError(
				"AWS_SECRET_READ_UNAVAILABLE",
				"secret version is not representable",
			);
		let value: Uint8Array;
		try {
			value = copyBytes(
				Redacted.isRedacted(result.SecretBinary)
					? Redacted.value(result.SecretBinary)
					: result.SecretBinary,
			);
		} catch {
			throw new AwsSecretError(
				"AWS_SECRET_READ_UNAVAILABLE",
				"secret version is not representable",
			);
		}
		const output = { versionId: result.VersionId, value };
		define(output, "then", { value: undefined });
		boundary.beforeReturn(operation, key);
		return output;
	};
	const store: AwsSecretStore = freeze({
		async put(value: Uint8Array, versionId: string) {
			const id = version(versionId);
			let copy: Uint8Array;
			try {
				copy = copyBytes(value);
			} catch {
				throw new AwsSecretError(
					"AWS_SECRET_VALUE_INVALID",
					"secret value is outside the supported byte limits",
				);
			}
			try {
				const result = (
					await boundary.run(
						"put",
						id,
						SecretsManager.putSecretValue({
							SecretId: grant.secretArn,
							ClientRequestToken: id,
							SecretBinary: Redacted.make(copy),
							region,
						}),
					)
				).value;
				if (result.ARN !== grant.secretArn || result.VersionId !== id)
					throw new Error("unconfirmed version");
				boundary.beforeReturn("put", id);
				return id;
			} catch (error) {
				if (
					error instanceof AwsSecretError &&
					(error.code === "AWS_SECRET_DENIED" ||
						error.code === "AWS_SECRET_CAPACITY")
				)
					throw error;
				throw new AwsSecretError(
					"AWS_SECRET_MUTATION_OUTCOME_UNKNOWN",
					"write may have completed; reconcile using the persisted version id",
					id,
				);
			}
		},
		async access() {
			const result = await read("access");
			boundary.beforeReturn("access", "latest");
			return result;
		},
		async accessVersion(versionId: string) {
			const id = version(versionId);
			const result = await read("access-version", id);
			boundary.beforeReturn("access-version", id);
			return result.value;
		},
		async listVersions() {
			const result = (
				await boundary.run(
					"list-versions",
					"versions",
					SecretsManager.listSecretVersionIds({
						SecretId: grant.secretArn,
						IncludeDeprecated: true,
						MaxResults: AWS_SECRET_MAX_VERSIONS,
						region,
					}),
				)
			).value;
			if (
				result.ARN !== grant.secretArn ||
				result.NextToken !== undefined ||
				!isArray(result.Versions) ||
				isProxy(result.Versions) ||
				result.Versions.length > AWS_SECRET_MAX_VERSIONS
			)
				throw new AwsSecretError(
					"AWS_SECRET_READ_UNAVAILABLE",
					"version list is incomplete",
				);
			const entries: { id: string; created: number }[] = [];
			for (let index = 0; index < result.Versions.length; index++) {
				const item = result.Versions[index];
				if (
					!item?.VersionId ||
					!matches(versionPattern, item.VersionId) ||
					!item.CreatedDate
				)
					throw new AwsSecretError(
						"AWS_SECRET_READ_UNAVAILABLE",
						"version list is not representable",
					);
				let created: number;
				try {
					created = apply(dateTime, item.CreatedDate, []);
				} catch {
					throw new AwsSecretError(
						"AWS_SECRET_READ_UNAVAILABLE",
						"version list is not representable",
					);
				}
				if (!Number.isFinite(created))
					throw new AwsSecretError(
						"AWS_SECRET_READ_UNAVAILABLE",
						"version list is not representable",
					);
				for (let prior = 0; prior < entries.length; prior++) {
					const previous = entries[prior];
					if (previous?.id === item.VersionId || previous?.created === created)
						throw new AwsSecretError(
							"AWS_SECRET_READ_UNAVAILABLE",
							"version list cannot establish a unique newest-first order",
						);
				}
				apply(arrayPush, entries, [{ id: item.VersionId, created }]);
			}
			apply(arraySort, entries, [
				(
					a: { id: string; created: number },
					b: { id: string; created: number },
				) => b.created - a.created,
			]);
			const versions: string[] = [];
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index];
				if (!entry)
					throw new AwsSecretError(
						"AWS_SECRET_READ_UNAVAILABLE",
						"version list is not representable",
					);
				apply(arrayPush, versions, [entry.id]);
			}
			define(versions, "then", { value: undefined });
			freeze(versions);
			boundary.beforeReturn("list-versions", "versions");
			return versions;
		},
	});
	apply(weakSet, grants, [store, grant]);
	return store;
}
