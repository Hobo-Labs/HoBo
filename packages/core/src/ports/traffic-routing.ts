import type { JsonValue } from "@bufbuild/protobuf";
import { create, fromJson, isMessage } from "@bufbuild/protobuf";
import type {
	TrafficRoutingApplyResultRecord,
	TrafficRoutingAvailabilityRecord,
	TrafficRoutingBackendRecord,
	TrafficRoutingIntentRecord,
	TrafficRoutingMatchRecord,
	TrafficRoutingPlanRecord,
	TrafficRoutingResiliencyRecord,
	TrafficRoutingRevokeResultRecord,
	TrafficRoutingRuleRecord,
	TrafficRoutingStatusRecord,
} from "../_generated/traffic_routing_pb.js";
import {
	TrafficRoutingPlanRecordSchema,
	TrafficRoutingRuleRecord_WeightStrategy,
} from "../_generated/traffic_routing_pb.js";
import { CoreParseError } from "../errors.js";
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonString,
	type JsonObject,
} from "../json.js";
import {
	assertNoExtra,
	deepFreeze,
	enumValue,
	expectObject,
	headerName,
	isoTimestamp,
	nonEmptyString,
	nonNegativeInteger,
	positiveInteger,
	requiredArray,
	sha256Ref,
	uniqueStringArray,
} from "../parse-utils.js";
import { createUsageEvent, type UsageEvent } from "./metering.js";
import { parseTenantId, type TenantId } from "./tenant.js";

export type TrafficRoutingProviderKind =
	| "simple"
	| "cloudflare"
	| "funnel"
	| "vercel"
	| "lakebed"
	| "other";
export type TrafficRoutingProvider = TrafficRoutingProviderKind;

export type RoutingWeightStrategy = "static" | "prefer-healthy" | "locality";
export type RoutingRealization = "full" | "partial" | "none";
export type TrafficRoutingCapability =
	| "weighted-backends"
	| "health-aware"
	| "locality-aware"
	| "path-prefix"
	| "header-match"
	| "availability-constraints"
	| "resiliency";

export type BackendId = string & { readonly __brand: "BackendId" };
export type RoutingPlanId = string & { readonly __brand: "RoutingPlanId" };
export type RoutingService = string & { readonly __brand: "RoutingService" };
export type StationId = string & { readonly __brand: "StationId" };
export type RailHash = string & { readonly __brand: "RailHash" };
export type RoutingInstant = string & { readonly __brand: "RoutingInstant" };
export type LocationHint = string & { readonly __brand: "LocationHint" };
export type PathPrefix = string & { readonly __brand: "PathPrefix" };
export type RoutingEndpoint = string & {
	readonly __brand: "RoutingEndpoint";
};
export type RoutingWeight = number & { readonly __brand: "RoutingWeight" };
export type TimeoutMs = number & { readonly __brand: "TimeoutMs" };
export type RetryCount = number & { readonly __brand: "RetryCount" };
export type BackendCount = number & { readonly __brand: "BackendCount" };
export type AppliedRuleCount = number & {
	readonly __brand: "AppliedRuleCount";
};

// domain-view: frozen/branded refinements of traffic_routing.proto generated wire records.
type RefinedWire<Wire, Keys extends keyof Wire, Refinement> = Readonly<
	Omit<Pick<Wire, Keys>, keyof Refinement> & Refinement
>;

export type BackendRef = RefinedWire<
	TrafficRoutingBackendRecord,
	"id" | "service" | "locationHints" | "weight" | "endpoint",
	{
		readonly id: BackendId;
		readonly service: RoutingService;
		readonly locationHints?: readonly LocationHint[];
		readonly weight?: RoutingWeight;
		readonly endpoint?: RoutingEndpoint;
	}
>;

export type RoutingMatch = RefinedWire<
	TrafficRoutingMatchRecord,
	"pathPrefix" | "headers",
	{
		readonly pathPrefix?: PathPrefix;
		readonly headers?: Readonly<Record<string, string>>;
	}
>;

export type RoutingRule = RefinedWire<
	TrafficRoutingRuleRecord,
	"match" | "backends" | "weightStrategy",
	{
		readonly match?: RoutingMatch;
		readonly backends: readonly BackendRef[];
		readonly weightStrategy: RoutingWeightStrategy;
	}
>;

export type MinAvailabilitySpec = RefinedWire<
	TrafficRoutingAvailabilityRecord,
	"minHealthyBackends" | "minDistinctLocations" | "locationLabels",
	{
		readonly minHealthyBackends?: BackendCount;
		readonly minDistinctLocations?: BackendCount;
		readonly locationLabels?: readonly LocationHint[];
	}
>;

export type ResiliencySpec = RefinedWire<
	TrafficRoutingResiliencyRecord,
	"timeoutMs" | "retries",
	{
		readonly timeoutMs?: TimeoutMs;
		readonly retries?: RetryCount;
	}
>;

export type TrafficIntent = RefinedWire<
	TrafficRoutingIntentRecord,
	"service" | "tenantId" | "rules" | "availability" | "resiliency",
	{
		readonly service: RoutingService;
		readonly tenantId: TenantId;
		readonly rules: readonly RoutingRule[];
		readonly availability?: MinAvailabilitySpec;
		readonly resiliency?: ResiliencySpec;
	}
>;

export type RoutingPlan = RefinedWire<
	TrafficRoutingPlanRecord,
	| "planId"
	| "intent"
	| "backends"
	| "stationId"
	| "railHash"
	| "createdAt"
	| "degraded"
	| "notes",
	{
		readonly planId: RoutingPlanId;
		readonly intent: TrafficIntent;
		readonly backends: readonly BackendRef[];
		readonly stationId?: StationId;
		readonly railHash?: RailHash;
		readonly createdAt: RoutingInstant;
		readonly degraded?: boolean;
		readonly notes?: readonly string[];
	}
>;

export type ApplyResult = RefinedWire<
	TrafficRoutingApplyResultRecord,
	| "planId"
	| "provider"
	| "realized"
	| "notes"
	| "appliedRules"
	| "unmet"
	| "capabilities",
	{
		readonly planId: RoutingPlanId;
		readonly provider: TrafficRoutingProvider;
		readonly realized: RoutingRealization;
		readonly notes: readonly string[];
		readonly appliedRules?: AppliedRuleCount;
		readonly unmet?: readonly string[];
		readonly capabilities?: readonly TrafficRoutingCapability[];
	}
>;

export type RoutingStatus = RefinedWire<
	TrafficRoutingStatusRecord,
	"planId" | "active" | "realized" | "notes",
	{
		readonly planId: RoutingPlanId;
		readonly active: boolean;
		readonly realized: RoutingRealization;
		readonly notes: readonly string[];
	}
>;

export type RevokeResult = RefinedWire<
	TrafficRoutingRevokeResultRecord,
	"ok" | "notes",
	{
		readonly ok: boolean;
		readonly notes: readonly string[];
	}
>;

export interface TrafficRoutingPort {
	readonly provider: TrafficRoutingProvider;
	apply(plan: RoutingPlan): Promise<ApplyResult>;
	status(planId: RoutingPlanId): Promise<RoutingStatus | null>;
	revoke?(planId: RoutingPlanId): Promise<RevokeResult>;
}

export type TrafficRoutingMeteringEventType =
	| "routing.plan.apply"
	| "routing.plan.degraded"
	| "routing.plan.deny";

export interface TrafficRoutingMeteringEvent
	extends Omit<UsageEvent, "eventType"> {
	readonly eventType: TrafficRoutingMeteringEventType;
}

export class TrafficRoutingParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_TRAFFIC_ROUTING_PARSE", path, expected, received, message);
		this.name = "TrafficRoutingParseError";
	}
}

