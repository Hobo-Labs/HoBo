/** Canonical terminal receipt for a receiver-enforced native fence operation. */
import {
	canonicalEncode,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "./json.js";
import type { FenceOperationReceipt } from "./spi.js";

export function canonicalFenceOperationReceipt(
	input: Omit<FenceOperationReceipt, "signature">,
): string {
	const text = (value: string | undefined, allowEmpty = false) =>
		isJsonString(value) &&
		(allowEmpty || value.length > 0) &&
		value.length <= 512 &&
		value === value.trim() &&
		!/\p{Cc}/u.test(value);
	const exactKeys = (value: JsonObject, keys: readonly string[]) =>
		Reflect.ownKeys(value).length === keys.length &&
		keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable === true && "value" in descriptor;
		});
	if (
		!isJsonObject(input) ||
		!exactKeys(input, [
			"scope",
			"operationId",
			"routeDigest",
			"receiverKeyId",
			"fenceTokenDigest",
			"contract",
			"outcome",
		]) ||
		!isJsonObject(input.scope) ||
		!exactKeys(input.scope, ["dataset", "tenant"]) ||
		input.contract !== "hobo.fence-operation-receipt/v1" ||
		input.outcome !== "committed" ||
		!text(input.scope?.dataset) ||
		!text(input.scope?.tenant, true) ||
		!text(input.operationId) ||
		!text(input.receiverKeyId) ||
		!isJsonString(input.routeDigest) ||
		input.routeDigest.length !== 71 ||
		!/^sha256:[a-f0-9]{64}$/u.test(input.routeDigest) ||
		!isJsonString(input.fenceTokenDigest) ||
		input.fenceTokenDigest.length !== 71 ||
		!/^sha256:[a-f0-9]{64}$/u.test(input.fenceTokenDigest)
	)
		throw new TypeError("invalid native fence operation receipt");
	return canonicalEncode({
		contract: input.contract,
		scope: { dataset: input.scope.dataset, tenant: input.scope.tenant },
		operationId: input.operationId,
		routeDigest: input.routeDigest,
		receiverKeyId: input.receiverKeyId,
		fenceTokenDigest: input.fenceTokenDigest,
		outcome: input.outcome,
	});
}
