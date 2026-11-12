// `componentResolvers`: loaded hobo:resolver components as ordinary
// @hobo/core `ResourceResolver`s, one per resource class (product). This is
// the only seam the rest of HoBo sees — the reconciler, the hosting
// transition coordinator and the resolver registry treat a component like an
// in-tree resolver. Requests are re-parsed with `parseResolveRequest` and
// outcomes with `parseResolveOutcome`, so the core credential screen runs on
// both sides of every call.
//
// Fleet and policy (D22, D25): `observe` returns a @hobo/cd
// `ResourceObservation` whose attributes are trimmed to the Camp's declared
// observe_fields and the class's own, whose `retained` lists the class's
// retained fields, and whose drift excludes retained fields — a component's
// retained field is never reported as drift.
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { type ResourceObservation, ResourceObservationSchema } from "@hobo/cd";
import {
	canonicalJson,
	type HttpTransport,
	parseResolveOutcome,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	type ResourceResolver,
} from "@hobo/core";
import { ResolverComponentError } from "./errors.js";
import {
	AbiError,
	liftInstances,
	liftNull,
	liftOutcome,
	liftReadResult,
	liftResult,
	lower,
} from "./guest/abi.js";
import type {
	WitResolveOutcome,
	WitResolveRequest,
	WitResult,
} from "./guest/types.js";
import { isJsonObject, type JsonObject, type JsonValue, parseJsonText } from "./json.js";
import { type ComponentResourceClass, compare, CREDENTIAL_FIELD_PATTERN } from "./manifest.js";
import type { LoadedResolverComponent } from "./runtime.js";

// public-contract: per-resource attribute budget (D25: ≤ 16 KiB).
export const MAX_ATTRIBUTE_BYTES = 16 * 1024;

export interface ComponentInstanceRef {
	readonly logicalId: string;
	readonly physicalId: string;
}

/** A `ResourceResolver` backed by a component, with the fleet extras. */
export interface ComponentResourceResolver extends ResourceResolver {
	readonly component: Readonly<{
		id: string;
		version: string;
		wasmDigest: string;
		manifestDigest: string;
		signedBy: string;
	}>;
	readonly resourceClass: ComponentResourceClass;
	/** Read + trim + retained + drift, as a reconcile observation entry. */
	observe(
		request: ResolveRequest,
		transport: HttpTransport,
		observeFields: readonly string[],
	): Promise<ResourceObservation | undefined>;
	/** Enumerate the instances the provider holds for this product. */
	instances(
		transport: HttpTransport,
		credentialRef: string,
	): Promise<readonly ComponentInstanceRef[]>;
}

export interface ComponentResolversOptions {
	readonly components: readonly LoadedResolverComponent[];
}

const COMPONENT_RESOLVERS = new WeakSet<ResourceResolver>();

/** Is this resolver backed by a hobo:resolver component? */
export function isComponentResolver(
	resolver: ResourceResolver,
): resolver is ComponentResourceResolver {
	return COMPONENT_RESOLVERS.has(resolver);
}

/**
 * The host adapter: every loaded component's resource classes as
 * `ResourceResolver`s, ordered by product id (never load order).
 */
export function componentResolvers(
	options: ComponentResolversOptions,
): readonly ResourceResolver[] {
	const resolvers: ResourceResolver[] = [];
	for (const component of options.components) {
		for (const resourceClass of component.classes) {
			const resolver = componentResolver(component, resourceClass);
			COMPONENT_RESOLVERS.add(resolver);
			resolvers.push(resolver);
		}
	}
	return Object.freeze(
		resolvers.sort((left, right) => compare(left.productId, right.productId)),
	);
}

