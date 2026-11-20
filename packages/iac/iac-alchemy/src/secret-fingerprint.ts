import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import { types as utilTypes } from "node:util";
import * as Redacted from "effect/Redacted";
import { acceptSynchronousTrue } from "./synchronous-result.js";

export interface AlchemySecretScope {
	readonly tenantId: string;
	readonly targetId: string;
	readonly stackName: string;
	readonly stage: string;
}

export interface AlchemySecretFingerprint {
	readonly key: KeyObject;
	readonly epoch: string;
	readonly proofRef: string;
	readonly verify: (claim: AlchemySecretFingerprintClaim) => boolean;
}

export interface AlchemySecretFingerprintClaim extends AlchemySecretScope {
	readonly key: KeyObject;
	readonly epoch: string;
	readonly proofRef: string;
	readonly domain: "plan" | "prior-state" | "deletion-properties";
	readonly resourceId: string;
	readonly resourceType: string;
}

export interface AlchemyPriorStateSecrets {
	readonly scope: AlchemySecretScope;
	readonly fingerprint: AlchemySecretFingerprint;
	readonly resourceId: string;
	readonly resourceType: string;
}

export interface CapturedAlchemySecrets {
	readonly scope: AlchemySecretScope;
	readonly fingerprint: AlchemySecretFingerprint;
	readonly domain: "plan" | "prior-state" | "deletion-properties";
	readonly resourceId: string;
	readonly resourceType: string;
}

const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getOwnDescriptors = Object.getOwnPropertyDescriptors;
const getOwnSymbols = Object.getOwnPropertySymbols;
const getPrototype = Object.getPrototypeOf;
const objectKeys = Object.keys;
const isArray = Array.isArray;

const secretKeyPrototype = getPrototype(createSecretKey(Buffer.alloc(32)));
const redactedPrototype = getPrototype(Redacted.make(""));
const applyHostVerifier = Reflect.apply;
const secretKeyType = getOwnDescriptor(
	getPrototype(secretKeyPrototype),
	"type",
)?.get;
const secretKeySize = getOwnDescriptor(
	secretKeyPrototype,
	"symmetricKeySize",
)?.get;
const hasOwnDescriptor = Object.hasOwn;
const isProxy = utilTypes.isProxy;
const isKeyObject = utilTypes.isKeyObject;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/no-unknown-returns, anti-slop/no-reflect-apply -- SAFETY: host capabilities and Redacted values cross an untrusted JavaScript boundary and are inspected before use; Reflect.apply avoids a mutable function.call property. */
function field(value: object, key: string): unknown {
	const descriptor = getOwnDescriptor(value, key);
	if (
		descriptor === undefined ||
		!hasOwnDescriptor(descriptor, "value") ||
		!descriptor.enumerable
	)
		throw new Error("invalid secret authority");
	return descriptor.value;
}

function bounded(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		value.trim() === value &&
		!/[\p{Cc}\uD800-\uDFFF]/u.test(value) &&
		Buffer.byteLength(value, "utf8") <= maximum
	);
}

function plain(value: unknown): value is object {
	if (
		typeof value !== "object" ||
		value === null ||
		isProxy(value) ||
		isArray(value)
	)
		return false;
	const prototype = getPrototype(value);
	return prototype === Object.prototype || prototype === null;
}

export function captureAlchemySecretFingerprint(
	input: unknown,
): AlchemySecretFingerprint {
	if (!plain(input)) throw new Error("invalid secret authority");
	const key = field(input, "key");
	const epoch = field(input, "epoch");
	const proofRef = field(input, "proofRef");
	const verify = field(input, "verify");
	if (
		typeof key !== "object" ||
		key === null ||
		isProxy(key) ||
		!isKeyObject(key) ||
		getPrototype(key) !== secretKeyPrototype ||
		hasOwnDescriptor(key, "type") ||
		hasOwnDescriptor(key, "symmetricKeySize") ||
		typeof secretKeyType !== "function" ||
		typeof secretKeySize !== "function" ||
		applyHostVerifier(secretKeyType, key, []) !== "secret" ||
		applyHostVerifier(secretKeySize, key, []) < 32 ||
		applyHostVerifier(secretKeySize, key, []) > 64 ||
		!bounded(epoch, 200) ||
		!bounded(proofRef, 200) ||
		typeof verify !== "function" ||
		isProxy(verify)
	)
		throw new Error("invalid secret authority");
	return Object.freeze({
		key,
		epoch,
		proofRef,
		verify: (claim: AlchemySecretFingerprintClaim) =>
			acceptSynchronousTrue(applyHostVerifier(verify, input, [claim])),
	});
}