const PROVIDERS = new Set<TrafficRoutingProvider>([
	"simple",
	"cloudflare",
	"funnel",
	"vercel",
	"lakebed",
	"other",
]);
const STRATEGIES = new Set<RoutingWeightStrategy>([
	"static",
	"prefer-healthy",
	"locality",
]);
const REALIZATIONS = new Set<RoutingRealization>(["full", "partial", "none"]);
const CAPABILITIES = new Set<TrafficRoutingCapability>([
	"weighted-backends",
	"health-aware",
	"locality-aware",
	"path-prefix",
	"header-match",
	"availability-constraints",
	"resiliency",
]);
const ROUTING_INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function brandAs<T>(value: string): T {
	// SAFETY: the string was parsed at this routing-plan document boundary.
	return value as T;
}

export function parseBackendId(
	value: JsonValue | undefined,
	path = "backendId",
): BackendId {
	return brandAs<BackendId>(text(value, path));
}

export function parseRoutingPlanId(
	value: JsonValue | undefined,
	path = "planId",
): RoutingPlanId {
	// SAFETY: assertion required at this I/O or test boundary.
	return text(value, path) as RoutingPlanId;
}

export function parseRoutingProvider(
	value: JsonValue | undefined,
	path = "provider",
): TrafficRoutingProvider {
	return enumValue(value, PROVIDERS, path, TrafficRoutingParseError);
}

export function parseRoutingWeight(
	value: JsonValue | undefined,
	path = "weight",
): RoutingWeight {
	// SAFETY: assertion required at this I/O or test boundary.
	return positiveInteger(value, path, TrafficRoutingParseError, {
		max: 100,
	}) as RoutingWeight;
}

export function parseBackendRef(
	value: JsonValue | undefined,
	path = "backend",
): BackendRef {
	const input = record(value, path, [
		"id",
		"service",
		"locationHints",
		"weight",
		"endpoint",
	]);
	return deepFreeze({
		id: parseBackendId(input.id, `${path}.id`),
		service: parseService(input.service, `${path}.service`),
		...(input.locationHints !== undefined
			? {
					locationHints: stringList(
						input.locationHints,
						`${path}.locationHints`,
						// SAFETY: assertion required at this I/O or test boundary.
					).map((entry) => brandAs<LocationHint>(entry)),
				}
			: undefined),
		...(input.weight !== undefined
			? { weight: parseRoutingWeight(input.weight, `${path}.weight`) }
			: undefined),
		...(input.endpoint !== undefined
			? { endpoint: parseEndpoint(input.endpoint, `${path}.endpoint`) }
			: undefined),
	});
}

export function parseRoutingMatch(
	value: JsonValue | undefined,
	path = "match",
): RoutingMatch {
	const input = record(value, path, ["pathPrefix", "headers"]);
	return deepFreeze({
		...(input.pathPrefix !== undefined
			? { pathPrefix: parsePathPrefix(input.pathPrefix, `${path}.pathPrefix`) }
			: undefined),
		...(input.headers !== undefined
			? { headers: parseHeaders(input.headers, `${path}.headers`) }
			: undefined),
	});
}

export function parseRoutingRule(
	value: JsonValue | undefined,
	path = "rule",
): RoutingRule {
	const input = record(value, path, ["match", "backends", "weightStrategy"]);
	const backends = backendList(input.backends, `${path}.backends`);
	return deepFreeze({
		...(input.match !== undefined
			? { match: parseRoutingMatch(input.match, `${path}.match`) }
			: undefined),
		backends,
		weightStrategy:
			input.weightStrategy === undefined
				? "static"
				: enumValue(
						input.weightStrategy,
						STRATEGIES,
						`${path}.weightStrategy`,
						TrafficRoutingParseError,
					),
	});
}

export function parseMinAvailabilitySpec(
	value: JsonValue | undefined,
	path = "availability",
): MinAvailabilitySpec {
	const input = record(value, path, [
		"minHealthyBackends",
		"minDistinctLocations",
		"locationLabels",
	]);
	return deepFreeze({
		...(input.minHealthyBackends !== undefined
			? {
					// SAFETY: assertion required at this I/O or test boundary.
					minHealthyBackends: positiveInteger(
						input.minHealthyBackends,
						`${path}.minHealthyBackends`,
						TrafficRoutingParseError,
					) as BackendCount,
				}
			: undefined),
		...(input.minDistinctLocations !== undefined
			? {
					// SAFETY: assertion required at this I/O or test boundary.
					minDistinctLocations: positiveInteger(
						input.minDistinctLocations,
						`${path}.minDistinctLocations`,
						TrafficRoutingParseError,
					) as BackendCount,
				}
			: undefined),
		...(input.locationLabels !== undefined
			? {
					locationLabels: stringList(
						input.locationLabels,
						`${path}.locationLabels`,
						// SAFETY: assertion required at this I/O or test boundary.
					).map((entry) => brandAs<LocationHint>(entry)),
				}
			: undefined),
	});
}

export function parseResiliencySpec(
	value: JsonValue | undefined,
	path = "resiliency",
): ResiliencySpec {
	const input = record(value, path, ["timeoutMs", "retries"]);
	return deepFreeze({
		...(input.timeoutMs !== undefined
			? {
					// SAFETY: assertion required at this I/O or test boundary.
					timeoutMs: positiveInteger(
						input.timeoutMs,
						`${path}.timeoutMs`,
						TrafficRoutingParseError,
					) as TimeoutMs,
				}
			: undefined),
		...(input.retries !== undefined
			? {
					// SAFETY: assertion required at this I/O or test boundary.
					retries: nonNegativeInteger(
						input.retries,
						`${path}.retries`,
						TrafficRoutingParseError,
					) as RetryCount,
				}
			: undefined),
	});
}

export function parseTrafficIntent(
	value: JsonValue | undefined,
	path = "intent",
): TrafficIntent {
	const input = record(value, path, [
		"service",
		"tenantId",
		"rules",
		"availability",
		"resiliency",
	]);
	const rules = requiredArray(
		input.rules,
		`${path}.rules`,
		TrafficRoutingParseError,
	).map((rule, index) => parseRoutingRule(rule, `${path}.rules[${index}]`));
	return deepFreeze({
		service: parseService(input.service, `${path}.service`),
		tenantId: parseTenantId(text(input.tenantId, `${path}.tenantId`)),
		rules,
		...(input.availability !== undefined
			? {
					availability: parseMinAvailabilitySpec(
						input.availability,
						`${path}.availability`,
					),
				}
			: undefined),
		...(input.resiliency !== undefined
			? {
					resiliency: parseResiliencySpec(
						input.resiliency,
						`${path}.resiliency`,
					),
				}
			: undefined),
	});
}

export function parseRoutingPlan(value: JsonValue | undefined): RoutingPlan {
	const input = record(value, "plan", [
		"planId",
		"intent",
		"backends",
		"stationId",
		"railHash",
		"createdAt",
		"degraded",
		"notes",
	]);
	const backends = backendList(input.backends, "plan.backends");
	const intent = parseTrafficIntent(input.intent, "plan.intent");
	const knownBackends = new Map(
		backends.map((backend) => [backend.id, backend]),
	);
	for (const [ruleIndex, rule] of intent.rules.entries()) {
		for (const [backendIndex, backend] of rule.backends.entries()) {
			const canonical = knownBackends.get(backend.id);
			if (!canonical) {
				fail(
					`plan.intent.rules[${ruleIndex}].backends[${backendIndex}].id`,
					"backend declared in plan.backends",
					backend.id,
				);
			}
			if (!sameBackend(backend, canonical)) {
				fail(
					`plan.intent.rules[${ruleIndex}].backends[${backendIndex}]`,
					"backend exactly matching its plan.backends declaration",
					backend,
				);
			}
		}
	}
	return deepFreeze({
		planId: parseRoutingPlanId(input.planId),
		intent,
		backends,
		...(input.stationId !== undefined
			? // SAFETY: assertion required at this I/O or test boundary.
				{
					stationId: brandAs<StationId>(
						text(input.stationId, "plan.stationId"),
					),
				}
			: undefined),
		...(input.railHash !== undefined
			? { railHash: parseRailHash(input.railHash) }
			: undefined),
		createdAt: parseInstant(input.createdAt, "plan.createdAt"),
		...(input.degraded === undefined
			? undefined
			: { degraded: bool(input.degraded, "plan.degraded") }),
		...(input.notes === undefined
			? undefined
			: { notes: stringList(input.notes, "plan.notes") }),
	});
}

/** Parse protobuf JSON or a generated TrafficRoutingPlanRecord into the domain view. */
export function parseTrafficRoutingPlanRecord(
	value: JsonValue | undefined,
): RoutingPlan {
	let wire: TrafficRoutingPlanRecord;
	try {
		wire = isMessage(value, TrafficRoutingPlanRecordSchema)
			? value
			: value === undefined
				? fail(
						"trafficRoutingPlanRecord",
						TrafficRoutingPlanRecordSchema.typeName,
						value,
					)
				: fromJson(TrafficRoutingPlanRecordSchema, value);
	} catch (error) {
		fail(
			"trafficRoutingPlanRecord",
			TrafficRoutingPlanRecordSchema.typeName,
			error instanceof Error ? error.message : error,
		);
	}
	return parseRoutingPlan(
		cloneAsJson({
			planId: wire.planId,
			intent:
				wire.intent === undefined
					? undefined
					: {
							service: wire.intent.service,
							tenantId: wire.intent.tenantId,
							rules: wire.intent.rules.map(ruleFromRecord),
							...(wire.intent.availability
								? {
										availability: {
											...(wire.intent.availability.minHealthyBackends ===
											undefined
												? undefined
												: {
														minHealthyBackends:
															wire.intent.availability.minHealthyBackends,
													}),
											...(wire.intent.availability.minDistinctLocations ===
											undefined
												? undefined
												: {
														minDistinctLocations:
															wire.intent.availability.minDistinctLocations,
													}),
											locationLabels: wire.intent.availability.locationLabels,
										},
									}
								: undefined),
							...(wire.intent.resiliency
								? {
										resiliency: {
											...(wire.intent.resiliency.timeoutMs === undefined
												? undefined
												: { timeoutMs: wire.intent.resiliency.timeoutMs }),
											...(wire.intent.resiliency.retries === undefined
												? undefined
												: { retries: wire.intent.resiliency.retries }),
										},
									}
								: undefined),
						},
			backends: wire.backends.map(backendFromRecord),
			...(wire.stationId === undefined
				? undefined
				: { stationId: wire.stationId }),
			...(wire.railHash === undefined
				? undefined
				: { railHash: wire.railHash }),
			createdAt: wire.createdAt,
			degraded: wire.degraded,
			notes: wire.notes,
		}),
	);
}

/** Convert a parsed domain plan to its generated protobuf record. */
export function toTrafficRoutingPlanRecord(
	plan: RoutingPlan,
): TrafficRoutingPlanRecord {
	return create(TrafficRoutingPlanRecordSchema, {
		planId: plan.planId,
		intent: {
			service: plan.intent.service,
			tenantId: plan.intent.tenantId,
			rules: plan.intent.rules.map((rule) => ({
				...(rule.match
					? {
							match: {
								...(rule.match.pathPrefix
									? { pathPrefix: rule.match.pathPrefix }
									: undefined),
								headers: { ...rule.match.headers },
							},
						}
					: undefined),
				backends: rule.backends.map(backendToRecord),
				weightStrategy: weightStrategyToRecord(rule.weightStrategy),
			})),
			...(plan.intent.availability
				? {
						availability: {
							...plan.intent.availability,
							locationLabels: [
								...(plan.intent.availability.locationLabels ?? []),
							],
						},
					}
				: undefined),
			...(plan.intent.resiliency
				? { resiliency: { ...plan.intent.resiliency } }
				: undefined),
		},
		backends: plan.backends.map(backendToRecord),
		...(plan.stationId === undefined
			? undefined
			: { stationId: plan.stationId }),
		...(plan.railHash === undefined ? undefined : { railHash: plan.railHash }),
		createdAt: plan.createdAt,
		degraded: plan.degraded ?? false,
		notes: [...(plan.notes ?? [])],
	});
}

