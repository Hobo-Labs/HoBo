/** A provider-neutral source identity inspected alongside the financial plan. */
export interface AlchemySourceClaim {
	readonly resourceId: string;
	readonly resourceType: string;
	readonly bindleName: string;
	readonly applicationName: string;
	readonly sourceKind: string;
	readonly sourcePath: string;
	readonly sourceDigest: string;
	readonly environmentDigest: string;
	readonly proofRef: string;
}

/** Host-authenticated inventory of source-bearing resources expected in the plan. */
export type AlchemySourceRequirement = Pick<
	AlchemySourceClaim,
	| "resourceId"
	| "resourceType"
	| "bindleName"
	| "applicationName"
	| "sourceKind"
	| "sourcePath"
>;

export interface AlchemySourceFence {
	readonly sourceDigest: string;
	readonly environmentDigest: string;
	readonly proofRef: string;
	/**
	 * Trusted host authority. A true result promises that the exact source,
	 * transitive inputs, module cache and build toolchain are fenced until the
	 * provider has completed upload, and that the claim is authorized.
	 */
	readonly verify: (claim: AlchemySourceClaim) => boolean;
}

interface SourceBinding {
	readonly claim: AlchemySourceClaim;
	readonly verify: (claim: AlchemySourceClaim) => boolean;
}

export interface AlchemySourceResource {
	readonly FQN: string;
	readonly Type: string;
}

const sources = new WeakMap<object, SourceBinding>();
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: these functions parse host-owned authority data without invoking accessors. */
function data(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		Object.getOwnPropertySymbols(value).length !== 0
	)
		return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Object.keys(descriptors).length !== keys.length) return undefined;
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const property = descriptors[key];
		if (
			property === undefined ||
			!("value" in property) ||
			!property.enumerable
		)
			return undefined;
		result[key] = property.value;
	}
	return result;
}

function bounded(value: unknown, limit: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= limit &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

export function captureAlchemySourceRequirements(
	input: readonly AlchemySourceRequirement[] | undefined,
): readonly AlchemySourceRequirement[] | undefined {
	try {
		if (
			!Array.isArray(input) ||
			input.length > 256 ||
			Object.getOwnPropertySymbols(input).length !== 0
		)
			return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(input);
		if (
			Object.keys(descriptors).some(
				(key) =>
					key !== "length" &&
					(!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= input.length),
			)
		)
			return undefined;
		const result: AlchemySourceRequirement[] = [];
		const names = new Set<string>();
		for (let index = 0; index < input.length; index++) {
			const item = descriptors[String(index)];
			if (item === undefined || !("value" in item) || !item.enumerable)
				return undefined;
			const fields = data(item.value, [
				"resourceId",
				"resourceType",
				"bindleName",
				"applicationName",
				"sourceKind",
				"sourcePath",
			]);
			if (
				fields === undefined ||
				!bounded(fields.resourceId, 200) ||
				!bounded(fields.resourceType, 200) ||
				!bounded(fields.bindleName, 200) ||
				!bounded(fields.applicationName, 200) ||
				!bounded(fields.sourceKind, 200) ||
				!bounded(fields.sourcePath, 4096) ||
				names.has(fields.resourceId)
			)
				return undefined;
			names.add(fields.resourceId);
			result.push(
				Object.freeze({
					resourceId: fields.resourceId,
					resourceType: fields.resourceType,
					bindleName: fields.bindleName,
					applicationName: fields.applicationName,
					sourceKind: fields.sourceKind,
					sourcePath: fields.sourcePath,
				}),
			);
		}
		return Object.freeze(result);
	} catch {
		return undefined;
	}
}

/** Snapshot an authority once; getters, malformed proofs and unbounded values fail closed. */
export function captureAlchemySourceFence(
	input: AlchemySourceFence | undefined,
): AlchemySourceFence | undefined {
	try {
		const fields = data(input, [
			"sourceDigest",
			"environmentDigest",
			"proofRef",
			"verify",
		]);
		if (
			fields === undefined ||
			!bounded(fields.sourceDigest, 71) ||
			!DIGEST.test(fields.sourceDigest) ||
			!bounded(fields.environmentDigest, 71) ||
			!DIGEST.test(fields.environmentDigest) ||
			!bounded(fields.proofRef, 200) ||
			typeof fields.verify !== "function"
		)
			return undefined;
		return Object.freeze({
			sourceDigest: fields.sourceDigest,
			environmentDigest: fields.environmentDigest,
			proofRef: fields.proofRef,
			// SAFETY: the runtime guard above established that the host verifier is callable.
			verify: fields.verify as AlchemySourceFence["verify"],
		});
	} catch {
		return undefined;
	}
}

function captureClaim(
	input: AlchemySourceClaim,
): AlchemySourceClaim | undefined {
	const fields = data(input, [
		"resourceId",
		"resourceType",
		"bindleName",
		"applicationName",
		"sourceKind",
		"sourcePath",
		"sourceDigest",
		"environmentDigest",
		"proofRef",
	]);
	if (
		fields === undefined ||
		!bounded(fields.resourceId, 200) ||
		!bounded(fields.resourceType, 200) ||
		!bounded(fields.bindleName, 200) ||
		!bounded(fields.applicationName, 200) ||
		!bounded(fields.sourceKind, 200) ||
		!bounded(fields.sourcePath, 4096) ||
		!bounded(fields.sourceDigest, 71) ||
		!DIGEST.test(fields.sourceDigest) ||
		!bounded(fields.environmentDigest, 71) ||
		!DIGEST.test(fields.environmentDigest) ||
		!bounded(fields.proofRef, 200)
	)
		return undefined;
	return Object.freeze({
		resourceId: fields.resourceId,
		resourceType: fields.resourceType,
		bindleName: fields.bindleName,
		applicationName: fields.applicationName,
		sourceKind: fields.sourceKind,
		sourcePath: fields.sourcePath,
		sourceDigest: fields.sourceDigest,
		environmentDigest: fields.environmentDigest,
		proofRef: fields.proofRef,
	});
}

/** Check an exact source claim with the captured host authority. */
export function verifyAlchemySourceFence(
	fence: AlchemySourceFence,
	input: AlchemySourceClaim,
): boolean {
	try {
		const claim = captureClaim(input);
		return (
			claim !== undefined &&
			claim.sourceDigest === fence.sourceDigest &&
			claim.environmentDigest === fence.environmentDigest &&
			claim.proofRef === fence.proofRef &&
			fence.verify(claim) === true
		);
	} catch {
		return false;
	}
}

/** Register the exact resource returned by the Alchemy component. */
export function registerAlchemySource(
	resource: AlchemySourceResource,
	binding: SourceBinding,
): void {
	const claim = captureClaim(binding.claim);
	if (
		claim === undefined ||
		resource.FQN !== claim.resourceId ||
		resource.Type !== claim.resourceType ||
		!(binding.verify instanceof Function) ||
		sources.has(resource)
	)
		throw new Error("source binding is invalid or already registered");
	sources.set(resource, Object.freeze({ claim, verify: binding.verify }));
}

/** Resource identity is preserved by Alchemy between declaration and planning. */
export function alchemySourceFor(
	resource: AlchemySourceResource,
): SourceBinding | undefined {
	return sources.get(resource);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
