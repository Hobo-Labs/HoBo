import { PortDescriptorParseError } from "./errors.js";
import type { JsonValue } from "./json.js";
import {
	deepFreeze,
	enumValue,
	expectObject,
	nonEmptyString,
} from "./parse-utils.js";

export type PortKind = "runtime" | "provider" | "port";
export type InterfaceStability = "stable" | "preview" | "experimental";

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface PortDescriptor {
	kind: PortKind;
	name: string;
	interface: string;
	stability: InterfaceStability;
}

export interface Port extends PortDescriptor {}

export interface RuntimePort extends PortDescriptor {
	kind: "runtime";
}

export interface ProviderPort extends PortDescriptor {
	kind: "provider";
}

const PORT_KINDS = new Set<PortKind>(["runtime", "provider", "port"]);
const STABILITIES = new Set<InterfaceStability>([
	"stable",
	"preview",
	"experimental",
]);
const WIT_INTERFACE_REF =
	/^[a-z][a-z0-9-]*:[a-z0-9-]+\/[a-z0-9-]+(?:@[0-9]+\.[0-9]+\.[0-9]+)?$/;

export function createPortDescriptor(
	input: JsonValue | undefined,
): PortDescriptor {
	const source = expectObject(
		input,
		"port descriptor",
		PortDescriptorParseError,
	);
	const descriptor: PortDescriptor = {
		kind: enumValue(source.kind, PORT_KINDS, "kind", PortDescriptorParseError),
		name: nonEmptyString(source.name, "name", PortDescriptorParseError),
		interface: parseInterfaceRef(source.interface, "interface"),
		stability: enumValue(
			source.stability,
			STABILITIES,
			"stability",
			PortDescriptorParseError,
		),
	};
	return deepFreeze(descriptor);
}

function parseInterfaceRef(
	value: JsonValue | undefined,
	field: string,
): string {
	const ref = nonEmptyString(value, field, PortDescriptorParseError);
	if (!WIT_INTERFACE_REF.test(ref)) {
		throw new PortDescriptorParseError(field, "WIT-style interface ref", value);
	}
	return ref;
}

export function portKey(descriptor: PortDescriptor): string {
	return `${descriptor.kind}:${descriptor.interface}:${descriptor.name}`;
}
