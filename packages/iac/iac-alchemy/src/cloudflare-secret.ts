import { createHash } from "node:crypto";
import { types } from "node:util";
import * as Redacted from "effect/Redacted";
import { AlchemyIacError } from "./plan.js";
import { isAlchemyRedacted } from "./secret-fingerprint.js";

export interface CloudflareSecretDefinition {
	readonly bindleName: string;
	readonly resourceName: string;
	readonly accountId: string;
	readonly storeId: string;
	readonly secretName: string;
	readonly value: Redacted.Redacted<string>;
}

const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const getPrototype = Object.getPrototypeOf;
const defineProperty = Object.defineProperty;
const freeze = Object.freeze;
const create = Object.create;
const hasOwn = Object.hasOwn;
const isArray = Array.isArray;
const isProxy = types.isProxy;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const apply = Reflect.apply;
const trim = String.prototype.trim;
const test = RegExp.prototype.test;
const stringify = JSON.stringify;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: the settings are external data checked using captured intrinsics before resource construction. */
function validName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		apply(trim, value, []) === value &&
		!apply(test, /[\p{Cc}\uD800-\uDFFF]/u, [value]) &&
		Buffer.byteLength(value, "utf8") <= 200
	);
}

export function cloudflareSecretResourceId(
	bindleName: string,
	resourceName: string,
): string {
	if (!validName(bindleName) || !validName(resourceName))
		throw new AlchemyIacError(
			"SECRET_CONFIG_INVALID",
			"bounded secret identities are required",
		);
	const digest = createHash("sha256")
		.update(stringify([bindleName, resourceName]))
		.digest("hex");
	return `hobo-secret-${digest}`;
}

export function captureCloudflareSecrets(
	input: readonly CloudflareSecretDefinition[] | undefined,
): readonly CloudflareSecretDefinition[] {
	if (input === undefined) return freeze([]);
	try {
		if (
			isProxy(input) ||
			!isArray(input) ||
			getPrototype(input) !== arrayPrototype ||
			input.length > 256 ||
			ownKeys(input).length !== input.length + 1
		)
			throw new Error("invalid array");
		const result: CloudflareSecretDefinition[] = [];
		for (let index = 0; index < input.length; index++) {
			const element = getOwnDescriptor(input, String(index));
			if (!element || !hasOwn(element, "value") || !element.enumerable)
				throw new Error("invalid element");
			const entry = element.value;
			if (
				typeof entry !== "object" ||
				entry === null ||
				isProxy(entry) ||
				isArray(entry)
			)
				throw new Error("invalid record");
			const prototype = getPrototype(entry);
			if (prototype !== objectPrototype && prototype !== null)
				throw new Error("invalid prototype");
			const keys = ownKeys(entry);
			if (keys.length !== 6) throw new Error("invalid fields");
			for (let position = 0; position < keys.length; position++) {
				const key = keys[position];
				if (
					key !== "bindleName" &&
					key !== "resourceName" &&
					key !== "accountId" &&
					key !== "storeId" &&
					key !== "secretName" &&
					key !== "value"
				)
					throw new Error("invalid fields");
			}
			const field = (name: string) => {
				const descriptor = getOwnDescriptor(entry, name);
				if (
					!descriptor ||
					!hasOwn(descriptor, "value") ||
					!descriptor.enumerable
				)
					throw new Error("invalid field");
				return descriptor.value;
			};
			const bindleName = field("bindleName");
			const resourceName = field("resourceName");
			const accountId = field("accountId");
			const storeId = field("storeId");
			const secretName = field("secretName");
			const redacted = field("value");
			if (
				!validName(bindleName) ||
				!validName(resourceName) ||
				!validName(accountId) ||
				!apply(test, /^[A-Za-z0-9_-]+$/u, [accountId]) ||
				!validName(storeId) ||
				!apply(test, /^[A-Za-z0-9_-]+$/u, [storeId]) ||
				!validName(secretName) ||
				!apply(test, /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u, [secretName]) ||
				typeof redacted !== "object" ||
				redacted === null ||
				!isAlchemyRedacted(redacted)
			)
				throw new Error("invalid definition");
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the exact Redacted prototype was checked and Effect verifies its private registry.
			const secret = Redacted.value(redacted as Redacted.Redacted<unknown>);
			if (
				typeof secret !== "string" ||
				secret.length > 4096 ||
				apply(test, /[\uD800-\uDFFF]/u, [secret]) ||
				Buffer.byteLength(secret, "utf8") > 4096
			)
				throw new Error("invalid secret value");
			for (let priorIndex = 0; priorIndex < result.length; priorIndex++) {
				const prior = result[priorIndex];
				if (
					prior === undefined ||
					(prior.bindleName === bindleName &&
						prior.resourceName === resourceName) ||
					(prior.accountId === accountId &&
						prior.storeId === storeId &&
						prior.secretName === secretName)
				)
					throw new Error("duplicate secret");
			}
			const descriptor: PropertyDescriptor = create(null);
			descriptor.value = freeze({
				bindleName,
				resourceName,
				accountId,
				storeId,
				secretName,
				value: Redacted.make(secret),
			});
			descriptor.enumerable = true;
			descriptor.configurable = true;
			descriptor.writable = true;
			defineProperty(result, String(result.length), freeze(descriptor));
		}
		return freeze(result);
	} catch {
		throw new AlchemyIacError(
			"SECRET_CONFIG_INVALID",
			"secret definitions must be bounded, unique own data with a redacted string value",
		);
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply */
