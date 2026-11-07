import { create, fromJson } from "@bufbuild/protobuf";
import {
	ProviderResourceRecordEnvelopeSchema,
	type ResourceLifecycleObservationRecord,
	ResourceLifecycleObservationRecordSchema,
	ResourceMutationJournalEntrySchema,
} from "../_generated/resource_lifecycle_pb.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "../json.js";
import type { HttpTransport } from "./http-transport.js";
import {
	parseResolveOutcome,
	parseResolveRequest,
	type ResolveRequest,
	type ResourceResolver,
} from "./resource-resolver.js";

export type {
	ProviderResourceRecordEnvelope,
	ResourceMutationJournalEntry,
} from "../_generated/resource_lifecycle_pb.js";
export {
	ProviderResourceRecordEnvelopeSchema,
	ResourceLifecycleObservationRecordSchema,
	ResourceMutationJournalEntrySchema,
};
// domain-view: parsed optional wire money is normalized only after presence
// checks; final usage can never acquire an implicit protobuf scalar zero.
export type ResourceLifecycleObservation =
	ResourceLifecycleObservationRecord & {
		readonly settledMicros: number;
	};
export type ResourceLifecycleScope = Pick<
	ResourceLifecycleObservation,
	| "tenantId"
	| "providerId"
	| "providerAccountId"
	| "productId"
	| "resourceId"
	| "operationId"
>;
export type ResourceLifecycleContext = ResourceLifecycleScope & {
	readonly nowMs: number;
	readonly maxAgeMs: number;
	readonly physicalId?: string;
	/** Expected independently observed artifact; this is never copied into proof. */
	readonly artifactDigest?: string;
};

/** Behavioral journal port; wire entries are ResourceMutationJournalEntry.
 * claimed means a NEW won CAS. A prior unacknowledged claim returns uncertain.
 * No HTTP request, response, headers or credentials may be persisted here. */
// domain-view: behavioral port; durable metadata is ResourceMutationJournalEntry.
export interface ResourceMutationJournal {
	readonly persistence: "durable-cas" | "memory";
	claim(input: {
		readonly mutationId: string;
		readonly requestDigest: string;
	}): Promise<{
		readonly status: "claimed" | "acknowledged" | "uncertain";
	}>;
	acknowledge(mutationId: string, requestDigest: string): Promise<void>;
	uncertain(mutationId: string, requestDigest: string): Promise<void>;
}

