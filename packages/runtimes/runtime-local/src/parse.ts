import {
	type ComponentExport,
	type InterfaceId,
	type LinkRequest,
	type ParsedComponentDescriptor,
	type ProviderDescriptor,
	parseInterfaceId,
} from "@hobo/core";
import { ComponentHostError } from "./errors.js";
import { isJsonString } from "./json.js";

export type ParsedProviderDescriptor = ProviderDescriptor & {
	readonly parsed: true;
};
export type ParsedLinkRequest = LinkRequest & { readonly parsed: true };

function assertNonEmptyId<T>(
	id: T,
	code: "component_id_required" | "provider_id_required",
): string {
	if (!isJsonString(id) || id.length === 0) {
		throw new ComponentHostError(code, String(id));
	}
	return id;
}

export function parseComponentDescriptor(raw: {
	id: string;
	imports?: string[];
	exports?: Record<string, Record<string, ComponentExport>>;
	leases?: string[];
}): ParsedComponentDescriptor {
	const id = assertNonEmptyId(raw.id, "component_id_required");
	const imports = (raw.imports ?? []).map((iface) => parseInterfaceId(iface));
	return Object.freeze({
		parsed: true as const,
		id,
		imports,
		exports: raw.exports ?? {},
		...(raw.leases !== undefined ? { leases: [...raw.leases] } : undefined),
	});
}

export function parseProviderDescriptor(raw: {
	id: string;
	exports?: Record<string, Record<string, ComponentExport>>;
}): ParsedProviderDescriptor {
	const id = assertNonEmptyId(raw.id, "provider_id_required");
	return Object.freeze({
		parsed: true as const,
		id,
		exports: raw.exports ?? {},
	});
}

export function parseLinkRequest(raw: {
	componentId: string;
	importInterface: string;
	providerId: string;
	exportInterface: string;
}): ParsedLinkRequest {
	return Object.freeze({
		parsed: true as const,
		componentId: assertNonEmptyId(raw.componentId, "component_id_required"),
		importInterface: parseInterfaceId(raw.importInterface),
		providerId: assertNonEmptyId(raw.providerId, "provider_id_required"),
		exportInterface: parseInterfaceId(raw.exportInterface),
	});
}

export function isInterfaceId(value: string): value is InterfaceId {
	try {
		parseInterfaceId(value);
		return true;
	} catch {
		return false;
	}
}
