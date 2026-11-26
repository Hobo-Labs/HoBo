import type { JsonValue } from "../json.js";
import {
	enumValue,
	expectObject,
	nonEmptyString,
	uniqueStringArray,
} from "../parse-utils.js";
import { CapabilityParseError } from "./errors.js";
import type { CapabilityGrant } from "./types.js";

const CAPABILITY_GRANT_KEYS = [
	"componentId",
	"importInterface",
	"resource",
	"operations",
] as const;

export function parseCapabilityGrant(
	input: JsonValue | undefined,
): CapabilityGrant {
	const source = expectObject(input, "CapabilityGrant", CapabilityParseError);
	const allowedKeys = new Set<string>(CAPABILITY_GRANT_KEYS);
	for (const key of Object.keys(source)) {
		if (!allowedKeys.has(key)) {
			throw new CapabilityParseError(
				"CapabilityGrant",
				`only keys ${CAPABILITY_GRANT_KEYS.join(", ")}`,
				key,
			);
		}
	}

	const operations = uniqueStringArray(
		source.operations,
		"operations",
		CapabilityParseError,
		{
			minLength: 1,
		},
	).sort();

	return Object.freeze({
		componentId: nonEmptyString(
			source.componentId,
			"componentId",
			CapabilityParseError,
		),
		importInterface: nonEmptyString(
			source.importInterface,
			"importInterface",
			CapabilityParseError,
		),
		resource: nonEmptyString(source.resource, "resource", CapabilityParseError),
		operations: Object.freeze(operations),
	});
}

export function parseCapabilityGrantList(
	input: JsonValue | undefined,
): readonly CapabilityGrant[] {
	if (!Array.isArray(input)) {
		throw new CapabilityParseError("grants", "array", input);
	}
	return Object.freeze(
		input.map((entry, index) => {
			try {
				return parseCapabilityGrant(entry);
			} catch (error) {
				if (error instanceof CapabilityParseError) {
					throw new CapabilityParseError(
						`grants[${index}]`,
						error.expected,
						error.received,
					);
				}
				throw error;
			}
		}),
	);
}

export function assertCapabilityDenialCode(
	value: JsonValue | undefined,
	field: string,
): import("./types.js").CapabilityDenialCode {
	const allowed = new Set([
		"capability.import-not-declared",
		"capability.export-not-found",
		"capability.no-inferred-grant",
		"capability.operation-not-granted",
		"capability.no-linked-route",
		"capability.fabricated-handle",
		"capability.operation-not-found",
		"capability.component-not-registered",
		"capability.provider-not-registered",
	] as const);
	return enumValue(value, allowed, field, CapabilityParseError);
}
