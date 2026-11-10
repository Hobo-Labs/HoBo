/**
 * Manifest -> `@hobo/core` `CapabilityManifest`: the same four well-known
 * documents hand-written provider packages publish, so a data-only provider
 * registers through the path a coded one does.
 */
import {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	type CapabilityManifest,
	COST_SCHEMA,
	canonicalJson,
	type JsonObject,
	type JsonValue,
	MANIFEST_INDEX_SCHEMA,
	MANIFEST_PATHS,
	MANIFEST_SCHEMA,
	stableDigest,
} from "@hobo/core";
import { formatDecimal, parseDecimal } from "@hobo/pricing";
import type {
	BillingSection,
	CapabilityMapping,
} from "./_generated/provider_manifest_pb.js";
import {
	authMdTargets,
	type ResolvedAuthFlow,
	resolveAuthFlows,
} from "./auth.js";
import { pricingProductRef } from "./billing.js";
import { type ParsedProviderManifest, perUnitPrice } from "./parse.js";

/** A document under construction: known fields first, optional ones added. */
type Draft = Map<string, JsonValue>;

function draftOf(known: JsonObject): Draft {
	return new Map(Object.entries(known));
}

/** Omit rather than publish an empty string for an undeclared field. */
function setIfDeclared(draft: Draft, key: string, value: string): void {
	if (value !== "") draft.set(key, value);
}

function flowDocument(resolved: ResolvedAuthFlow): JsonObject {
	const draft = draftOf({
		id: resolved.id,
		type: resolved.type,
		scopes: [...resolved.scopes],
		supported: resolved.supported,
	});
	const variant = resolved.flow.flow;
	switch (variant.case) {
		case "oauth2": {
			const flow = variant.value;
			draft.set("grant", flow.grant);
			setIfDeclared(draft, "authorizationEndpoint", flow.authorizationEndpoint);
			setIfDeclared(draft, "tokenEndpoint", flow.tokenEndpoint);
			setIfDeclared(
				draft,
				"deviceAuthorizationEndpoint",
				flow.deviceAuthorizationEndpoint,
			);
			setIfDeclared(draft, "metadataUrl", flow.metadataUrl);
			if (flow.grant === "authorization-code") draft.set("pkce", "S256");
			setIfDeclared(draft, "audience", flow.audience);
			setIfDeclared(draft, "clientRegistration", flow.clientRegistration);
			setIfDeclared(draft, "registrationEndpoint", flow.registrationEndpoint);
			break;
		}
		case "authMd": {
			const targets = authMdTargets(variant.value);
			draft.set("resource", targets.resource);
			draft.set(
				"protectedResourceMetadataUrl",
				targets.protectedResourceMetadataUrl,
			);
			draft.set("authMdUrl", targets.authMdUrl);
			draft.set("anonymousRegistration", variant.value.anonymousRegistration);
			draft.set("humanClaim", variant.value.humanClaim);
			break;
		}
		case "oidcFederation":
			draft.set("audience", variant.value.audience);
			setIfDeclared(draft, "exchange", variant.value.exchange);
			break;
		case "apiKey":
			draft.set("header", variant.value.header);
			setIfDeclared(draft, "prefix", variant.value.prefix);
			draft.set(
				"rotation",
				variant.value.rotation === "" ? "manual" : variant.value.rotation,
			);
			break;
		case "extension":
			draft.set("params", { ...variant.value.params });
			break;
		default:
			break;
	}
	return Object.fromEntries(draft);
}

/** `auth.json`. Flows are listed most-preferred first. */
export function toAuthDocument(manifest: ParsedProviderManifest): JsonObject {
	const flows = resolveAuthFlows(manifest);
	const auth = manifest.auth;
	const draft = draftOf({
		schema: AUTH_SCHEMA,
		providerId: manifest.provider?.id ?? "",
		issuer: auth?.issuer ?? "",
		flows: flows.map(flowDocument),
		scopeModel: "least-privilege-per-resource",
		resourceIndicators: [...(auth?.resourceIndicators ?? [])],
		// True only when no brokerable keyless flow exists, i.e. using this
		// provider means storing a long-lived secret.
		staticSecrets: !flows.some((flow) => flow.supported && !flow.staticSecret),
	});
	if (auth !== undefined && auth.tokenLifetimeSec !== 0) {
		draft.set("tokenLifetimeSec", auth.tokenLifetimeSec);
	}
	return Object.fromEntries(draft);
}

function mappingRegions(
	manifest: ParsedProviderManifest,
	mapping: CapabilityMapping,
): string[] {
	return mapping.regions.length > 0
		? [...mapping.regions]
		: [...(manifest.capabilities?.regions ?? [])];
}