export function parseApplyResult(value: JsonValue | undefined): ApplyResult {
	const input = record(value, "applyResult", [
		"planId",
		"provider",
		"realized",
		"notes",
		"appliedRules",
		"unmet",
		"capabilities",
	]);
	const result = deepFreeze({
		planId: parseRoutingPlanId(input.planId),
		provider: parseRoutingProvider(input.provider),
		realized: enumValue(
			input.realized,
			REALIZATIONS,
			"applyResult.realized",
			TrafficRoutingParseError,
		),
		notes: stringList(input.notes, "applyResult.notes"),
		...(input.appliedRules !== undefined
			? {
					// SAFETY: assertion required at this I/O or test boundary.
					appliedRules: nonNegativeInteger(
						input.appliedRules,
						"applyResult.appliedRules",
						TrafficRoutingParseError,
					) as AppliedRuleCount,
				}
			: undefined),
		...(input.unmet !== undefined
			? { unmet: stringList(input.unmet, "applyResult.unmet") }
			: undefined),
		...(input.capabilities !== undefined
			? {
					capabilities: capabilityList(
						input.capabilities,
						"applyResult.capabilities",
					),
				}
			: undefined),
	});
	const appliedRules = result.appliedRules ?? 0;
	const unmet = result.unmet?.length ?? 0;
	if (result.realized === "full" && (appliedRules === 0 || unmet > 0)) {
		fail(
			"applyResult",
			"full result with applied rules and no unmet items",
			value,
		);
	}
	if (result.realized === "partial" && unmet === 0) {
		fail(
			"applyResult.unmet",
			"non-empty for partial realization",
			result.unmet,
		);
	}
	if (result.realized === "none" && appliedRules !== 0) {
		fail("applyResult.appliedRules", "zero for no realization", appliedRules);
	}
	return result;
}

export function parseRoutingStatus(
	value: JsonValue | undefined,
): RoutingStatus {
	const input = record(value, "routingStatus", [
		"planId",
		"active",
		"realized",
		"notes",
	]);
	const result = deepFreeze({
		planId: parseRoutingPlanId(input.planId),
		active: bool(input.active, "routingStatus.active"),
		realized: enumValue(
			input.realized,
			REALIZATIONS,
			"routingStatus.realized",
			TrafficRoutingParseError,
		),
		notes: stringList(input.notes, "routingStatus.notes"),
	});
	if (
		(result.active && result.realized === "none") ||
		(!result.active && result.realized === "full")
	) {
		fail("routingStatus", "active state consistent with realization", value);
	}
	return result;
}

export function parseRevokeResult(value: JsonValue | undefined): RevokeResult {
	const input = record(value, "revokeResult", ["ok", "notes"]);
	return deepFreeze({
		ok: bool(input.ok, "revokeResult.ok"),
		notes: stringList(input.notes, "revokeResult.notes"),
	});
}

export function createTrafficRoutingMeteringEvent(
	value: JsonValue | undefined,
): TrafficRoutingMeteringEvent {
	const input = record(value, "meteringEvent", [
		"tenantId",
		"planId",
		"provider",
		"outcome",
		"timestamp",
	]);
	const outcome = enumValue(
		input.outcome,
		new Set(["apply", "degraded", "deny"] as const),
		"meteringEvent.outcome",
		TrafficRoutingParseError,
	);
	const planId = parseRoutingPlanId(input.planId, "meteringEvent.planId");
	return deepFreeze(
		// SAFETY: assertion required at this I/O or test boundary.
		createUsageEvent({
			tenantId: parseTenantId(text(input.tenantId, "meteringEvent.tenantId")),
			// SAFETY: assertion required at this I/O or test boundary.
			eventType: `routing.plan.${outcome}` as TrafficRoutingMeteringEventType,
			resource: planId,
			timestamp:
				input.timestamp === undefined
					? new Date().toISOString()
					: parseInstant(input.timestamp, "meteringEvent.timestamp"),
			metadata: {
				provider: parseRoutingProvider(
					input.provider,
					"meteringEvent.provider",
				),
			},
		}) as TrafficRoutingMeteringEvent,
	);
}