/** Parse provider evidence at the external-data boundary, then bind its scope. */
export function parseResourceLifecycleObservation<T>(
	input: T,
	context: ResourceLifecycleContext,
): ResourceLifecycleObservation {
	if (!isJsonObject(input))
		throw new Error("provider lifecycle evidence must be an object");
	if (
		!isJsonNumber(input.observedAtMs) ||
		!Number.isSafeInteger(input.observedAtMs) ||
		input.observedAtMs < 0
	)
		throw new Error(
			"provider lifecycle observation needs an explicit safe timestamp",
		);
	if (
		(input.settledMicros !== undefined || input.usageFinal === true) &&
		(!isJsonNumber(input.settledMicros) ||
			!Number.isSafeInteger(input.settledMicros) ||
			input.settledMicros < 0)
	)
		throw new Error("provider final charges need explicit safe integer money");
	if (
		input.$typeName !== undefined &&
		input.$typeName !== "hobo.core.v1.ResourceLifecycleObservationRecord"
	)
		throw new Error("provider lifecycle evidence has a foreign wire type");
	const { $typeName: _wireType, ...payload } = input;
	const observation = fromJson(
		ResourceLifecycleObservationRecordSchema,
		JSON.parse(JSON.stringify(payload)),
	);
	const settledMicros = observation.settledMicros ?? 0;
	for (const field of [
		"tenantId",
		"providerId",
		"providerAccountId",
		"productId",
		"resourceId",
		"operationId",
	] as const) {
		if (!context[field] || observation[field] !== context[field])
			throw new Error(`provider lifecycle evidence has foreign ${field}`);
	}
	for (const value of [
		context.nowMs,
		context.maxAgeMs,
		observation.observedAtMs,
		settledMicros,
	])
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error(
				"provider lifecycle money/time must be safe nonnegative integers",
			);
	if (
		!context.maxAgeMs ||
		observation.observedAtMs > context.nowMs ||
		context.nowMs - observation.observedAtMs > context.maxAgeMs
	)
		throw new Error("provider lifecycle evidence is stale or future-dated");
	if (
		!observation.evidenceRef ||
		!["ready", "pending", "failed", "absent", "unknown"].includes(
			observation.status,
		)
	)
		throw new Error(
			"provider lifecycle evidence lacks a supported status and provenance",
		);
	if (context.physicalId && observation.physicalId !== context.physicalId)
		throw new Error(
			"provider lifecycle evidence names another physical resource",
		);
	if (
		["ready", "absent"].includes(observation.status) &&
		(!observation.physicalId || !observation.operationTerminal)
	)
		throw new Error(
			"provider readiness/absence requires physical identity and a terminal operation",
		);
	if (
		observation.artifactDigest &&
		!/^sha256:[0-9a-f]{64}$/u.test(observation.artifactDigest)
	)
		throw new Error("provider artifact evidence is not a content address");
	if (
		context.artifactDigest &&
		observation.status === "ready" &&
		observation.artifactDigest !== context.artifactDigest
	)
		throw new Error("provider artifact differs from the approved artifact");
	if (observation.healthy && !observation.healthEvidenceRef)
		throw new Error("application health requires independent health evidence");
	if (observation.usageFinal && !observation.usageEvidenceRef)
		throw new Error("final charges require authoritative usage evidence");
	if (observation.servingEndpoint) {
		const endpoint = new URL(observation.servingEndpoint);
		if (
			observation.servingEndpoint.length > 2048 ||
			/[\p{Cc}]/u.test(observation.servingEndpoint) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash ||
			(endpoint.protocol !== "https:" &&
				!(
					endpoint.protocol === "http:" &&
					["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
				))
		)
			throw new Error(
				"native serving endpoint must be credential-free HTTPS or local loopback",
			);
	}
	return { ...observation, settledMicros };
}

/** Drive the actual shipped resolver read. Missing records and DELETE acks do
 * not prove terminal absence. Only provider-observed fields become evidence;
 * business health and final billing are never inferred from CP readiness. */
export async function observeResolverLifecycle(options: {
	readonly resolver: ResourceResolver;
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	readonly context: ResourceLifecycleContext & { readonly evidenceRef: string };
	/** Trusted host clock sampled after asynchronous provider IO. */
	readonly nowMs?: () => number;
}): Promise<ResourceLifecycleObservation> {
	const { resolver, context, transport } = options;
	const request = parseResolveRequest(cloneAsJson(options.request));
	if (
		resolver.providerId !== context.providerId ||
		resolver.productId !== context.productId ||
		request.ref.productId !== context.productId ||
		request.ref.logicalId !== context.resourceId
	)
		throw new Error("resolver does not own the approved lifecycle scope");
	if (!resolver.read)
		throw new Error(
			"provider resolver has no authoritative observation operation",
		);
	const raw = await resolver.read(request, transport);
	const result = raw ? parseResolveOutcome(cloneAsJson(raw)) : undefined;
	const observedContext = {
		...context,
		nowMs: options.nowMs?.() ?? context.nowMs,
	};
	const observation = create(ResourceLifecycleObservationRecordSchema, {
		tenantId: context.tenantId,
		providerId: context.providerId,
		providerAccountId: context.providerAccountId,
		productId: context.productId,
		resourceId: context.resourceId,
		operationId: context.operationId,
		physicalId: result?.physicalId ?? request.ref.physicalId ?? "",
		status: "unknown",
		observedAtMs: observedContext.nowMs,
		evidenceRef: context.evidenceRef,
	});
	if (result) {
		const outputs = result.outputs;
		// Durable native receipts retain their actual observation time. Reading
		// cached evidence cannot renew freshness without another provider probe.
		if (outputs.observedAtMs !== undefined) {
			if (
				!isJsonNumber(outputs.observedAtMs) ||
				!Number.isSafeInteger(outputs.observedAtMs)
			)
				throw new Error("resolver observation has an invalid native timestamp");
			observation.observedAtMs = outputs.observedAtMs;
		}
		if (isJsonString(outputs.evidenceRef) && outputs.evidenceRef.length > 0)
			observation.evidenceRef = outputs.evidenceRef;
		if (outputs.ready === true && outputs.operationConfirmed === true) {
			observation.status = "ready";
			observation.operationTerminal = true;
		} else if (outputs.lifecycleStatus === "failed")
			observation.status = "failed";
		else if (outputs.lifecycleStatus === "pending" || outputs.ready === false)
			observation.status = "pending";
		if (
			outputs.absenceConfirmed === true &&
			outputs.operationTerminal === true
		) {
			observation.status = "absent";
			observation.operationTerminal = true;
		}
		if (isJsonString(outputs.artifactDigest))
			observation.artifactDigest = outputs.artifactDigest;
		if (isJsonString(outputs.servingEndpoint))
			observation.servingEndpoint = outputs.servingEndpoint;
	}
	// Parse protobuf JSON rather than forwarding wire bookkeeping as user data.
	const { $typeName: _wireType, ...record } = observation;
	return parseResourceLifecycleObservation(record, observedContext);
}
