/**
 * Delivery coverage (plan 0024 WP13, invariant I14): the shape a hosting
 * provider uses to say, for every hosting product it catalogs, whether it has
 * a realization path (a shipped `ResourceResolver`) or a typed refusal, and
 * which traffic offerings it can and cannot realize.
 *
 * This module is provider-neutral and deliberately identical across the WP13
 * provider packages (railway, convex, flux, webernetes): each package binds it
 * to its own tables in `hosting-coverage.ts`. It depends only on `@hobo/core`.
 *
 * Telemetry: `instrumentResolvers` emits OTel-shaped metric points through a
 * sink that is structurally a `@hobo/cd` `TelemetrySink` (`metrics(points)`),
 * so a provider package never imports the delivery plane (I11 runs the other
 * way: `@hobo/cd` never imports a provider). Emission is best effort: a sink
 * failure never changes a resolver outcome, because telemetry must not change
 * delivery. The clock is injected (I8).
 */
import {
	type HttpTransport,
	parseTrafficRoutingProviderProfile,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
	type TrafficRoutingOfferingId,
	type TrafficRoutingProviderProfile,
} from "@hobo/core";

// public-contract: versioned identity of a provider's I14 coverage document.
export const HOSTING_COVERAGE_CONTRACT = "hobo.provider-hosting-coverage/v1";

// public-contract: metric names emitted for every resolver call.
export const RESOLVER_OPERATIONS_METRIC = "hobo.cd.resolver.operations";
export const RESOLVER_DURATION_METRIC = "hobo.cd.resolver.duration";

/** Every portable traffic offering id (ADR-0143); a profile declares each one
 * as present or absent, never by omission. */
export const PORTABLE_TRAFFIC_OFFERING_IDS: readonly TrafficRoutingOfferingId[] =
	Object.freeze([
		"lb.lifecycle",
		"lb.weighted",
		"lb.health",
		"lb.locality",
		"edge.path",
		"edge.header",
		"edge.canary",
		"dns.weighted",
		"dns.failover",
		"overlay.funnel",
		"overlay.funnel.multi",
		"inprocess.weighted",
		"driver.route-bind",
		"mesh.optional",
		"observe.health",
		"observe.location",
		"resiliency.edge",
	]);

/** A catalogued hosting product this package refuses to realize, and why. */
export interface UnresolvedHostingProduct {
	readonly productId: string;
	readonly reason: string;
	readonly remediation: string;
}

/** A traffic offering the provider cannot realize (ADR-0144: absent, not preview). */
export interface AbsentTrafficOffering {
	readonly offeringId: TrafficRoutingOfferingId;
	readonly reason: string;
}

// domain-view: parse-time derived type; wire form is HostingCoverage in data-models (CUE #HostingCoverage).
export interface HostingCoverage {
	readonly contract: typeof HOSTING_COVERAGE_CONTRACT;
	readonly providerId: string;
	readonly resolvedProductIds: readonly string[];
	readonly unresolved: readonly UnresolvedHostingProduct[];
	readonly traffic: {
		readonly kind: TrafficRoutingProviderProfile["provider"];
		readonly offerings: readonly TrafficRoutingOfferingId[];
		readonly fallbacks: readonly TrafficRoutingOfferingId[];
		readonly absent: readonly AbsentTrafficOffering[];
	};
}

export type ResolverMetricAttributes = Readonly<
	Record<string, string | number | boolean>
>;

/** Structurally an OTel metric point, compatible with `@hobo/cd` OtelMetricPoint. */
export type ResolverMetricPoint = Readonly<{
	name: string;
	kind: "counter" | "histogram" | "gauge";
	value: number;
	unit: string;
	atMs: number;
	attributes: ResolverMetricAttributes;
}>;

/** Structurally the `metrics` half of `@hobo/cd` TelemetrySink. */
export interface ResolverMetricSink {
	metrics(points: readonly ResolverMetricPoint[]): Promise<void>;
}

export interface ResolverTelemetryOptions {
	readonly metrics?: ResolverMetricSink;
	/** Required with `metrics`: an injected clock keeps replay deterministic (I8). */
	readonly nowMs?: () => number;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function freezeDeep<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeDeep(child);
		Object.freeze(value);
	}
	return value;
}

/**
 * Build a provider's frozen coverage document. Refuses (typed) a declaration
 * that would make I14 unverifiable: a product both resolved and refused, a
 * refusal with no remediation, a profile that does not parse at the core
 * boundary, or an offering that is neither present nor declared absent.
 */
