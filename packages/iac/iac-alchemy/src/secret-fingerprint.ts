import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import { types as utilTypes } from "node:util";
import * as Redacted from "effect/Redacted";

/** Scope of a host-owned key used to pin secrets in an Alchemy plan. */
export interface AlchemySecretScope {
	readonly tenantId: string;
	readonly targetId: string;
	readonly stackName: string;
	readonly stage: string;
}

/**
 * Host-owned secret identity authority. The key must be generated with a
 * cryptographically secure RNG, kept confidential and stable for the entire
 * plan/retry/reconciliation lifetime, including across process restarts.
 * The verifier independently authenticates its key, epoch, scope and proof,
 * and fences rotation or credential changes through provider completion.
 */
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

/** Parameters used when the host hashes an independently obtained prior state. */
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

const secretKeyPrototype = Object.getPrototypeOf(
	createSecretKey(Buffer.alloc(32)),
);
const redactedPrototype = Object.getPrototypeOf(Redacted.make(""));

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/no-unknown-returns, anti-slop/no-reflect-apply -- SAFETY: host capabilities and Redacted values cross an untrusted JavaScript boundary and are inspected before use; Reflect.apply avoids a mutable function.call property. */
function field(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (
		descriptor === undefined ||
		!("value" in descriptor) ||
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
		utilTypes.isProxy(value) ||
		Array.isArray(value)
	)
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Snapshot the capability without logging or serializing its key. */
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
		utilTypes.isProxy(key) ||
		!utilTypes.isKeyObject(key) ||
		Object.getPrototypeOf(key) !== secretKeyPrototype ||
		Object.hasOwn(key, "type") ||
		Object.hasOwn(key, "symmetricKeySize") ||
		key.type !== "secret" ||
		key.symmetricKeySize === undefined ||
		key.symmetricKeySize < 32 ||
		key.symmetricKeySize > 64 ||
		!bounded(epoch, 200) ||
		!bounded(proofRef, 200) ||
		typeof verify !== "function" ||
		utilTypes.isProxy(verify)
	)
		throw new Error("invalid secret authority");
	return Object.freeze({
		key,
		epoch,
		proofRef,
		verify: (claim: AlchemySecretFingerprintClaim) =>
			Reflect.apply(verify, input, [claim]) === true,
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

/** True only for the precise Effect wrapper prototype; a forged wrapper still fails its WeakMap lookup. */
export function isAlchemyRedacted(value: object): boolean {
	return (
		!utilTypes.isProxy(value) &&
		Object.getPrototypeOf(value) === redactedPrototype
	);
}

/** Return a keyed, scope-and-path-separated identity, never the wrapped value. */
export function fingerprintAlchemyRedacted(
	value: object,
	context: CapturedAlchemySecrets,
	path: readonly (string | number)[],
): string {
	try {
		if (
			!isAlchemyRedacted(value) ||
			Object.getOwnPropertySymbols(value).length !== 0
		)
			throw new Error("invalid secret");
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Object.keys(descriptors);
		if (keys.some((key) => key !== "label")) throw new Error("invalid secret");
		const label = descriptors.label;
		if (
			label !== undefined &&
			(!("value" in label) ||
				!label.enumerable ||
				typeof label.value !== "string" ||
				label.value.length > 200 ||
				/[\uD800-\uDFFF]/u.test(label.value) ||
				Buffer.byteLength(label.value, "utf8") > 200)
		)
			throw new Error("invalid secret");
		// Effect's WeakMap rejects forged or wiped wrappers. Never expose its error,
		// since Effect may include a label in the exception.
		// SAFETY: the exact prototype and own data properties were checked above;
		// Redacted.value additionally verifies Effect's private WeakMap.
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
