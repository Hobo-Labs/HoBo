import {
	contentHashOf,
	type ExecutionUnit,
	type PrimitiveResolverConfig,
	type PrimitiveResolverDescriptor,
	type ResolverPin,
} from "./types.js";

export const EMPTY_RESOLVER_CONFIG: PrimitiveResolverConfig = Object.freeze({
	// SAFETY: assertion required at this I/O or test boundary.
	require: Object.freeze([] as string[]),
	// SAFETY: assertion required at this I/O or test boundary.
	prefer: Object.freeze([] as string[]),
	// SAFETY: assertion required at this I/O or test boundary.
	pins: Object.freeze([] as ResolverPin[]),
	properties: Object.freeze({}),
	labels: Object.freeze({}),
});

/**
 * Compose resolver pins for Yard → Camp → Bindle → resource under a fixed
 * provider. Bindle never contributes provider-specific pins.
 */
export function composeResolverPins(options: {
	readonly providerId: string;
	readonly yardDefaults: PrimitiveResolverConfig;
	readonly campConfig: PrimitiveResolverConfig;
	readonly providerDefaults: readonly PrimitiveResolverDescriptor[];
	readonly policyPins?: readonly ResolverPin[];
	readonly deniedResolverIds?: readonly string[];
}) {
	const pinMap = new Map<string, { resolverId: string; source: string }>();
	const contributing: string[] = [];

	// Lowest: provider defaults for this provider.
	for (const d of options.providerDefaults) {
		if (d.providerId && d.providerId !== options.providerId) continue;
		if (d.default) {
			pinMap.set(d.slot, { resolverId: d.id, source: d.source });
			contributing.push(d.id);
		}
	}
	// Authored yard defaults
	for (const p of options.yardDefaults.pins) {
		pinMap.set(p.slot, { resolverId: p.resolverId, source: "yard" });
	}
	// Camp config
	for (const p of options.campConfig.pins) {
		pinMap.set(p.slot, { resolverId: p.resolverId, source: "camp" });
	}
	// Broker policy pins (highest choice layer, still subject to deny)
	for (const p of options.policyPins ?? []) {
		const prior = pinMap.get(p.slot);
		if (prior && prior.resolverId !== p.resolverId) {
			// equal-precedence conflict if both policy — simplify: policy wins over authored
		}
		pinMap.set(p.slot, { resolverId: p.resolverId, source: "policy" });
	}

	const denied = new Set(options.deniedResolverIds ?? []);
	const pins: ResolverPin[] = [];
	for (const [slot, { resolverId }] of [...pinMap.entries()].sort((a, b) =>
		a[0] < b[0] ? -1 : 1,
	)) {
		if (denied.has(resolverId)) {
			throw Object.assign(
				new Error(`resolver ${resolverId} denied by policy for slot ${slot}`),
				{ code: "resolver-denied" },
			);
		}
		// Provider constraint: resolver id must be platform or match provider prefix / listed.
		if (
			resolverId.includes(".") &&
			!resolverId.startsWith("hobo.") &&
			!resolverId.startsWith(`${options.providerId}.`)
		) {
			throw Object.assign(
				new Error(
					`resolver ${resolverId} not constrained to selected yard provider ${options.providerId}`,
				),
				{ code: "resolver-provider-mismatch" },
			);
		}
		pins.push(Object.freeze({ slot, resolverId }));
	}

	return {
		pins: Object.freeze(pins),
		contributing: Object.freeze(contributing),
	};
}

