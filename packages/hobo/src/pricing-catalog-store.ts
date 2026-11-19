import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import {
	catalogHashOf,
	type PricingCatalog,
	PricingCatalogSchema,
} from "@hobo/pricing";
import { isJsonObject, isJsonString } from "./json.js";

// public-contract: the fact type pinned by PRICING_EVENT_CONTRACTS in @hobo/events.
export const CATALOG_REGISTERED = "pricing.CatalogRegistered";

export type CatalogRegisteredBody = {
	readonly eventId: string;
	readonly occurredAt: string;
	readonly providerId: string;
	readonly catalogHash: string;
	readonly catalogJson: string;
};

type StreamEvent = Pick<EventEnvelope, "type" | "data">;

export type CatalogRegisteredFact = {
	readonly type: typeof CATALOG_REGISTERED;
	readonly data: CatalogRegisteredBody;
};

export function catalogRegisteredFact(
	providerId: string,
	catalog: PricingCatalog,
	occurredAt: string,
): CatalogRegisteredFact {
	return {
		type: CATALOG_REGISTERED,
		data: {
			eventId: `pricing-catalog:${providerId}:${catalog.catalogHash}`,
			occurredAt,
			providerId,
			catalogHash: catalog.catalogHash,
			catalogJson: JSON.stringify(
				toJson(PricingCatalogSchema, catalog, { alwaysEmitImplicit: true }),
			),
		},
	};
}

export type StoredCatalog = {
	readonly providerId: string;
	readonly catalogHash: string;
	readonly occurredAt: string;
};

function isRegistered(
	data: JsonValue,
): data is JsonValue & CatalogRegisteredBody {
	return (
		isJsonObject(data) &&
		isJsonString(data.providerId) &&
		isJsonString(data.catalogHash) &&
		isJsonString(data.catalogJson) &&
		isJsonString(data.occurredAt)
	);
}

function latestFacts(
	events: readonly StreamEvent[],
): ReadonlyMap<string, CatalogRegisteredBody> {
	const latest = new Map<string, CatalogRegisteredBody>();
	for (const event of events) {
		const data = event.data as JsonValue;
		if (event.type === CATALOG_REGISTERED && isRegistered(data)) {
			latest.set(data.providerId, data);
		}
	}
	return latest;
}

export function storedCatalogs(
	events: readonly StreamEvent[],
): ReadonlyMap<string, StoredCatalog> {
	return new Map(
		[...latestFacts(events)].map(([providerId, body]) => [
			providerId,
			{
				providerId,
				catalogHash: body.catalogHash,
				occurredAt: body.occurredAt,
			},
		]),
	);
}

export type CatalogRead =
	| { readonly ok: true; readonly catalog: PricingCatalog }
	| { readonly ok: false; readonly reason: string };

export function readStoredCatalog(
	events: readonly StreamEvent[],
	providerId: string,
): CatalogRead {
	const body = latestFacts(events).get(providerId);
	if (body === undefined) {
		return { ok: false, reason: `no pricing catalog stored for ${providerId}` };
	}
	let catalog: PricingCatalog;
	try {
		catalog = fromJson(
			PricingCatalogSchema,
			JSON.parse(body.catalogJson) as JsonValue,
		);
	} catch (error) {
		return {
			ok: false,
			reason: `stored catalog for ${providerId} does not decode: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (catalogHashOf(catalog) !== body.catalogHash) {
		return {
			ok: false,
			reason: `stored catalog for ${providerId} does not match its recorded hash ${body.catalogHash}`,
		};
	}
	return { ok: true, catalog };
}