export function captureAlchemySecretScope(input: unknown): AlchemySecretScope {
	if (!plain(input)) throw new Error("invalid secret scope");
	const tenantId = field(input, "tenantId");
	const targetId = field(input, "targetId");
	const stackName = field(input, "stackName");
	const stage = field(input, "stage");
	if (
		!bounded(tenantId, 200) ||
		!bounded(targetId, 200) ||
		!bounded(stackName, 602) ||
		!bounded(stage, 200)
	)
		throw new Error("invalid secret scope");
	return Object.freeze({ tenantId, targetId, stackName, stage });
}

export function captureAlchemySecrets(
	input: AlchemyPriorStateSecrets,
): CapturedAlchemySecrets {
	if (!plain(input)) throw new Error("invalid secret authority");
	const resourceId = field(input, "resourceId");
	const resourceType = field(input, "resourceType");
	if (!bounded(resourceId, 200) || !bounded(resourceType, 200))
		throw new Error("invalid secret resource");
	return Object.freeze({
		scope: captureAlchemySecretScope(field(input, "scope")),
		fingerprint: captureAlchemySecretFingerprint(field(input, "fingerprint")),
		domain: "prior-state" as const,
		resourceId,
		resourceType,
	});
}

export function captureAlchemyPlanSecrets(
	scope: AlchemySecretScope,
	fingerprint: AlchemySecretFingerprint,
): CapturedAlchemySecrets {
	return Object.freeze({
		scope: captureAlchemySecretScope(scope),
		fingerprint: captureAlchemySecretFingerprint(fingerprint),
		domain: "plan" as const,
		resourceId: "",
		resourceType: "",
	});
}

export function secretResourceDomain(
	context: CapturedAlchemySecrets | undefined,
	domain: "prior-state" | "deletion-properties",
	resourceId: string,
	resourceType: string,
): CapturedAlchemySecrets | undefined {
	return context === undefined
		? undefined
		: Object.freeze({ ...context, domain, resourceId, resourceType });
}

export function verifyAlchemySecrets(context: CapturedAlchemySecrets): boolean {
	try {
		return (
			context.fingerprint.verify(
				Object.freeze({
					...context.scope,
					key: context.fingerprint.key,
					epoch: context.fingerprint.epoch,
					proofRef: context.fingerprint.proofRef,
					domain: context.domain,
					resourceId: context.resourceId,
					resourceType: context.resourceType,
				}),
			) === true
		);
	} catch {
		return false;
	}
}

export function isAlchemyRedacted(value: object): boolean {
	return !isProxy(value) && getPrototype(value) === redactedPrototype;
}

export function fingerprintAlchemyRedacted(
	value: object,
	context: CapturedAlchemySecrets,
	path: readonly (string | number)[],
): string {
	try {
		if (!isAlchemyRedacted(value) || getOwnSymbols(value).length !== 0)
			throw new Error("invalid secret");
		const descriptors = getOwnDescriptors(value);
		const keys = objectKeys(descriptors);
		if (keys.some((key) => key !== "label")) throw new Error("invalid secret");
		const label = hasOwnDescriptor(descriptors, "label")
			? descriptors.label
			: undefined;
		if (
			label !== undefined &&
			(!hasOwnDescriptor(label, "value") ||
				!label.enumerable ||
				typeof label.value !== "string" ||
				label.value.length > 200 ||
				/[\uD800-\uDFFF]/u.test(label.value) ||
				Buffer.byteLength(label.value, "utf8") > 200)
		)
			throw new Error("invalid secret");

		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the prototype and data properties were checked, and Redacted.value verifies Effect's private WeakMap.
		const secret = Redacted.value(value as Redacted.Redacted<unknown>);
		if (
			typeof secret !== "string" ||
			secret.length > 4096 ||
			/[\uD800-\uDFFF]/u.test(secret) ||
			Buffer.byteLength(secret, "utf8") > 4096
		)
			throw new Error("invalid secret");
		const prefix = JSON.stringify([
			"hobo.alchemy.redacted.v1",
			context.scope.tenantId,
			context.scope.targetId,
			context.scope.stackName,
			context.scope.stage,
			context.fingerprint.epoch,
			context.domain,
			context.resourceId,
			context.resourceType,
			path,
			label === undefined ? null : label.value,
		]);
		return `hmac-sha256:${createHmac("sha256", context.fingerprint.key).update(prefix).update("\0").update(secret, "utf8").digest("hex")}`;
	} catch {
		throw new Error("redacted value cannot be safely identified");
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/no-unknown-returns, anti-slop/no-reflect-apply */