/** `capabilities.json`, in the shape the registry catalog folds. */
export function toCapabilitiesDocument(
	manifest: ParsedProviderManifest,
): JsonObject {
	const providerId = manifest.provider?.id ?? "";
	const mappings = manifest.capabilities?.mappings ?? [];
	const resourceClass = (mapping: CapabilityMapping) =>
		mapping.resourceClass === "" ? mapping.id : mapping.resourceClass;
	return {
		schema: CAPABILITIES_SCHEMA,
		providerId,
		equivalenceClasses: mappings.map((mapping) => ({
			class: mapping.id,
			port: mapping.port,
			resourceClass: resourceClass(mapping),
			providerService: mapping.providerService,
			features: [...mapping.features],
		})),
		capabilities: mappings.map((mapping) => {
			const draft = draftOf({
				port: mapping.port,
				interface: `hobo:${mapping.port}/${resourceClass(mapping)}`,
				version: mapping.version === "" ? "0.1.0" : mapping.version,
				stability: mapping.stability === "" ? "preview" : mapping.stability,
				features: [...mapping.features],
				regions: mappingRegions(manifest, mapping),
				resourceClass: resourceClass(mapping),
				providerService: mapping.providerService,
				profiles: [...mapping.profiles],
			});
			const product = mapping.products[0];
			if (product !== undefined) {
				draft.set("productId", pricingProductRef(providerId, product));
			}
			return Object.fromEntries(draft);
		}),
	};
}

type MarginalPrice = { readonly unit: string; readonly marginalPrice: string };

/**
 * The single list price the legacy `ResourceDefinition.cost` ranking reads:
 * the product's first plan, when that plan is exactly one unconditional
 * metered charge at a flat per-unit rate. Anything richer is "unknown" — the
 * full model lives in the pricing catalog, and unknown ranks last, not free.
 */
function marginalPrice(
	billing: BillingSection,
	productId: string,
): MarginalPrice | undefined {
	const plan = billing.products.find((product) => product.id === productId)
		?.plans[0];
	if (plan === undefined || plan.charges.length !== 1) return undefined;
	const model = plan.charges[0]?.model;
	if (model?.case !== "metered") return undefined;
	if (Object.keys(plan.charges[0]?.when ?? {}).length > 0) return undefined;
	const unit = billing.billables.find(
		(billable) => billable.id === model.value.billable,
	)?.unit;
	if (unit === undefined) return undefined;
	const rate = model.value.rate;
	if (rate.case === "unitPrice") return { unit, marginalPrice: rate.value };
	if (rate.case === "package" && !rate.value.whole) {
		const amount = parseDecimal(rate.value.amount);
		const per = parseDecimal(rate.value.per);
		const price =
			amount === undefined || per === undefined
				? undefined
				: perUnitPrice(amount, per);
		if (price !== undefined)
			return { unit, marginalPrice: formatDecimal(price) };
	}
	return undefined;
}

/** `cost.json`: one ranking fact per capability mapping that names a product. */
export function toCostDocument(manifest: ParsedProviderManifest): JsonObject {
	const providerId = manifest.provider?.id ?? "";
	const billing = manifest.billing;
	const facts: JsonObject[] = [];
	if (billing !== undefined) {
		for (const mapping of manifest.capabilities?.mappings ?? []) {
			const productId = mapping.products[0];
			if (productId === undefined) continue;
			const price = marginalPrice(billing, productId);
			facts.push({
				port: mapping.port,
				sku: pricingProductRef(providerId, productId),
				unit: price?.unit ?? "",
				marginalPrice: price?.marginalPrice ?? "0",
				pricingStatus: price === undefined ? "unknown" : "estimate",
				source: {
					type: "declared-provider",
					url: billing.source?.url ?? "",
					transcribedOn: billing.source?.checkedAt ?? "",
				},
			});
		}
	}
	const draft = draftOf({ schema: COST_SCHEMA, providerId, facts });
	if (billing !== undefined) draft.set("currency", billing.currency);
	return Object.fromEntries(draft);
}

/** The published bundle plus its parsed documents, as `CloudProvider` returns. */
export function toCapabilityManifest(
	manifest: ParsedProviderManifest,
): CapabilityManifest {
	const providerId = manifest.provider?.id ?? "";
	const capabilities = toCapabilitiesDocument(manifest);
	const auth = toAuthDocument(manifest);
	const cost = toCostDocument(manifest);
	const index = {
		schema: MANIFEST_INDEX_SCHEMA,
		providerId,
		manifestSchema: MANIFEST_SCHEMA,
		documents: [
			{
				path: MANIFEST_PATHS.capabilities,
				schema: CAPABILITIES_SCHEMA,
				digest: stableDigest(capabilities),
			},
			{
				path: MANIFEST_PATHS.auth,
				schema: AUTH_SCHEMA,
				digest: stableDigest(auth),
			},
			{
				path: MANIFEST_PATHS.cost,
				schema: COST_SCHEMA,
				digest: stableDigest(cost),
			},
		],
	};
	return {
		providerId,
		published: {
			[MANIFEST_PATHS.index]: canonicalJson(index),
			[MANIFEST_PATHS.capabilities]: canonicalJson(capabilities),
			[MANIFEST_PATHS.auth]: canonicalJson(auth),
			[MANIFEST_PATHS.cost]: canonicalJson(cost),
		},
		capabilities,
		auth,
		cost,
	};
}
