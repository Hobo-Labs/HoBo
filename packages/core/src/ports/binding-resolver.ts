export const RESOURCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export type ResourceId = string & { readonly __brand: "ResourceId" };

export function parseResourceId(raw: string): ResourceId {
	if (!RESOURCE_ID_PATTERN.test(raw)) {
		throw new TypeError(`invalid resource id: ${raw}`);
	}
	return raw as ResourceId;
}

export type BindingSource =
	| "runtime-local"
	| "named"
	| "overlay"
	| "service-discovery";

export interface ResolvedBinding {
	readonly value: string;
	readonly source: BindingSource;
}

export interface BindingResolverPort {
	resolve(resourceId: ResourceId, property: string): Promise<ResolvedBinding>;
}