function parseService(
	value: JsonValue | undefined,
	path: string,
): RoutingService {
	// SAFETY: assertion required at this I/O or test boundary.
	return text(value, path) as RoutingService;
}

function parsePathPrefix(
	value: JsonValue | undefined,
	path: string,
): PathPrefix {
	const parsed = text(value, path);
	if (!parsed.startsWith("/")) fail(path, "path beginning with /", value);
	// SAFETY: assertion required at this I/O or test boundary.
	return parsed as PathPrefix;
}

function parseEndpoint(
	value: JsonValue | undefined,
	path: string,
): RoutingEndpoint {
	const parsed = text(value, path);
	let url: URL;
	try {
		url = new URL(parsed);
	} catch {
		fail(path, "absolute HTTP(S) URL", value);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		fail(path, "absolute HTTP(S) URL", value);
	}
	if (url.username || url.password || url.search || url.hash) {
		fail(path, "HTTP(S) URL without credentials, query, or fragment", value);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return parsed as RoutingEndpoint;
}

function sameBackend(left: BackendRef, right: BackendRef): boolean {
	return (
		left.id === right.id &&
		left.service === right.service &&
		left.endpoint === right.endpoint &&
		left.weight === right.weight &&
		(left.locationHints?.length ?? 0) === (right.locationHints?.length ?? 0) &&
		(left.locationHints ?? []).every(
			(location, index) => location === right.locationHints?.[index],
		)
	);
}

function backendFromRecord(backend: TrafficRoutingBackendRecord) {
	return {
		id: backend.id,
		service: backend.service,
		...(backend.locationHints.length > 0
			? { locationHints: backend.locationHints }
			: undefined),
		...(backend.weight === undefined ? undefined : { weight: backend.weight }),
		...(backend.endpoint === undefined
			? undefined
			: { endpoint: backend.endpoint }),
	};
}

function backendToRecord(backend: BackendRef) {
	return {
		id: backend.id,
		service: backend.service,
		locationHints: [...(backend.locationHints ?? [])],
		...(backend.weight === undefined ? undefined : { weight: backend.weight }),
		...(backend.endpoint === undefined
			? undefined
			: { endpoint: backend.endpoint }),
	};
}

function ruleFromRecord(rule: TrafficRoutingRuleRecord) {
	return {
		...(rule.match
			? {
					match: {
						...(rule.match.pathPrefix === undefined
							? undefined
							: { pathPrefix: rule.match.pathPrefix }),
						headers: rule.match.headers,
					},
				}
			: undefined),
		backends: rule.backends.map(backendFromRecord),
		weightStrategy: weightStrategyFromRecord(rule.weightStrategy),
	};
}

function weightStrategyFromRecord(
	value: TrafficRoutingRuleRecord_WeightStrategy,
): RoutingWeightStrategy {
	switch (value) {
		case TrafficRoutingRuleRecord_WeightStrategy.STATIC:
		case TrafficRoutingRuleRecord_WeightStrategy.UNSPECIFIED:
			return "static";
		case TrafficRoutingRuleRecord_WeightStrategy.PREFER_HEALTHY:
			return "prefer-healthy";
		case TrafficRoutingRuleRecord_WeightStrategy.LOCALITY:
			return "locality";
		default:
			return fail("weightStrategy", "known protobuf enum", value);
	}
}

function weightStrategyToRecord(
	value: RoutingWeightStrategy,
): TrafficRoutingRuleRecord_WeightStrategy {
	switch (value) {
		case "static":
			return TrafficRoutingRuleRecord_WeightStrategy.STATIC;
		case "prefer-healthy":
			return TrafficRoutingRuleRecord_WeightStrategy.PREFER_HEALTHY;
		case "locality":
			return TrafficRoutingRuleRecord_WeightStrategy.LOCALITY;
	}
}

function parseRailHash(value: JsonValue | undefined): RailHash {
	// SAFETY: assertion required at this I/O or test boundary.
	return sha256Ref(
		value,
		"plan.railHash",
		TrafficRoutingParseError,
	) as RailHash;
}

function parseInstant(
	value: JsonValue | undefined,
	path: string,
): RoutingInstant {
	const parsed = isoTimestamp(value, path, TrafficRoutingParseError);
	if (!ROUTING_INSTANT.test(parsed)) {
		fail(path, "ISO timestamp with time and timezone", value);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return parsed as RoutingInstant;
}

function parseHeaders(
	value: JsonValue | undefined,
	path: string,
): Readonly<Record<string, string>> {
	const input = record(value, path);
	const entries = Object.entries(input).map(([name, headerValue]) => {
		headerName(name, `${path}.${name}`, TrafficRoutingParseError);
		if (!isJsonString(headerValue)) {
			fail(`${path}.${name}`, "string", headerValue);
		}
		return [name.toLowerCase(), headerValue] as const;
	});
	if (new Set(entries.map(([name]) => name)).size !== entries.length) {
		fail(path, "case-insensitively unique header names", value);
	}
	return deepFreeze(Object.fromEntries(entries));
}

function backendList(
	value: JsonValue | undefined,
	path: string,
): readonly BackendRef[] {
	const parsed = requiredArray(value, path, TrafficRoutingParseError).map(
		(backend, index) => parseBackendRef(backend, `${path}[${index}]`),
	);
	const ids = new Set<string>();
	for (const [index, backend] of parsed.entries()) {
		if (ids.has(backend.id))
			fail(`${path}[${index}].id`, "unique backend id", backend.id);
		ids.add(backend.id);
	}
	return deepFreeze(parsed);
}

function record(
	value: JsonValue | undefined,
	path: string,
	allowed?: readonly string[],
): JsonObject {
	const parsed = expectObject(value, path, TrafficRoutingParseError);
	if (allowed) assertNoExtra(parsed, path, allowed, TrafficRoutingParseError);
	return parsed;
}

function stringList(
	value: JsonValue | undefined,
	path: string,
): readonly string[] {
	const parsed = uniqueStringArray(value, path, TrafficRoutingParseError).map(
		(entry, index) => text(entry, `${path}[${index}]`),
	);
	if (new Set(parsed).size !== parsed.length)
		fail(path, "unique strings", value);
	return deepFreeze(parsed);
}

function capabilityList(
	value: JsonValue | undefined,
	path: string,
): readonly TrafficRoutingCapability[] {
	const parsed = (
		Array.isArray(value) ? value : fail(path, "array", value)
	).map((entry, index) =>
		enumValue(
			entry,
			CAPABILITIES,
			`${path}[${index}]`,
			TrafficRoutingParseError,
		),
	);
	if (new Set(parsed).size !== parsed.length)
		fail(path, "unique values", value);
	return deepFreeze(parsed);
}

function text(value: JsonValue | undefined, path: string): string {
	const parsed = nonEmptyString(value, path, TrafficRoutingParseError).trim();
	if (parsed.length === 0) fail(path, "non-empty string", value);
	return parsed;
}

function bool(value: JsonValue | undefined, path: string): boolean {
	if (!isJsonBoolean(value)) fail(path, "boolean", value);
	return value;
}

function fail<T>(path: string, expected: string, received: T): never {
	throw new TrafficRoutingParseError(path, expected, cloneAsJson(received));
}
