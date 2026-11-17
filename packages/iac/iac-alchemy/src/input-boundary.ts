import { types } from "node:util";
import { create } from "@bufbuild/protobuf";
import { type Target, TargetSchema } from "./_generated/alchemy_iac_pb.js";
import { AlchemyIacError } from "./plan.js";

const TARGET_KEYS = [
	"targetId",
	"tenantId",
	"stackName",
	"stage",
	"programResourceId",
	"sourceDigest",
	"inventoryEvidenceRef",
	"resources",
] as const;
const SCOPE_KEYS = [
	"resourceId",
	"resourceType",
	"providerId",
	"providerAccountRef",
	"productId",
] as const;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- SAFETY: input is an untrusted structural boundary; checks use descriptors and reject proxies before reflection. */
function dataRecord(
	input: unknown,
	required: readonly string[],
	typeName?: string,
): Record<string, unknown> | undefined {
	if (
		typeof input !== "object" ||
		input === null ||
		types.isProxy(input) ||
		Array.isArray(input)
	)
		return undefined;
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const allowed = new Set(
		typeName === undefined ? required : [...required, "$typeName"],
	);
	// Refuse enumerable extras before collecting all own keys, so common oversized
	// records stop at the first unknown property.
	let count = 0;
	for (const key in input) {
		if (++count > allowed.size || !allowed.has(key)) return undefined;
	}
	const keys = Reflect.ownKeys(input);
	if (keys.length < required.length || keys.length > allowed.size)
		return undefined;
	const copy: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string" || !allowed.has(key)) return undefined;
		const property = Object.getOwnPropertyDescriptor(input, key);
		if (
			property === undefined ||
			!("value" in property) ||
			!property.enumerable
		)
			return undefined;
		copy[key] = property.value;
	}
	if (required.some((key) => !Object.hasOwn(copy, key))) return undefined;
	if (Object.hasOwn(copy, "$typeName") && copy.$typeName !== typeName)
		return undefined;
	return copy;
}

function dataArray(input: unknown, limit: number): unknown[] | undefined {
	if (types.isProxy(input) || !Array.isArray(input)) return undefined;
	if (Object.getPrototypeOf(input) !== Array.prototype) return undefined;
	const length = Object.getOwnPropertyDescriptor(input, "length");
	if (
		length === undefined ||
		!("value" in length) ||
		!Number.isSafeInteger(length.value) ||
		length.value < 0 ||
		length.value > limit
	)
		return undefined;
	const keys = Reflect.ownKeys(input);
	if (keys.length !== length.value + 1) return undefined;
	const copy: unknown[] = [];
	for (let index = 0; index < length.value; index++) {
		const property = Object.getOwnPropertyDescriptor(input, String(index));
		if (
			property === undefined ||
			!("value" in property) ||
			!property.enumerable
		)
			return undefined;
		copy.push(property.value);
	}
	return copy;
}

function boundedName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

/** Copy only complete, bounded data before protobuf can normalize any input. */
export function captureAlchemyTarget(input: unknown): Target {
	try {
		const data = dataRecord(input, TARGET_KEYS, "hobo.iac.alchemy.v1.Target");
		if (data === undefined) throw new Error("invalid target");
		const {
			targetId,
			tenantId,
			stackName,
			stage,
			programResourceId,
			sourceDigest,
			inventoryEvidenceRef,
		} = data;
		if (
			!boundedName(targetId) ||
			!boundedName(tenantId) ||
			!boundedName(stackName) ||
			!boundedName(stage) ||
			!boundedName(programResourceId) ||
			!boundedName(inventoryEvidenceRef) ||
			typeof sourceDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/u.test(sourceDigest)
		)
			throw new Error("invalid target fields");
		const rows = dataArray(data.resources, 256);
		if (rows === undefined || rows.length === 0)
			throw new Error("invalid target resources");
		const resources = rows.map((row) => {
			const scope = dataRecord(
				row,
				SCOPE_KEYS,
				"hobo.iac.alchemy.v1.ResourceScope",
			);
			if (scope === undefined) throw new Error("invalid resource scope");
			const {
				resourceId,
				resourceType,
				providerId,
				providerAccountRef,
				productId,
			} = scope;
			if (
				!boundedName(resourceId) ||
				!boundedName(resourceType) ||
				!boundedName(providerId) ||
				!boundedName(providerAccountRef) ||
				!boundedName(productId)
			)
				throw new Error("invalid resource fields");
			return {
				resourceId,
				resourceType,
				providerId,
				providerAccountRef,
				productId,
			};
		});
		return create(TargetSchema, {
			targetId,
			tenantId,
			stackName,
			stage,
			programResourceId,
			sourceDigest,
			inventoryEvidenceRef,
			resources,
		});
	} catch {
		throw new AlchemyIacError(
			"TARGET_INVALID",
			"a bounded, complete, unambiguous target is required",
		);
	}
}

/** Capture the own target field without running an options proxy or accessor. */
export function captureAlchemyTargetOption(options: unknown): Target {
	try {
		if (
			typeof options !== "object" ||
			options === null ||
			types.isProxy(options)
		)
			throw new Error("invalid options");
		const property = Object.getOwnPropertyDescriptor(options, "target");
		if (
			property === undefined ||
			!("value" in property) ||
			!property.enumerable
		)
			throw new Error("invalid target option");
		return captureAlchemyTarget(property.value);
	} catch (error) {
		if (error instanceof AlchemyIacError) throw error;
		throw new AlchemyIacError(
			"TARGET_INVALID",
			"the target option must be plain data",
		);
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof */
