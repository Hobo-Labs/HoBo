import { types } from "node:util";
import { acceptSynchronousTrue } from "./synchronous-result.js";

const hasOwnDescriptor = Object.hasOwn;
const isProxy = types.isProxy;
const isArray = Array.isArray;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnSymbols = Object.getOwnPropertySymbols;
const getOwnDescriptors = Object.getOwnPropertyDescriptors;
const objectKeys = Object.keys;
const objectCreate = Object.create;
const defineProperty = Object.defineProperty;
const objectPrototype = Object.prototype;
const freeze = Object.freeze;
const applyCaptured = Reflect.apply;
const NativeWeakMap = WeakMap;
const weakMapHas = NativeWeakMap.prototype.has;
const weakMapGet = NativeWeakMap.prototype.get;
const weakMapSet = NativeWeakMap.prototype.set;
const NativeSet = Set;
const setHas = NativeSet.prototype.has;
const setAdd = NativeSet.prototype.add;
const nativeString = String;
const nativeNumber = Number;
const stringTrim = String.prototype.trim;
const regexpExec = RegExp.prototype.exec;

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

	readonly verify: (claim: AlchemySourceClaim) => boolean;
}

export interface AlchemySourceBinding {
	readonly claim: AlchemySourceClaim;
	readonly verify: (claim: AlchemySourceClaim) => boolean;
}

export interface AlchemySourceResource {
	readonly FQN: string;
	readonly Type: string;
}

const sources = new NativeWeakMap<object, AlchemySourceBinding>();
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONTROL = /[\p{Cc}]/u;
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/u;

function matches(pattern: RegExp, value: string): boolean {
	return applyCaptured(regexpExec, pattern, [value]) !== null;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: these functions parse host-owned authority data without invoking accessors. */
function data(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		isProxy(value) ||
		isArray(value)
	)
		return undefined;
	const prototype = getPrototypeOf(value);
	if (
		(prototype !== objectPrototype && prototype !== null) ||
		getOwnSymbols(value).length !== 0
	)
		return undefined;
	const descriptors = getOwnDescriptors(value);
	if (objectKeys(descriptors).length !== keys.length) return undefined;
	const result: Record<string, unknown> = objectCreate(null);
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		if (key === undefined) return undefined;
		const property = hasOwnDescriptor(descriptors, key)
			? descriptors[key]
			: undefined;
		if (
			property === undefined ||
			!hasOwnDescriptor(property, "value") ||
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
		applyCaptured(stringTrim, value, []) === value &&
		!matches(CONTROL, value)
	);
}

export function captureAlchemySourceRequirements(
	input: readonly AlchemySourceRequirement[] | undefined,
): readonly AlchemySourceRequirement[] | undefined {
	try {
		if (
			isProxy(input) ||
			!isArray(input) ||
			input.length > 256 ||
			getOwnSymbols(input).length !== 0
		)
			return undefined;
		const descriptors = getOwnDescriptors(input);
		const descriptorKeys = objectKeys(descriptors);
		for (let index = 0; index < descriptorKeys.length; index++) {
			const key = descriptorKeys[index];
			if (
				key === undefined ||
				(key !== "length" &&
					(!matches(ARRAY_INDEX, key) || nativeNumber(key) >= input.length))
			)
				return undefined;
		}
		const result: AlchemySourceRequirement[] = [];
		const names = new NativeSet<string>();
		for (let index = 0; index < input.length; index++) {
			const key = nativeString(index);
			const item = hasOwnDescriptor(descriptors, key)
				? descriptors[key]
				: undefined;
			if (
				item === undefined ||
				!hasOwnDescriptor(item, "value") ||
				!item.enumerable
			)
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
				applyCaptured(setHas, names, [fields.resourceId])
			)
				return undefined;
			applyCaptured(setAdd, names, [fields.resourceId]);
			const requirement = freeze({
				resourceId: fields.resourceId,
				resourceType: fields.resourceType,
				bindleName: fields.bindleName,
				applicationName: fields.applicationName,
				sourceKind: fields.sourceKind,
				sourcePath: fields.sourcePath,
			});
			const property: PropertyDescriptor = objectCreate(null);
			property.value = requirement;
			property.enumerable = true;
			property.configurable = true;
			property.writable = true;
			defineProperty(result, key, freeze(property));
		}
		return freeze(result);
	} catch {
		return undefined;
	}
}

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
			!matches(DIGEST, fields.sourceDigest) ||
			!bounded(fields.environmentDigest, 71) ||
			!matches(DIGEST, fields.environmentDigest) ||
			!bounded(fields.proofRef, 200) ||
			typeof fields.verify !== "function" ||
			isProxy(fields.verify)
		)
			return undefined;
		return freeze({
			sourceDigest: fields.sourceDigest,
			environmentDigest: fields.environmentDigest,
			proofRef: fields.proofRef,
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
		!matches(DIGEST, fields.sourceDigest) ||
		!bounded(fields.environmentDigest, 71) ||
		!matches(DIGEST, fields.environmentDigest) ||
		!bounded(fields.proofRef, 200)
	)
		return undefined;
	return freeze({
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
			acceptSynchronousTrue(fence.verify(claim))
		);
	} catch {
		return false;
	}
}

export function registerAlchemySource(
	resource: AlchemySourceResource,
	binding: AlchemySourceBinding,
): void {
	const claim = captureClaim(binding.claim);
	const verify = binding.verify;
	if (
		claim === undefined ||
		resource.FQN !== claim.resourceId ||
		resource.Type !== claim.resourceType ||
		typeof verify !== "function" ||
		isProxy(verify) ||
		applyCaptured(weakMapHas, sources, [resource])
	)
		throw new Error("source binding is invalid or already registered");
	applyCaptured(weakMapSet, sources, [resource, freeze({ claim, verify })]);
}

export function alchemySourceFor(
	resource: AlchemySourceResource,
): AlchemySourceBinding | undefined {
	return applyCaptured(weakMapGet, sources, [resource]);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
