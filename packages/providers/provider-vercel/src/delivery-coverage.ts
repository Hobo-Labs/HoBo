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

export const HOSTING_COVERAGE_CONTRACT = "hobo.provider-hosting-coverage/v1";

export const RESOLVER_OPERATIONS_METRIC = "hobo.cd.resolver.operations";
export const RESOLVER_DURATION_METRIC = "hobo.cd.resolver.duration";

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

export interface UnresolvedHostingProduct {
	readonly productId: string;
	readonly reason: string;
	readonly remediation: string;
}

export interface AbsentTrafficOffering {
	readonly offeringId: TrafficRoutingOfferingId;
	readonly reason: string;
}

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

export type ResolverMetricPoint = Readonly<{
	name: string;
	kind: "counter" | "histogram" | "gauge";
	value: number;
	unit: string;
	atMs: number;
	attributes: ResolverMetricAttributes;
}>;

export interface ResolverMetricSink {
	metrics(points: readonly ResolverMetricPoint[]): Promise<void>;
}

export interface ResolverTelemetryOptions {
	readonly metrics?: ResolverMetricSink;
	readonly nowMs?: () => number;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

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
	if (new Set(profile.fallbacks).size !== profile.fallbacks.length)
		fail("a traffic fallback is listed twice");
	for (const id of profile.fallbacks)
		if (offerings.includes(id))
			fail(
				`fallback ${id} is also a native offering; core never falls back to a native rung`,
			);
	return Object.freeze({
		contract: HOSTING_COVERAGE_CONTRACT,
		providerId: input.providerId,
		resolvedProductIds: Object.freeze(resolved),
		unresolved: Object.freeze(
			unresolved.map((entry) =>
				Object.freeze({
					productId: entry.productId,
					reason: entry.reason,
					remediation: entry.remediation,
				}),
			),
		),
		traffic: Object.freeze({
			kind: profile.provider,
			offerings: Object.freeze(offerings),
			fallbacks: Object.freeze([...profile.fallbacks]),
			absent: Object.freeze(
				absent.map((entry) =>
					Object.freeze({ offeringId: entry.offeringId, reason: entry.reason }),
				),
			),
		}),
	});
}

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
		const common = {
			"hobo.provider.id": resolver.providerId,
			"hobo.resolver.product_id": resolver.productId,
			"hobo.resolver.operation": operation,
			"hobo.resolver.outcome": outcome,
		} satisfies ResolverMetricAttributes;
		const attributes =
			action === undefined
				? common
				: { ...common, "hobo.resolver.action": action };
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
			await emit(
				resolver,
				operation,
				startedAt,
				error instanceof ResolverError ? error.code : "error",
			);
			throw error;
		}
	}
	return Object.freeze(
		resolvers.map((resolver): ResourceResolver => {
			const read = resolver.read;
			const observeAbsence = resolver.observeAbsence;
			const base: ResourceResolver = {
				providerId: resolver.providerId,
				productId: resolver.productId,
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
			};
			const readable: ResourceResolver =
				read === undefined
					? base
					: {
							...base,
							read: (request: ResolveRequest, transport: HttpTransport) =>
								measured(
									resolver,
									"read",
									() => read.call(resolver, request, transport),
									(value) => (value === undefined ? "absent" : value.action),
								),
						};
			const observable: ResourceResolver =
				observeAbsence === undefined
					? readable
					: {
							...readable,
							observeAbsence: (request, transport) =>
								measured(
									resolver,
									"observeAbsence",
									() => observeAbsence.call(resolver, request, transport),
									(value) => (value ? "absent" : "present"),
								),
						};
			return resolver.directives === undefined
				? observable
				: { ...observable, directives: resolver.directives };
		}),
	);
}
