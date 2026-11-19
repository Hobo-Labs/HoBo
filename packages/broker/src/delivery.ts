
import { isJsonString, type JsonObject } from "./json.js";
import type { DeliveryTicket } from "./planes.js";
import { LEGACY_ARGO_PUBLISHER } from "./types.js";

// public-contract: current broker.DeliverySubmitted body schema.
export const DELIVERY_SUBMITTED_SCHEMA =
	"hobo.broker.delivery-submitted/v2" as const;

export function deliverySubmittedBody(input: {
	readonly requestId: string;
	readonly brokerId: string;
	readonly ticket: DeliveryTicket;
}): JsonObject {
	const { ticket } = input;
	return {
		schema: DELIVERY_SUBMITTED_SCHEMA,
		requestId: input.requestId,
		brokerId: input.brokerId,
		reconcilerMode: ticket.reconcilerMode,
		...(ticket.publisher !== undefined
			? { publisher: ticket.publisher }
			: undefined),
		...(ticket.promotionId !== undefined
			? { promotionId: ticket.promotionId }
			: undefined),
		target: ticket.target,
	};
}

function text(body: JsonObject, key: string): string | undefined {
	const value = body[key];
	return isJsonString(value) ? value : undefined;
}

function unknownFact(detail: string): Error {
	return Object.assign(
		new Error(
			`delivery-fact-unknown: ${detail} (remediation: add the shape to the upcaster and its golden corpus before replaying this journal)`,
		),
		{ code: "delivery-fact-unknown" },
	);
}

export function upcastDeliverySubmitted(body: JsonObject): JsonObject {
	const schema = text(body, "schema");
	if (schema === DELIVERY_SUBMITTED_SCHEMA) return { ...body };
	if (schema !== undefined) throw unknownFact(`schema ${schema}`);
	const engine = text(body, "engine");
	const base = {
		schema: DELIVERY_SUBMITTED_SCHEMA,
		requestId: text(body, "requestId") ?? "",
		brokerId: text(body, "brokerId") ?? "",
	};
	const target = text(body, "target") ?? "";
	if (engine === "argo") {
		return {
			...base,
			reconcilerMode: "publisher",
			publisher: LEGACY_ARGO_PUBLISHER,
			target,
		};
	}
	if (engine === "in-proc") {
		return { ...base, reconcilerMode: "conductor", target };
	}
	throw unknownFact(`engine ${engine ?? "(missing)"}`);
}
