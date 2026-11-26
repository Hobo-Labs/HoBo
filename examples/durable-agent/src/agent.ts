import { create } from "@bufbuild/protobuf";
import { agent, tokenCapability } from "@hobo/runtime";

import {
	type OrderCommand,
	OrderCommandSchema,
	type OrderReceipt,
	OrderReceiptSchema,
} from "./_generated/agent_run_pb.js";

/** The broker provider/scope the agent is granted (`token:acme-cloud`). */
export const TOKEN_PROVIDER = "acme-cloud";
export const TOKEN_SCOPE = "database:write";

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

/**
 * The single parse boundary: untrusted input → a derived {@link OrderCommand}
 * message generated from `data-models/agent_run.proto` (parse, don't
 * validate). The agent body only ever sees a parsed command.
 */
export function parseOrderCommand(raw: JsonValue): OrderCommand {
	if (!isJsonObject(raw)) {
		throw new TypeError("order command must be a JSON object");
	}
	const orderId = raw.orderId;
	if (!isJsonString(orderId) || orderId.trim().length === 0) {
		throw new TypeError("order command orderId must be a non-empty string");
	}
	return create(OrderCommandSchema, { orderId: orderId.trim() });
}

type WriteOrderResult = JsonObject & {
	readonly ok: true;
	readonly orderId: string;
	readonly tokenRef: string;
};

interface WriteOrderInput {
	readonly orderId: string;
	readonly tokenRef: string;
}

function parseWriteOrderInput(raw: JsonValue): WriteOrderInput {
	if (!isJsonObject(raw)) {
		throw new TypeError("writeOrder input must be a JSON object");
	}
	const { orderId, tokenRef } = raw;
	if (!isJsonString(orderId) || !isJsonString(tokenRef)) {
		throw new TypeError("writeOrder input requires string orderId and tokenRef");
	}
	return { orderId, tokenRef };
}

function parseWriteOrderResult(raw: JsonValue): WriteOrderResult {
	if (!isJsonObject(raw)) {
		throw new TypeError("writeOrder result must be a JSON object");
	}
	const { ok, orderId, tokenRef } = raw;
	if (ok !== true || !isJsonString(orderId) || !isJsonString(tokenRef)) {
		throw new TypeError("writeOrder result has an invalid shape");
	}
	return { ok, orderId, tokenRef };
}

/**
 * A durable ops agent (`@hobo/runtime`'s `agent()`): it mints a brokered
 * credential through the deny-by-default capability membrane, writes the order
 * via its one declared tool (a journaled step), emits an `order.Written`
 * event, and returns a derived {@link OrderReceipt}. Undeclared tools or
 * token providers are refused with a typed `CapabilityDeniedError`.
 */
export const opsAgent = agent<OrderCommand, OrderReceipt>({
	name: "ops",
	tools: [
		{
			name: "writeOrder",
			run(input) {
				const { orderId, tokenRef } = parseWriteOrderInput(input);
				return { ok: true, orderId, tokenRef } satisfies WriteOrderResult;
			},
		},
	],
	capabilities: [tokenCapability(TOKEN_PROVIDER)],
	async run(ctx, command) {
		// Journaled as a step so the minted handle is replayed, never re-minted.
		const token = await ctx.step("mint-broker-token", () =>
			ctx.token({ provider: TOKEN_PROVIDER, scope: TOKEN_SCOPE }),
		);
		const written = parseWriteOrderResult(
			await ctx.tool("writeOrder", {
				orderId: command.orderId,
				tokenRef: token.ref,
			}),
		);
		await ctx.emit("order.Written", written);
		return create(OrderReceiptSchema, {
			orderId: written.orderId,
			tokenRef: written.tokenRef,
		});
	},
});