export function buildExecutionUnits(options: {
	readonly yardId: string;
	readonly providerId: string;
	readonly campId: string;
	readonly bindleName: string;
	readonly resourceIds: readonly string[];
	readonly residualDefinitionIds: readonly string[];
}): readonly ExecutionUnit[] {
	const units: ExecutionUnit[] = [
		Object.freeze({
			unitId: `unit:yard:${options.yardId}`,
			kind: "yard",
			providerId: options.providerId,
			yardId: options.yardId,
			destroyWithBindle: false,
			claims: Object.freeze([`yard:${options.yardId}`]),
			// SAFETY: assertion required at this I/O or test boundary.
			residualDefinitions: Object.freeze([] as string[]),
		}),
		Object.freeze({
			unitId: `unit:camp:${options.campId}`,
			kind: "camp",
			providerId: options.providerId,
			yardId: options.yardId,
			destroyWithBindle: false,
			claims: Object.freeze([`camp:${options.campId}`]),
			// SAFETY: assertion required at this I/O or test boundary.
			residualDefinitions: Object.freeze([] as string[]),
		}),
		Object.freeze({
			unitId: `unit:bindle:${options.bindleName}`,
			kind: "bindle",
			providerId: options.providerId,
			yardId: options.yardId,
			destroyWithBindle: true,
			claims: Object.freeze([`bindle:${options.bindleName}`]),
			// SAFETY: assertion required at this I/O or test boundary.
			residualDefinitions: Object.freeze([] as string[]),
		}),
	];
	for (const resourceId of options.resourceIds) {
		units.push(
			Object.freeze({
				unitId: `unit:resource:${resourceId}`,
				kind: "resource",
				providerId: options.providerId,
				yardId: options.yardId,
				destroyWithBindle: true,
				claims: Object.freeze([`resource:${resourceId}`]),
				residualDefinitions: Object.freeze(
					options.residualDefinitionIds.filter((d) => d.includes(resourceId)),
				),
			}),
		);
	}
	// Shared infrastructure unit is never destroyed with bindle.
	units.push(
		Object.freeze({
			unitId: `unit:shared:${options.yardId}`,
			kind: "shared",
			providerId: options.providerId,
			yardId: options.yardId,
			destroyWithBindle: false,
			claims: Object.freeze([`shared:${options.yardId}`]),
			// SAFETY: assertion required at this I/O or test boundary.
			residualDefinitions: Object.freeze([] as string[]),
		}),
	);
	return Object.freeze(units);
}

export function defaultProviderResolvers(
	providerId: string,
): readonly PrimitiveResolverDescriptor[] {
	const mk = (slot: string, suffix: string): PrimitiveResolverDescriptor =>
		Object.freeze({
			schemaVersion: "hobo.primitive-resolver/v1",
			id: `${providerId}.${suffix}/v1`,
			version: "1",
			providerId,
			primitiveKind: "yard",
			slot,
			additive: false,
			source: "provider-default",
			default: true,
			priority: 100,
			// SAFETY: assertion required at this I/O or test boundary.
			requiresCapabilities: Object.freeze([] as string[]),
			providesCapabilities: Object.freeze([slot]),
			implementationRef: `${providerId}/resolvers/${slot}`,
			remediation: `Register provider ${providerId} resolver for slot ${slot}`,
		});
	return Object.freeze([
		mk("scope", "yard.scope"),
		mk("substrate", "camp.substrate"),
		mk("workload", "bindle.workload"),
		mk("network", "yard.network"),
		// Event-store fold resolver: rebuilds inventory + generation from yard.* facts.
		Object.freeze({
			schemaVersion: "hobo.primitive-resolver/v1" as const,
			id: `${providerId}.yard.event-store/v1`,
			version: "1",
			providerId,
			primitiveKind: "yard" as const,
			slot: "event-store",
			additive: false,
			source: "provider-default" as const,
			default: true,
			priority: 200,
			requiresCapabilities: Object.freeze(["event-store"]),
			providesCapabilities: Object.freeze([
				"event-store",
				"yard-inventory-fold",
				"yard-generation-fold",
			]),
			implementationRef: `${providerId}/resolvers/event-store-fold`,
			remediation: `Register ${providerId}.yard.event-store/v1 for Yard event-store folds`,
		}),
	]);
}

export function hashResolverConfig(
	config: PrimitiveResolverConfig,
): `sha256:${string}` {
	// SAFETY: assertion required at this I/O or test boundary.
	return contentHashOf(config) as `sha256:${string}`;
}