function componentResolver(
	component: LoadedResolverComponent,
	resourceClass: ComponentResourceClass,
): ComponentResourceResolver {
	const verified = component.verified;
	const manifest = verified.manifest;
	const productId = resourceClass.productId;

	const prepare = (request: ResolveRequest): WitResolveRequest => {
		const parsed = parseResolveRequest(requestJson(request));
		if (parsed.ref.productId !== productId)
			throw new ResolverComponentError(
				"component.guest-unsupported",
				`request for ${parsed.ref.productId} routed to ${productId}`,
				manifest.id,
				productId,
			);
		return {
			ref: {
				slot: parsed.ref.slot,
				productId: parsed.ref.productId,
				logicalId: parsed.ref.logicalId,
				physicalId: parsed.ref.physicalId ?? null,
			},
			desiredJson: canonicalJson(parsed.desired),
			observedJson: parsed.observed === undefined ? null : canonicalJson(parsed.observed),
			credentialRef: parsed.credentialRef,
		};
	};

	const call = async <T>(
		operation: "reconcile" | "read" | "delete",
		request: WitResolveRequest,
		transport: HttpTransport,
		liftOk: (value: JsonValue | undefined) => T,
	): Promise<T> => {
		const raw = await component.invoke(operation, lower(request), {
			productId,
			transport,
			credentialRef: request.credentialRef,
		});
		return unwrap(liftOrRefuse(raw, liftOk, operation), operation);
	};

	const unwrap = <T>(result: WitResult<T>, operation: string): T => {
		if ("ok" in result) return result.ok;
		throw new ResolverComponentError(
			result.err.tag === "rejected" ? "component.guest-rejected" : "component.guest-unsupported",
			`${operation}: ${result.err.val}`,
			manifest.id,
			productId,
		);
	};

	const liftOrRefuse = <T>(
		raw: JsonValue,
		liftOk: (value: JsonValue | undefined) => T,
		operation: string,
	): WitResult<T> => {
		try {
			return liftResult(raw, liftOk);
		} catch (error) {
			throw new ResolverComponentError(
				"component.output-unparseable",
				`${operation}: ${error instanceof AbiError ? error.message : "value outside the WIT contract"}`,
				manifest.id,
				productId,
			);
		}
	};

	const toOutcome = (outcome: WitResolveOutcome): ResolveOutcome => {
		let outputs: JsonValue;
		try {
			outputs = parseJsonText(outcome.outputsJson);
		} catch {
			throw new ResolverComponentError(
				"component.output-unparseable",
				"outputs-json is not JSON",
				manifest.id,
				productId,
			);
		}
		return parseResolveOutcome({
			contract: RESOLVER_CONTRACT,
			action: outcome.action,
			physicalId: outcome.physicalId,
			outputs,
			diagnostics: [...outcome.diagnostics],
		});
	};

	const resolver: ComponentResourceResolver = {
		providerId: manifest.providerId,
		productId,
		...(resourceClass.directives.length > 0 ? { directives: resourceClass.directives } : undefined),
		component: Object.freeze({
			id: manifest.id,
			version: manifest.version,
			wasmDigest: verified.wasmDigest,
			manifestDigest: verified.manifestDigest,
			signedBy: verified.signedBy,
		}),
		resourceClass,
		async reconcile(request, transport) {
			return toOutcome(await call("reconcile", prepare(request), transport, liftOutcome));
		},
		async delete(request, transport) {
			await call("delete", prepare(request), transport, liftNull);
		},
		async read(request, transport) {
			const result = await call("read", prepare(request), transport, liftReadResult);
			return result === null ? undefined : toOutcome(result.outcome);
		},
		async observe(request, transport, observeFields) {
			const wit = prepare(request);
			const result = await call("read", wit, transport, liftReadResult);
			if (result === null) return undefined;
			const outcome = toOutcome(result.outcome);
			return observation({
				request: parseResolveRequest(requestJson(request)),
				outcome,
				attributes: result.attributes,
				resourceClass,
				observeFields,
			});
		},
		async instances(transport, credentialRef) {
			const raw = await component.invoke(
				"instances",
				lower({ productId, credentialRef }),
				{ productId, transport, credentialRef },
			);
			return unwrap(liftOrRefuse(raw, liftInstances, "instances"), "instances");
		},
	};
	return Object.freeze(resolver);
}

interface ObservationInput {
	readonly request: ResolveRequest;
	readonly outcome: ResolveOutcome;
	readonly attributes: readonly (readonly [string, string])[];
	readonly resourceClass: ComponentResourceClass;
	readonly observeFields: readonly string[];
}

/**
 * Build the observation entry: attributes trimmed to the declared fields and
 * bounded, retained fields listed, drift computed with retained fields and
 * directives excluded.
 */
export function observation(input: ObservationInput): ResourceObservation {
	const declared = new Set(input.resourceClass.observeFields);
	const wanted = [...new Set(input.observeFields)].filter((field) => declared.has(field));
	const attributes: Record<string, string> = {};
	let bytes = 0;
	for (const [name, value] of [...input.attributes].sort((left, right) => compare(left[0], right[0]))) {
		if (!wanted.includes(name) || CREDENTIAL_FIELD_PATTERN.test(name)) continue;
		const size = Buffer.byteLength(name) + Buffer.byteLength(value);
		if (bytes + size > MAX_ATTRIBUTE_BYTES) continue;
		bytes += size;
		attributes[name] = value;
	}
	const retained = input.resourceClass.retainedFields;
	const drifted = driftedFields(
		input.request.desired,
		input.outcome.outputs,
		new Set([...retained, ...input.resourceClass.directives]),
	);
	return create(ResourceObservationSchema, {
		resource: input.request.ref.logicalId,
		physicalId: input.outcome.physicalId,
		outputsHash: `sha256:${createHash("sha256").update(canonicalJson(input.outcome.outputs)).digest("hex")}`,
		healthy: true,
		driftKind: drifted.length === 0 ? "" : `modified:${drifted.join(",")}`,
		kind: input.resourceClass.productId,
		classification: "",
		attributes,
		retained: [...retained],
	});
}

/**
 * Top-level desired keys whose observed value differs, minus `excluded`.
 * A key the component did not report is not drift here (the read may not
 * surface it); the reconciler's in-tree comparison covers the plan.
 */
export function driftedFields(
	desired: JsonObject,
	observed: JsonObject,
	excluded: ReadonlySet<string>,
): readonly string[] {
	const fields: string[] = [];
	for (const key of Object.keys(desired).sort(compare)) {
		if (excluded.has(key) || !Object.hasOwn(observed, key)) continue;
		if (canonicalJson(desired[key] ?? null) !== canonicalJson(observed[key] ?? null)) fields.push(key);
	}
	return Object.freeze(fields);
}

function requestJson(request: ResolveRequest): JsonValue {
	const ref: JsonObject = {
		slot: request.ref.slot,
		productId: request.ref.productId,
		logicalId: request.ref.logicalId,
		...(request.ref.physicalId === undefined ? undefined : { physicalId: request.ref.physicalId }),
	};
	const out: JsonObject = {
		ref,
		desired: isJsonObject(request.desired) ? request.desired : {},
		...(request.observed === undefined ? undefined : { observed: request.observed }),
		credentialRef: request.credentialRef,
	};
	return out;
}