export function defineHostingCoverage(input: {
	readonly providerId: string;
	readonly resolvedProductIds: readonly string[];
	readonly unresolved: readonly UnresolvedHostingProduct[];
	readonly profile: TrafficRoutingProviderProfile;
	readonly absent: readonly AbsentTrafficOffering[];
}): HostingCoverage {
	const fail = (message: string): never => {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${input.providerId} hosting coverage: ${message}`,
		);
	};
	const resolved = [...new Set(input.resolvedProductIds)].sort(compare);
	if (resolved.length !== input.resolvedProductIds.length)
		fail("a resolved product id is listed twice");
	const unresolved = [...input.unresolved].sort((a, b) =>
		compare(a.productId, b.productId),
	);
	const seen = new Set<string>(resolved);
	for (const entry of unresolved) {
		if (seen.has(entry.productId))
			fail(`${entry.productId} is declared both resolved and refused`);
		seen.add(entry.productId);
		if (!entry.reason.trim() || !entry.remediation.trim())
			fail(`${entry.productId} refusal needs a reason and a remediation`);
	}
	const profile = parseTrafficRoutingProviderProfile(
		JSON.parse(JSON.stringify(input.profile)),
	);
	const offerings = profile.offerings.map((entry) => entry.id);
	const absent = [...input.absent].sort((a, b) =>
		compare(a.offeringId, b.offeringId),
	);
	for (const id of PORTABLE_TRAFFIC_OFFERING_IDS) {
		const present = offerings.includes(id);
		const declaredAbsent = absent.filter((a) => a.offeringId === id).length;
		if (present && declaredAbsent > 0)
			fail(`traffic offering ${id} is declared both present and absent`);
		if (!present && declaredAbsent !== 1)
			fail(`traffic offering ${id} must be present or declared absent once`);
	}
	for (const entry of absent)
		if (!entry.reason.trim())
			fail(`absent offering ${entry.offeringId} needs a reason`);
	for (const id of profile.fallbacks)
		if (!offerings.includes(id))
			fail(`fallback ${id} is not an offering the provider realizes`);
	return freezeDeep({
		contract: HOSTING_COVERAGE_CONTRACT,
		providerId: input.providerId,
		resolvedProductIds: resolved,
		unresolved: unresolved.map((entry) => ({ ...entry })),
		traffic: {
			kind: profile.provider,
			offerings,
			fallbacks: [...profile.fallbacks],
			absent: absent.map((entry) => ({ ...entry })),
		},
	});
}

/**
 * The typed refusal for a product id this provider does not realize, or
 * `undefined` when a shipped resolver owns it. An id the provider does not
 * catalog at all is also refused, naming the out-of-tree escape (D6).
 */
export function hostingProductRefusal(
	coverage: HostingCoverage,
	productId: string,
): ResolverError | undefined {
	if (coverage.resolvedProductIds.includes(productId)) return undefined;
	const known = coverage.unresolved.find(
		(entry) => entry.productId === productId,
	);
	if (known)
		return new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: ${known.reason} Remediation: ${known.remediation}`,
			productId,
		);
	return new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`${JSON.stringify(productId)} is not a ${coverage.providerId} hosting product. Remediation: bind a provider that catalogs it, or register a signed hobo:resolver WASM component for it (D6).`,
		productId,
	);
}

function outcomeOf(error: unknown): string {
	if (error instanceof ResolverError) return error.code;
	return "error";
}

/**
 * Wrap resolvers so every call emits `hobo.cd.resolver.operations` and
 * `hobo.cd.resolver.duration`. Without a sink the resolvers are returned
 * unchanged. A sink without a clock is refused: a metric stamped from an
 * ambient clock breaks replay (I8).
 */
export function instrumentResolvers(
	resolvers: readonly ResourceResolver[],
	options: ResolverTelemetryOptions,
): readonly ResourceResolver[] {
	const sink = options.metrics;
	if (!sink) return resolvers;
	const now = options.nowMs;
	if (!now)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"resolver telemetry needs an injected nowMs clock alongside its metric sink",
		);
	async function emit(
		resolver: ResourceResolver,
		operation: string,
		startedAt: number,
		outcome: string,
		action?: string,
	): Promise<void> {
		const endedAt = now?.() ?? startedAt;
		const attributes: ResolverMetricAttributes = {
			"hobo.provider.id": resolver.providerId,
			"hobo.resolver.product_id": resolver.productId,
			"hobo.resolver.operation": operation,
			"hobo.resolver.outcome": outcome,
			...(action === undefined ? {} : { "hobo.resolver.action": action }),
		};
		try {
			await sink?.metrics([
				{
					name: RESOLVER_OPERATIONS_METRIC,
					kind: "counter",
					value: 1,
					unit: "{operation}",
					atMs: endedAt,
					attributes,
				},
				{
					name: RESOLVER_DURATION_METRIC,
					kind: "histogram",
					value: Math.max(0, endedAt - startedAt),
					unit: "ms",
					atMs: endedAt,
					attributes,
				},
			]);
		} catch {
			// Telemetry never changes delivery: a failed export is dropped.
		}
	}
	async function measured<T>(
		resolver: ResourceResolver,
		operation: string,
		run: () => Promise<T>,
		actionOf: (value: T) => string | undefined,
	): Promise<T> {
		const startedAt = now?.() ?? 0;
		try {
			const value = await run();
			await emit(resolver, operation, startedAt, "ok", actionOf(value));
			return value;
		} catch (error) {
			await emit(resolver, operation, startedAt, outcomeOf(error));
			throw error;
		}
	}
	return Object.freeze(
		resolvers.map((resolver): ResourceResolver => {
			const read = resolver.read;
			return {
				providerId: resolver.providerId,
				productId: resolver.productId,
				...(resolver.directives === undefined
					? {}
					: { directives: resolver.directives }),
				reconcile: (request: ResolveRequest, transport: HttpTransport) =>
					measured(
						resolver,
						"reconcile",
						() => resolver.reconcile(request, transport),
						(value: ResolveOutcome) => value.action,
					),
				delete: (request: ResolveRequest, transport: HttpTransport) =>
					measured(
						resolver,
						"delete",
						() => resolver.delete(request, transport),
						() => undefined,
					),
				...(read === undefined
					? {}
					: {
							read: (request: ResolveRequest, transport: HttpTransport) =>
								measured(
									resolver,
									"read",
									() => read.call(resolver, request, transport),
									(value) => (value === undefined ? "absent" : value.action),
								),
						}),
			};
		}),
	);
}
