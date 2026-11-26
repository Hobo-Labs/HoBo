import type { BindingResolverPort, ResolvedBinding } from "@hobo/core";
import { parseResourceId, type ResourceId } from "@hobo/core";

export function createLocalBindingResolver(
	known: Readonly<Record<string, Readonly<Record<string, string>>>>,
): BindingResolverPort {
	return {
		async resolve(
			resourceId: ResourceId,
			property: string,
		): Promise<ResolvedBinding> {
			const id = parseResourceId(resourceId);
			const value = known[id]?.[property];
			if (!value) {
				throw new Error(`unknown binding ${id}.${property}`);
			}
			return { value, source: "runtime-local" };
		},
	};
}

export const HELLO_BINDLE_LOCAL_ENDPOINTS = Object.freeze({
	db: Object.freeze({
		connectionString: "sqlite://file:hello-bindle.db?mode=memory&cache=shared",
	}),
});
