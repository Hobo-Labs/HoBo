import { create, toJson } from "@bufbuild/protobuf";

import {
	OrderAcceptedSchema,
	type OrderRequest,
	OrderRequestSchema,
	ProductListSchema,
	ProductSchema,
} from "./_generated/shop_pb.js";

/** The in-memory product catalog the shop API serves. */
const catalog = create(ProductListSchema, {
	products: [
		create(ProductSchema, {
			sku: "mug-01",
			name: "HoBo camp mug",
			priceCents: 1400,
		}),
		create(ProductSchema, {
			sku: "tee-02",
			name: "HoBo bindle tee",
			priceCents: 2200,
		}),
	],
});

/**
 * The single parse boundary: untrusted request JSON → a derived
 * {@link OrderRequest} message generated from `data-models/shop.proto`
 * (parse, don't validate). Downstream code never re-checks raw fields — it
 * either holds a parsed `OrderRequest` or the boundary refused with a
 * `TypeError`.
 */
type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

function isJsonObject(value: JsonValue): value is JsonObject {
	return (
		value !== null &&
		!Array.isArray(value) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

function isJsonString(value: JsonValue | undefined): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

function isJsonNumber(value: JsonValue | undefined): value is number {
	return Object.prototype.toString.call(value) === "[object Number]";
}

export function parseOrderRequest(raw: JsonValue): OrderRequest {
	if (!isJsonObject(raw)) {
		throw new TypeError("order body must be a JSON object");
	}
	const sku = raw.sku;
	const quantity = raw.quantity;
	if (!isJsonString(sku) || sku.trim().length === 0) {
		throw new TypeError("order sku must be a non-empty string");
	}
	if (!isJsonNumber(quantity) || !Number.isInteger(quantity) || quantity < 1) {
		throw new TypeError("order quantity must be a positive integer");
	}
	return create(OrderRequestSchema, { sku: sku.trim(), quantity });
}

let orderCounter = 0;

/**
 * The shop API: a plain fetch handler (no framework) exposing
 * `GET /products` and `POST /orders`.
 */
export async function shopApi(request: Request): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/products") {
		return Response.json(toJson(ProductListSchema, catalog));
	}

	if (request.method === "POST" && url.pathname === "/orders") {
		let order: OrderRequest;
		try {
			const body = await request.json();
			// SAFETY: request JSON is untyped; parseOrderRequest is the boundary.
			order = parseOrderRequest(body as JsonValue);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ error: message }, { status: 400 });
		}
		orderCounter += 1;
		const accepted = create(OrderAcceptedSchema, {
			orderId: `order-${orderCounter}`,
			sku: order.sku,
			quantity: order.quantity,
		});
		return Response.json(toJson(OrderAcceptedSchema, accepted), {
			status: 202,
		});
	}

	return Response.json({ error: "not found" }, { status: 404 });
}
