import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventEnvelope } from "@hobo/core";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";

import {
	type JsonValue,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "../src/json.js";

export function freshStore(): RuntimeLocalEventStore {
	const dir = mkdtempSync(join(tmpdir(), "hobo-data-"));
	return createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
}

export interface OrderState {
	placed: boolean;
	totalCents: number;
}

export interface OrderCommand {
	id: string;
	totalCents: number;
}

export interface OrderPlacedData {
	orderId: string;
	totalCents: number;
}

export interface OrderRow {
	orderId: string;
	status: string;
	totalCents: number;
}

function inspectEventData(data: EventEnvelope["data"]): JsonValue {
	const serialized = JSON.stringify(data);
	if (serialized === undefined)
		throw new TypeError("order event data must be JSON");
	const parsed: JsonValue = JSON.parse(serialized);
	return parsed;
}

export function parseOrderId(data: EventEnvelope["data"]): string {
	const inspectable = inspectEventData(data);
	if (!isJsonObject(inspectable) || !isJsonString(inspectable.orderId)) {
		throw new TypeError("order event data must include orderId:string");
	}
	return inspectable.orderId;
}

export function parseOrderPlacedData(
	data: EventEnvelope["data"],
): OrderPlacedData {
	const inspectable = inspectEventData(data);
	if (!isJsonObject(inspectable)) {
		throw new TypeError("order event data must be an object");
	}
	const orderId = inspectable.orderId;
	const totalCents = inspectable.totalCents;
	if (!isJsonString(orderId) || !isJsonNumber(totalCents)) {
		throw new TypeError(
			"order.Placed data must have orderId:string and totalCents:number",
		);
	}
	return { orderId, totalCents };
}

export function parseTotalCents(data: EventEnvelope["data"]): number {
	const inspectable = inspectEventData(data);
	if (!isJsonObject(inspectable) || !isJsonNumber(inspectable.totalCents)) {
		throw new TypeError("order event data must include totalCents:number");
	}
	return inspectable.totalCents;
}
